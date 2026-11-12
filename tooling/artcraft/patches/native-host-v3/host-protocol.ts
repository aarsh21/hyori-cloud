import {
  NATIVE_HOST_PROTOCOL,
  NATIVE_MAX_BYTES,
  decodeNativeHostCommand,
  decodeNativeHostEvent,
  type NativeHostCommand,
  type NativeHostEvent,
  type NativeSnapshotIdentity,
  type NativeTheme,
  type NativeErrorCode,
} from "@hyori-cloud/client-sdk/editor-runtime";

export { NATIVE_HOST_PROTOCOL, NATIVE_MAX_BYTES } from "@hyori-cloud/client-sdk/editor-runtime";

type OpenRequest = Extract<NativeHostCommand, { type: `${string}:open` }>;

type SaveRequest = Extract<NativeHostCommand, { type: `${string}:request-save` }>;

type SaveAck = Extract<NativeHostCommand, { type: `${string}:save-result` }>;

type CancelIntent = Extract<NativeHostCommand, { type: `${string}:cancel-intent` }>;

type SaveIntent = Extract<NativeHostEvent, { type: `${string}:save-requested` }>;

type SaveFailure = Exclude<SaveAck, { status: "saved" | "discarded" }>;

type SaveDiscard = Extract<SaveAck, { status: "discarded" }>;

type ThemeRequest = Extract<NativeHostCommand, { type: `${string}:set-theme` }>;

type SaveOutput = Extract<NativeHostEvent, { type: `${string}:save` }>;

type SavedOutput = Extract<NativeHostEvent, { type: `${string}:saved` }>;

type Operation = NativeHostEvent["type"] extends `${string}:${infer Suffix}` ? Suffix : never;

type Payload<Event> = Event extends NativeHostEvent
  ? Omit<Event, "type" | "protocol" | "version">
  : never;

export interface NativeHostPorts {
  app: "wordcraft" | "gridcraft" | "pdfcraft" | "deckcraft";
  version: string;
  origin: string;
  parent: object;
  replacementExtensions: readonly string[];
  post(message: NativeHostEvent, origin: string): void;
  repaint(): void;
}

interface PendingSnapshot {
  message: SaveOutput;
  acknowledged: boolean;
  intentId: string | undefined;
  continuationCancelled: boolean;
}

/** Transport state only. Wire schemas/types have one owner: the public SDK editor-runtime.
 * Actual parsing, draft settling/guards, serialization and theme application belong to Rust. */
export function createNativeHostProtocol(ports: NativeHostPorts) {
  if (new URL(ports.origin).origin !== ports.origin || !/^https?:/.test(ports.origin))
    throw new Error("Native host requires exact HTTP(S) origin");

  let ready = false;
  let opening: OpenRequest | null = null;
  let openTaken = false;

  let active: {
    source: Omit<OpenRequest, "bytes">;
    documentId: string;
    revision: string;
    dirty: boolean;
    detached: boolean;
  } | null = null;

  let request: SaveRequest | null = null;
  let requestTaken = false;
  let pending: PendingSnapshot | null = null;
  let ack: SaveAck | null = null;
  let lastSaved: Payload<SavedOutput> | null = null;
  let intent: SaveIntent | null = null;
  let cancellation: CancelIntent | null = null;
  let failure: (SaveFailure & { intentId: string | undefined }) | null = null;
  let discard: (SaveDiscard & { intentId: string | undefined }) | null = null;
  let themeRequest: ThemeRequest | null = null;
  let themeTaken = false;
  let saveSequence = 0;

  function send(operation: Operation, payload: Payload<NativeHostEvent>) {
    const message = decodeNativeHostEvent({
      ...payload,
      type: `${ports.app}:${operation}`,
      protocol: NATIVE_HOST_PROTOCOL,
      version: ports.version,
    });

    if (!message) throw new Error(`Invalid native event envelope: ${operation}`);
    ports.post(message, ports.origin);
  }

  function error(
    code: NativeErrorCode,
    operation: "open" | "save" | "theme",
    message: string,
    requestId?: string,
  ) {
    send("error", { code, operation, message: message.slice(0, 2048) || code, requestId });
  }

  function resend() {
    if (!pending) return;
    // Retain an independent recovery copy. A recipient cannot detach/mutate it.
    const message = { ...pending.message, bytes: new Uint8Array(pending.message.bytes) };
    const validated = decodeNativeHostEvent(message);

    if (!validated) throw new Error("Retained native snapshot violates the canonical event schema");
    ports.post(validated, ports.origin);
  }

  function sameSnapshot(left: NativeSnapshotIdentity, right: NativeSnapshotIdentity) {
    return (
      left.openId === right.openId &&
      left.documentId === right.documentId &&
      left.revision === right.revision &&
      left.requestId === right.requestId &&
      left.saveId === right.saveId
    );
  }

  function extension(name: string) {
    const dot = name.lastIndexOf(".");

    return dot >= 0 ? name.slice(dot).toLowerCase() : "";
  }

  function acceptOpen(input: OpenRequest) {
    if (opening || active || pending)
      return error("busy", "open", "Reopen requires a fresh native session");
    opening = { ...input, bytes: new Uint8Array(input.bytes) };
    openTaken = false;
    ports.repaint();
  }

  function acceptSave(input: SaveRequest) {
    if (
      !active ||
      input.openId !== active.source.openId ||
      input.documentId !== active.documentId ||
      (active.detached && !input.saveAs)
    )
      return error(
        "identity-changed",
        "save",
        "Native document no longer matches the host source",
        input.requestId,
      );
    const name = input.saveAs ? input.name! : active.source.replacementName;

    if (pending) {
      if (
        pending.message.requestId === input.requestId &&
        pending.message.name === name &&
        pending.message.saveAs === (input.saveAs === true) &&
        pending.intentId === input.intentId
      )
        resend();
      else
        error(
          "busy",
          "save",
          "An immutable save snapshot is awaiting durable acknowledgement",
          input.requestId,
        );

      return;
    }

    if (request) {
      if (request.requestId !== input.requestId)
        error("busy", "save", "Native serialization is already queued", input.requestId);

      return;
    }

    if (
      input.intentId !== undefined &&
      (!intent ||
        intent.intentId !== input.intentId ||
        intent.openId !== input.openId ||
        intent.documentId !== input.documentId ||
        intent.saveAs !== (input.saveAs === true) ||
        (intent.saveAs && extension(intent.name!) !== extension(name!)))
    )
      return error(
        "identity-changed",
        "save",
        "Native save intent was cancelled or no longer matches this output",
        input.requestId,
      );

    if (
      !input.saveAs &&
      (!active.source.writable || !name || !ports.replacementExtensions.includes(extension(name)))
    )
      return error(
        "serialization-failed",
        "save",
        "This document cannot be automatically replaced in its existing native format",
        input.requestId,
      );

    if (
      !name ||
      !active.source.outputFormats.some(
        (format) =>
          format.extension === extension(name) && (input.saveAs || format.kind === "document"),
      )
    )
      return error(
        "serialization-failed",
        "save",
        "Requested native output format is not authorized",
        input.requestId,
      );
    request = input;
    requestTaken = false;
    ports.repaint();
  }

  function acceptCancellation(input: CancelIntent) {
    const matchesIntent =
      intent?.intentId === input.intentId &&
      intent.openId === input.openId &&
      intent.documentId === input.documentId;

    const matchesPending =
      pending?.intentId === input.intentId &&
      pending.message.openId === input.openId &&
      pending.message.documentId === input.documentId &&
      !pending.continuationCancelled;

    if (!matchesIntent && !matchesPending) return;

    if (matchesIntent) intent = null;

    if (matchesPending && pending) pending.continuationCancelled = true;

    if (request?.intentId === input.intentId) request = null;
    cancellation = input;
    ports.repaint();
  }

  function acceptAck(input: SaveAck) {
    if (!pending) {
      if (input.status === "saved" && lastSaved && sameSnapshot(input, lastSaved))
        send("saved", {
          ...lastSaved,
          currentRevision: active?.revision ?? lastSaved.currentRevision,
          dirty: !active || active.detached || active.documentId !== input.documentId || active.dirty,
        });

      return;
    }

    if (!sameSnapshot(input, pending.message)) return;

    if (input.status === "discarded") {
      // The host kept these bytes itself. Release them and their job; nothing becomes clean.
      if (pending.acknowledged) return;

      if (intent?.intentId === pending.intentId) intent = null;
      discard = { ...input, intentId: pending.intentId };
      pending = null;
      ports.repaint();

      return;
    }

    if (input.status !== "saved") {
      if (pending.acknowledged) return;
      pending.continuationCancelled = true;

      if (intent?.intentId === pending.intentId) intent = null;
      failure = { ...input, intentId: pending.intentId };
      ports.repaint();
      send("save-paused", {
        requestId: input.requestId,
        openId: input.openId,
        documentId: input.documentId,
        revision: input.revision,
        saveId: input.saveId,
        status: input.status,
        message: input.message,
      });

      return;
    }

    // A confirmation retry must reach Rust without reapplying an already-applied snapshot.
    ack = input;
    pending.acknowledged = true;
    ports.repaint();
  }

  function acceptTheme(input: ThemeRequest) {
    if (themeRequest)
      return error("busy", "theme", "Native theme application is pending", input.requestId);
    themeRequest = input;
    themeTaken = false;
    ports.repaint();
  }

  return {
    ready() {
      if (ready) return;
      send("ready", {
        capabilities: {
          serialize: true,
          parsedOpen: true,
          documentRevision: true,
          durableSaveAck: true,
          theme: true,
        },
        maxBytes: NATIVE_MAX_BYTES,
      });
      ready = true;
    },
    canExport(name: string) {
      return active?.source.outputFormats.some((format) => format.extension === extension(name)) ?? false;
    },
    hasPendingSave() {
      return Boolean(request || pending || intent || cancellation || failure || discard);
    },
    hasRecoverySnapshot() {
      return pending !== null;
    },
    receive(event: { origin: string; source: object | null; data: unknown }) {
      if (!ready || event.origin !== ports.origin || event.source !== ports.parent) return;
      const command = decodeNativeHostCommand(event.data);

      if (
        !command ||
        command.version !== ports.version ||
        !command.type.startsWith(`${ports.app}:`)
      )
        return;

      switch (command.type) {
        case "wordcraft:open":
        case "gridcraft:open":
        case "pdfcraft:open":
        case "deckcraft:open":
          acceptOpen(command);
          break;
        case "wordcraft:request-save":
        case "gridcraft:request-save":
        case "pdfcraft:request-save":
        case "deckcraft:request-save":
          acceptSave(command);
          break;
        case "wordcraft:cancel-intent":
        case "gridcraft:cancel-intent":
        case "pdfcraft:cancel-intent":
        case "deckcraft:cancel-intent":
          acceptCancellation(command);
          break;
        case "wordcraft:save-result":
        case "gridcraft:save-result":
        case "pdfcraft:save-result":
        case "deckcraft:save-result":
          acceptAck(command);
          break;
        case "wordcraft:set-theme":
        case "gridcraft:set-theme":
        case "pdfcraft:set-theme":
        case "deckcraft:set-theme":
          acceptTheme(command);
          break;
        default:
          command satisfies never;
      }
    },
    takeOpen() {
      if (!opening || openTaken) return null;
      openTaken = true;

      // Rust copies these into its own memory; `opening` already owns a private copy.
      return opening;
    },
    opened(openId: string, documentId: string, revision: string) {
      if (!opening || !openTaken || opening.openId !== openId)
        throw new Error("Native open acknowledgement identity mismatch");
      send("opened", { openId, documentId, revision });
      const { bytes: ignored, ...source } = opening;
      void ignored;
      active = { source, documentId, revision, dirty: false, detached: false };
      opening = null;
    },
    failed(message: string) {
      error("serialization-failed", "open", message);
    },
    detached(message: string) {
      if (!active || active.detached) return;
      active.detached = true;
      error("identity-changed", "save", message);
    },
    openFailed(openId: string, message: string) {
      if (!opening || opening.openId !== openId) return;
      opening = null;
      error("serialization-failed", "open", message);
    },
    observe(documentId: string, revision: string, dirty: boolean) {
      if (!active) return;

      const changed =
        active.documentId !== documentId || active.revision !== revision || active.dirty !== dirty;

      if (active.documentId !== documentId) {
        active.detached = true;
        error(
          "identity-changed",
          "save",
          "Native File New/Open detached this editor from its host source",
        );
      }

      if (changed) send("dirty", { openId: active.source.openId, documentId, revision, dirty });
      active.documentId = documentId;
      active.revision = revision;
      active.dirty = dirty;
    },
    saveRequested(documentId: string, saveAs: boolean, name?: string, intentId?: string) {
      if (!active || active.documentId !== documentId || (active.detached && !saveAs)) {
        error(
          "identity-changed",
          "save",
          "Native Save needs an explicit copy or reopened host source",
        );

        return false;
      }

      if (
        intentId !== undefined &&
        (intent || pending || request || cancellation || failure || discard)
      ) {
        error("busy", "save", "Another native save intent is still pending");

        return false;
      }

      const event = decodeNativeHostEvent({
        type: `${ports.app}:save-requested`,
        protocol: NATIVE_HOST_PROTOCOL,
        version: ports.version,
        openId: active.source.openId,
        documentId,
        intentId,
        saveAs,
        name,
      });

      if (
        !event ||
        (event.type !== "wordcraft:save-requested" &&
          event.type !== "gridcraft:save-requested" &&
          event.type !== "pdfcraft:save-requested" &&
          event.type !== "deckcraft:save-requested")
      )
        throw new Error("Native save intent violates the canonical event schema");

      if (intentId !== undefined) intent = event;

      try {
        ports.post(event, ports.origin);
      } catch (cause) {
        if (intentId !== undefined) intent = null;
        throw cause;
      }

      return true;
    },
    takeSaveRequest() {
      if (!request || requestTaken || !active) return null;
      requestTaken = true;

      return {
        requestId: request.requestId,
        openId: request.openId,
        documentId: request.documentId,
        reason: request.reason,
        intentId: request.intentId,
        saveAs: request.saveAs === true,
        name: request.saveAs ? request.name! : active.source.replacementName!,
      };
    },
    serialized(
      input: Pick<SaveOutput, "requestId" | "documentId" | "revision" | "name" | "saveAs"> & {
        bytes: Uint8Array;
      },
    ) {
      if (
        !request ||
        !requestTaken ||
        !active ||
        pending ||
        request.requestId !== input.requestId ||
        request.documentId !== input.documentId ||
        active.documentId !== input.documentId ||
        (active.detached && !request.saveAs)
      )
        throw new Error("Native serialization identity mismatch");
      const name = request.saveAs ? request.name! : active.source.replacementName!;
      const format = active.source.outputFormats.find((format) => format.extension === extension(name));

      if (
        !format ||
        input.name !== name ||
        input.saveAs !== (request.saveAs === true) ||
        input.bytes.byteLength > Math.min(active.source.maxBytes, format.maxBytes ?? NATIVE_MAX_BYTES)
      )
        throw new Error("Native serialization format/size differs from authorized request");

      if (saveSequence >= 0xffffffff) throw new Error("Native save sequence exhausted");
      const saveId = `${active.source.openId}:${saveSequence + 1}`;

      const message: SaveOutput = {
        type: `${ports.app}:save`,
        protocol: NATIVE_HOST_PROTOCOL,
        version: ports.version,
        requestId: input.requestId,
        openId: active.source.openId,
        documentId: input.documentId,
        revision: input.revision,
        saveId,
        name: input.name,
        saveAs: input.saveAs,
        bytes: new Uint8Array(input.bytes),
      };

      if (!decodeNativeHostEvent(message))
        throw new Error("Native serializer output violates canonical event schema");
      saveSequence += 1;
      pending = {
        message,
        acknowledged: false,
        intentId: request.intentId,
        continuationCancelled: false,
      };
      request = null;
      resend();

      return saveId;
    },
    serializationFailed(requestId: string, code: NativeErrorCode, message: string) {
      if (!request || request.requestId !== requestId) return;

      if (request.intentId !== undefined)
        acceptCancellation({
          type: `${ports.app}:cancel-intent`,
          protocol: NATIVE_HOST_PROTOCOL,
          version: ports.version,
          openId: request.openId,
          documentId: request.documentId,
          intentId: request.intentId,
        });
      request = null;
      error(code, "save", message, requestId);
    },
    takeCancellation() {
      const result = cancellation;
      cancellation = null;

      return result;
    },
    takeFailure() {
      const result = failure;
      failure = null;

      return result;
    },
    /** Drain with the other fences, before takeAcknowledgement. */
    takeDiscard() {
      const result = discard;
      discard = null;

      return result;
    },
    takeAcknowledgement() {
      // Rust must fence jobs before it applies a same-channel positive acknowledgement.
      if (!ack || !pending || cancellation || failure || discard) return null;

      const result = {
        ...ack,
        name: pending.message.name,
        saveAs: pending.message.saveAs,
        intentId: pending.intentId,
        continuationCancelled: pending.continuationCancelled,
      };

      ack = null;

      return result;
    },
    acknowledged(
      beforeDocumentId: string | null,
      beforeRevision: string,
      currentDocumentId: string | null,
      currentRevision: string,
      dirty: boolean,
    ) {
      if (!pending?.acknowledged || ack || cancellation || failure || discard)
        throw new Error("No consumed and fenced durable native acknowledgement");
      const message = pending.message;

      const changed =
        beforeDocumentId !== message.documentId ||
        beforeRevision !== message.revision ||
        currentDocumentId !== message.documentId;

      if (changed && !dirty) throw new Error("A different native snapshot cannot be marked clean");
      lastSaved = {
        requestId: message.requestId,
        openId: message.openId,
        documentId: message.documentId,
        revision: message.revision,
        saveId: message.saveId,
        currentRevision,
        dirty,
      };
      send("saved", lastSaved);

      if (active && active.documentId === currentDocumentId) {
        active.revision = currentRevision;
        active.dirty = dirty;
      }

      if (intent?.intentId === pending.intentId) intent = null;
      pending = null;
    },
    takeThemeRequest() {
      if (!themeRequest || themeTaken) return null;
      themeTaken = true;

      return { requestId: themeRequest.requestId, theme: themeRequest.theme };
    },
    themeApplied(requestId: string, applied: NativeTheme, resolvedTheme: "light" | "dark") {
      if (
        !themeRequest ||
        !themeTaken ||
        themeRequest.requestId !== requestId ||
        themeRequest.theme !== applied
      )
        throw new Error("Native theme application identity mismatch");
      send("theme-applied", { requestId, theme: applied, resolvedTheme });
      themeRequest = null;
    },
    /** A theme the engine refused must not leave every later theme request busy. */
    themeFailed(requestId: string, message: string) {
      if (!themeRequest || themeRequest.requestId !== requestId) return;
      themeRequest = null;
      error("serialization-failed", "theme", message, requestId);
    },
    getRecoverySnapshot() {
      return pending ? { ...pending.message, bytes: new Uint8Array(pending.message.bytes) } : null;
    },
  };
}
