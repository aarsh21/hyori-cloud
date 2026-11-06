import { Schema } from "@hyori-cloud/lib/effect";
import type {
  EditorAutosave,
  EditorDocument,
  EditorOutput,
  EditorSaveResult,
  EditorSession,
  EditorSessionOptions,
  EditorSnapshot,
  EditorStatus,
} from "#client-sdk/features/editors/editor-contract";
import { createAutosaveScheduler } from "#client-sdk/features/editors/create-autosave-scheduler";
import {
  classifyEditorOutput,
  copyEditorBytes,
} from "#client-sdk/features/editors/editor-protocol";
import {
  decodeNativeHostCommand,
  decodeNativeHostEvent,
  NativeTheme,
} from "#client-sdk/features/editors/native-runtime";
import type {
  NativeHostCommand,
  NativeHostEvent,
  NativeSnapshotIdentity,
} from "#client-sdk/features/editors/native-runtime";

type Ready = Extract<NativeHostEvent, { type: `${string}:ready` }>;

type Save = Extract<NativeHostEvent, { type: `${string}:save` }>;

type RequestSave = Extract<NativeHostCommand, { type: `${string}:request-save` }>;

type Copy = Parameters<EditorSession["requestSave"]>[0];

type CancelIntent = Extract<NativeHostCommand, { type: `${string}:cancel-intent` }>;

type Intent = { command: CancelIntent; cancelled: boolean; delivered: boolean };

type Capture = { command: RequestSave; epoch: number; intent?: Intent };

type Pending = {
  identity: NativeSnapshotIdentity;
  output: EditorOutput;
  epoch: number;
  expectedRevision: string;
  mode: RequestSave["reason"];
  intent?: Intent;
  persisted?: Extract<EditorSaveResult, { status: "saved" }>;
};

const MAX_BUSY_ATTEMPTS = 3;

/** Local protocol2 lifecycle. Native serialization and backend persistence each have one owner. */
export function createNativeEditorSession(
  options: EditorSessionOptions,
  descriptor: EditorDocument,
  initialReady?: Ready,
): EditorSession {
  const { backend, messages, readyTimeoutMs = 30_000 } = options;
  const origin = messages.origin;
  const source = messages.source;
  const openId = crypto.randomUUID();
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  let document = descriptor;
  let status: EditorStatus = "opening";
  let message: string | null = null;
  let ready: Ready | null = null;
  let opened = false;
  let openSent = false;
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  let documentId: string | null = null;
  let revision: string | null = null;
  let observedFalseRevision: string | null = null;
  let waitingForNative = false;
  let detached = false;
  let epoch = 0;
  let savedEpoch = 0;
  let lastSavedAt: number | null = null;
  let capture: Capture | null = null;
  let pending: Pending | null = null;
  let persisting = false;
  let queuedFlush: "manual" | "automatic" | null = null;
  let pause: Extract<EditorAutosave, { status: "paused" }>["reason"] | null = null;
  let busyAttempts = 0;
  let theme = options.theme ?? "system";
  let themeRequest: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduler =
    options.autosave === undefined
      ? null
      : createAutosaveScheduler(options.autosave, () => flush("automatic"));

  let snapshot = buildSnapshot();

  function active() {
    return status !== "disposed" && status !== "failed" && status !== "access-ended";
  }

  function autosave(): EditorAutosave {
    if (detached) return { status: "disabled", reason: "copy-required" };

    if (options.autosave === undefined) return { status: "disabled", reason: "not-enabled" };

    if (ready === null) return { status: "disabled", reason: "unsupported" };

    if (!document.writable || status === "read-only")
      return { status: "disabled", reason: "read-only" };

    if (document.replacementName === null) return { status: "disabled", reason: "copy-required" };

    if (pause !== null) return { status: "paused", reason: pause };

    if (waitingForNative) return { status: "waiting", reason: "native-busy" };

    if (capture !== null) return { status: "serializing" };

    if (scheduler?.pending() || queuedFlush !== null) return { status: "scheduled" };

    return { status: "idle" };
  }

  function buildSnapshot(): EditorSnapshot {
    return Object.freeze({
      status,
      document,
      hasUnsavedChanges: epoch > savedEpoch || pending !== null || capture !== null,
      pendingSaveCount: Number(pending !== null),
      lastSavedAt,
      autosave: autosave(),
      message,
    });
  }

  function publish() {
    snapshot = buildSnapshot();

    for (const listener of listeners) listener();
  }

  function cancelIntent(intent: Intent | undefined): boolean {
    if (intent === undefined) return true;
    intent.cancelled = true;

    if (intent.delivered) return true;

    try {
      send(intent.command);
      intent.delivered = true;

      return true;
    } catch {
      return false;
    }
  }

  function cancelContinuations() {
    cancelIntent(capture?.intent);
    cancelIntent(pending?.intent);
  }

  function stop(next: "failed" | "access-ended", reason: string) {
    if (!active()) return;
    cancelContinuations();
    waitingForNative = false;
    status = next;
    message = reason;

    if (next === "access-ended") pause = "access-ended";
    scheduler?.cancel();
    clearTimeout(timer);
    clearTimeout(operationTimer);
    bytes = null;
    capture = null;
    abort.abort();
    publish();
  }

  function serializationFailed(reason: string) {
    clearTimeout(operationTimer);
    cancelIntent(capture?.intent);
    waitingForNative = false;
    capture = null;
    status = document.writable ? "editing" : "read-only";
    pause = "serialization-failed";
    message = reason;
    scheduler?.cancel();
    queuedFlush = null;
    // A failed capture can contain a draft not yet represented by a dirty packet.
    epoch += 1;
    publish();
  }

  function send(command: NativeHostCommand) {
    messages.post(command, origin);
  }

  function setTheme(next: NativeTheme): boolean {
    if (!Schema.is(NativeTheme)(next)) return false;
    theme = next;

    if (!active() || ready === null) return false;
    themeRequest = crypto.randomUUID();

    try {
      send({
        type: `${document.app}:set-theme`,
        protocol: 2,
        version: document.version,
        requestId: themeRequest,
        theme,
      });

      return true;
    } catch {
      themeRequest = null;

      return false;
    }
  }

  function sendOpen() {
    if (!active() || ready === null || bytes === null || openSent) return;

    if (ready.maxBytes < document.maxBytes) {
      stop("failed", "The native editor cannot accept this document's authorized byte limit");

      return;
    }

    openSent = true;
    clearTimeout(timer);
    timer = setTimeout(
      () => stop("failed", "The native editor did not acknowledge parsing the document"),
      readyTimeoutMs,
    );

    try {
      send({
        type: `${document.app}:open`,
        protocol: 2,
        version: document.version,
        openId,
        name: document.name,
        bytes: new Uint8Array(bytes),
        writable: document.writable,
        replacementName: document.replacementName,
        outputFormats: document.outputFormats,
        maxBytes: document.maxBytes,
      });
    } catch {
      stop("failed", "Could not send the document to the native editor");
    }
  }

  function mayReplace() {
    return (
      !detached && document.writable && status !== "read-only" && document.replacementName !== null
    );
  }

  function schedule() {
    if (
      !active() ||
      !opened ||
      !mayReplace() ||
      pause !== null ||
      waitingForNative ||
      epoch <= savedEpoch
    )
      return;
    scheduler?.schedule();
  }

  function flush(reason: "manual" | "automatic", copy?: Copy, intent?: Intent): boolean {
    function reject() {
      cancelIntent(intent);

      return false;
    }

    if (!active() || !opened || documentId === null || ready === null) return reject();

    if (copy === undefined && !mayReplace()) return reject();

    if (intent !== undefined && pause !== null) return reject();

    if (
      status === "conflict" ||
      status === "save-failed" ||
      (pause !== null && pause !== "serialization-failed")
    )
      return reject();

    if (capture !== null || pending !== null || persisting) {
      // Native job/options and SaveChanges continuation cannot become a generic future flush.
      if (copy !== undefined || intent !== undefined) return reject();

      if (queuedFlush !== "manual") queuedFlush = reason;
      publish();

      return true;
    }

    if (reason === "automatic" && (pause !== null || waitingForNative || epoch <= savedEpoch))
      return reject();

    const request = {
      type: `${document.app}:request-save`,
      protocol: 2,
      version: document.version,
      requestId: crypto.randomUUID(),
      openId,
      documentId,
      reason,
      ...copy,
    };

    if (intent !== undefined) Object.assign(request, { intentId: intent.command.intentId });
    const command = decodeNativeHostCommand(request);

    if (command === null || !("reason" in command)) return reject();

    if (
      command.saveAs === true &&
      !document.outputFormats.some((format) =>
        command.name?.toLowerCase().endsWith(format.extension),
      )
    )
      return reject();
    scheduler?.cancel();
    waitingForNative = false;

    if (reason === "manual") busyAttempts = 0;
    pause = null;
    message = null;
    queuedFlush = null;
    capture = { command, epoch, intent };
    status = "saving";
    operationTimer = setTimeout(() => {
      if (detached && capture !== null) {
        cancelIntent(capture.intent);
        status = "save-failed";
        pause = "save-failed";
        message =
          "The previous capture is unresolved. A new copy must wait for its snapshot or error.";
        publish();
      } else
        serializationFailed(
          "The native editor did not return a snapshot; save again to retry capture",
        );
    }, readyTimeoutMs);
    publish();

    if (!active()) return false;

    try {
      send(command);

      return true;
    } catch {
      serializationFailed("Could not request a native snapshot");

      return false;
    }
  }

  function sameIdentity(value: NativeSnapshotIdentity, expected: NativeSnapshotIdentity) {
    return (
      value.openId === expected.openId &&
      value.documentId === expected.documentId &&
      value.revision === expected.revision &&
      value.requestId === expected.requestId &&
      value.saveId === expected.saveId
    );
  }

  function acknowledge(saved: Pending) {
    const result = saved.persisted;

    if (result === undefined || !active()) return;

    if (saved.intent?.cancelled && !cancelIntent(saved.intent))
      throw new Error("Native continuation cancellation was not delivered");
    clearTimeout(operationTimer);
    operationTimer = setTimeout(() => {
      if (!active() || pending !== saved) return;
      cancelIntent(saved.intent);
      status = "save-failed";
      pause = "save-failed";
      message =
        "Saved to storage, but the native editor did not acknowledge it. Retry will not write it again.";
      publish();
    }, readyTimeoutMs);
    send({
      type: `${document.app}:save-result`,
      protocol: 2,
      version: document.version,
      ...saved.identity,
      status: "saved",
      fileRevision: result.revision,
    });
  }

  async function persist(saved: Pending) {
    if (!active() || persisting || pending !== saved) return;
    persisting = true;
    status = "saving";
    publish();

    if (!active()) {
      persisting = false;

      return;
    }

    try {
      const result =
        saved.persisted ??
        (await backend.save(
          {
            sessionId: document.sessionId,
            expectedRevision: saved.expectedRevision,
            saveId: saved.identity.saveId,
            saveMode: saved.mode,
            output: { ...saved.output, bytes: new Uint8Array(saved.output.bytes) },
          },
          { signal: abort.signal },
        ));

      if (!active() || pending !== saved) return;

      if (result.status === "saved") {
        if (!result.revision || result.revision.length > 2048)
          throw new Error("Persistence returned no revision");

        if (saved.persisted === undefined) {
          saved.persisted = result;

          if (saved.output.intent === "replace") {
            document = Object.freeze({ ...document, revision: result.revision });
            lastSavedAt = Date.now();
          }
        }

        acknowledge(saved);
      } else {
        cancelIntent(saved.intent);
        scheduler?.cancel();
        queuedFlush = null;
        message = result.message;

        if (result.status === "access-ended") {
          try {
            send({
              type: `${document.app}:save-result`,
              protocol: 2,
              version: document.version,
              ...saved.identity,
              ...result,
            });
          } finally {
            stop("access-ended", result.message);
          }
        } else {
          status = result.status === "failed" ? "save-failed" : result.status;
          pause = result.status === "conflict" ? "conflict" : "save-failed";
          publish();
        }

        if (active())
          send({
            type: `${document.app}:save-result`,
            protocol: 2,
            version: document.version,
            ...saved.identity,
            ...result,
          });
      }
    } catch {
      cancelIntent(saved.intent);

      if (active()) {
        status = "save-failed";
        pause = "save-failed";
        scheduler?.cancel();
        queuedFlush = null;
        message = saved.persisted
          ? "Saved to storage, but the native acknowledgement failed. Retry will not write it again."
          : "Could not confirm persistence. The snapshot and save ID are retained for retry.";
      }
    } finally {
      persisting = false;

      if (active()) {
        publish();
        drain();
      }
    }
  }

  function drain() {
    if (!active() || pause !== null || pending !== null || capture !== null || persisting) return;
    const wanted = queuedFlush;

    queuedFlush = null;

    if (wanted !== null && epoch > savedEpoch) flush(wanted);
    else schedule();
  }

  function acceptSave(value: Save) {
    const requested = capture;

    if (requested === null || value.requestId !== requested.command.requestId || pending !== null)
      return;

    if (
      value.openId !== requested.command.openId ||
      value.documentId !== requested.command.documentId
    ) {
      serializationFailed("The native snapshot changed document identity");

      return;
    }

    if (
      value.saveAs !== (requested.command.saveAs === true) ||
      (requested.command.name !== undefined && value.name !== requested.command.name)
    ) {
      serializationFailed("The native snapshot did not match the requested save intent");

      return;
    }

    const owned = copyEditorBytes(value.bytes, document.maxBytes);

    const output =
      owned === null
        ? null
        : classifyEditorOutput(document, {
            kind: "save",
            name: value.name,
            bytes: owned,
            saveAs: value.saveAs,
          });

    if (output === null || (requested.command.saveAs !== true && output.intent !== "replace")) {
      serializationFailed("The native snapshot's format or replacement intent was not authorized");

      return;
    }

    clearTimeout(operationTimer);
    capture = null;
    busyAttempts = 0;

    // A capture with an unobserved clock cannot establish the source's clean baseline.
    if (value.revision !== revision && epoch <= requested.epoch) epoch += 1;
    pending = {
      identity: {
        openId: value.openId,
        documentId: value.documentId,
        revision: value.revision,
        requestId: value.requestId,
        saveId: value.saveId,
      },
      output,
      epoch: value.revision === revision ? epoch : requested.epoch,
      expectedRevision: document.revision,
      mode: requested.command.reason,
      intent: requested.intent,
    };

    if (detached && requested.command.documentId !== documentId) {
      cancelIntent(pending.intent);
      status = "save-failed";
      pause = "save-failed";
      message =
        "The previous source snapshot is retained. Retry to reconcile it before saving a new copy.";
      publish();

      return;
    }

    publish();
    void persist(pending);
  }

  function receive(event: NativeHostEvent) {
    if (
      !active() ||
      !event.type.startsWith(`${document.app}:`) ||
      event.version !== document.version
    )
      return;

    switch (event.type) {
      case "wordcraft:ready":
      case "gridcraft:ready":
      case "pdfcraft:ready":
      case "deckcraft:ready":
        if (openSent) {
          stop("failed", "The native editor restarted. Recover your work before reopening.");

          return;
        }

        ready = event;
        clearTimeout(timer);
        setTheme(theme);
        sendOpen();
        publish();

        return;
      case "wordcraft:opened":
      case "gridcraft:opened":
      case "pdfcraft:opened":
      case "deckcraft:opened":
        if (!openSent || opened || event.openId !== openId) return;
        clearTimeout(timer);
        documentId = event.documentId;
        revision = event.revision;
        bytes = null;
        opened = true;
        status = document.writable ? "editing" : "read-only";
        publish();

        return;
      case "wordcraft:dirty":
      case "gridcraft:dirty":
      case "pdfcraft:dirty":
      case "deckcraft:dirty":
        if (!opened || event.openId !== openId) return;

        if (event.documentId !== documentId) {
          cancelContinuations();
          detached = true;
          documentId = event.documentId;
          epoch += 1;
          scheduler?.cancel();
          waitingForNative = false;
          queuedFlush = null;

          if (capture === null && pending === null && !persisting) {
            status = document.writable ? "editing" : "read-only";
            pause = null;
            message = null;
          }
        }

        const changed = event.revision !== revision;
        revision = event.revision;

        if (event.dirty) {
          observedFalseRevision = null;
          epoch += 1;
        } else {
          // A cancelled draft/safe point still advances the observation token, never durability.
          observedFalseRevision = event.revision;
        }

        if (waitingForNative && changed) {
          waitingForNative = false;
          busyAttempts = 0;
        }

        schedule();
        publish();

        return;
      case "wordcraft:save-requested":
      case "gridcraft:save-requested":
      case "pdfcraft:save-requested":
      case "deckcraft:save-requested": {
        const intent: Intent | undefined =
          event.intentId === undefined
            ? undefined
            : {
                command: {
                  type: `${document.app}:cancel-intent`,
                  protocol: 2,
                  version: document.version,
                  openId: event.openId,
                  documentId: event.documentId,
                  intentId: event.intentId,
                },
                cancelled: false,
                delivered: false,
              };

        if (event.openId === openId && event.documentId === documentId) {
          flush(
            "manual",
            event.saveAs && event.name !== undefined
              ? { saveAs: true, name: event.name }
              : undefined,
            intent,
          );
        } else cancelIntent(intent);

        return;
      }

      case "wordcraft:save":
      case "gridcraft:save":
      case "pdfcraft:save":
      case "deckcraft:save":
        acceptSave(event);

        return;
      case "wordcraft:saved":
      case "gridcraft:saved":
      case "pdfcraft:saved":
      case "deckcraft:saved": {
        const saved = pending;

        if (
          saved === null ||
          saved.persisted === undefined ||
          !sameIdentity(event, saved.identity) ||
          (saved.intent?.cancelled && !saved.intent.delivered)
        )
          return;
        clearTimeout(operationTimer);

        if (saved.output.intent === "replace" && !detached) {
          // Opaque token equality plus the captured dirty epoch guards newer native drafts.
          // Pdf may observe its exact post-ack false token before the matching saved event.
          const sameObservation =
            revision === saved.identity.revision ||
            (revision === event.currentRevision && observedFalseRevision === event.currentRevision);

          if (!event.dirty && sameObservation && epoch === saved.epoch) {
            revision = event.currentRevision;
            observedFalseRevision = null;
            savedEpoch = saved.epoch;
          } else if (event.dirty && epoch <= saved.epoch) {
            epoch += 1;
            revision = event.currentRevision;
            observedFalseRevision = null;
          }
        }

        pending = null;
        status = document.writable ? "editing" : "read-only";
        pause = null;
        message = null;
        publish();
        drain();

        return;
      }

      case "wordcraft:error":
      case "gridcraft:error":
      case "pdfcraft:error":
      case "deckcraft:error":
        if (event.operation === "open" && openSent && !opened) {
          stop("failed", event.message);
        } else if (
          event.operation === "save" &&
          capture !== null &&
          event.requestId === capture.command.requestId
        ) {
          const automatic = capture.command.reason === "automatic";

          if (event.code === "busy" && automatic) {
            clearTimeout(operationTimer);
            capture = null;
            status = document.writable ? "editing" : "read-only";

            if (++busyAttempts < MAX_BUSY_ATTEMPTS) schedule();
            else {
              scheduler?.cancel();
              queuedFlush = null;
              waitingForNative = true;
            }

            publish();
          } else serializationFailed(event.message);
        }

        return;
      case "wordcraft:save-paused":
      case "gridcraft:save-paused":
      case "pdfcraft:save-paused":
      case "deckcraft:save-paused":
        if (
          pending !== null &&
          sameIdentity(event, pending.identity) &&
          (status === "save-failed" || status === "conflict" || status === "read-only")
        ) {
          message = event.message;
          publish();
        }

        return;
      case "wordcraft:theme-applied":
      case "gridcraft:theme-applied":
      case "pdfcraft:theme-applied":
      case "deckcraft:theme-applied":
        if (event.requestId === themeRequest && event.theme === theme) themeRequest = null;

        return;
    }

    event satisfies never;
  }

  const unsubscribe = messages.subscribe((event) => {
    if (event.origin !== origin || event.source !== source) return;
    const decoded = decodeNativeHostEvent(event.data);

    if (decoded !== null) receive(decoded);
  });

  async function download() {
    try {
      const downloaded = await backend.download(document, { signal: abort.signal });

      if (!active()) return;
      bytes = copyEditorBytes(downloaded, document.maxBytes);

      if (bytes === null) throw new Error("Invalid native editor input");
      sendOpen();
    } catch {
      if (active()) stop("failed", "Could not download the authorized document");
    }
  }

  timer = setTimeout(
    () => stop("failed", "The native editor did not become ready in time"),
    readyTimeoutMs,
  );

  if (initialReady !== undefined) receive(initialReady);
  void download();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (status === "disposed") return () => {};

      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    requestSave: (copy) => flush("manual", copy),
    setTheme,
    retry() {
      if (status !== "save-failed" || pending === null || persisting) return false;
      pause = null;
      void persist(pending);

      return true;
    },
    getRecoveryOutputs: () =>
      pending === null ? [] : [{ ...pending.output, bytes: new Uint8Array(pending.output.bytes) }],
    dispose() {
      if (status === "disposed") return;
      cancelContinuations();
      waitingForNative = false;
      unsubscribe();
      abort.abort();
      scheduler?.cancel();
      clearTimeout(timer);
      clearTimeout(operationTimer);
      capture = null;
      bytes = null;
      status = "disposed";
      publish();
      listeners.clear();

      try {
        void backend
          .close?.()
          .catch(() =>
            console.error(
              "Native editor cleanup could not be confirmed; server expiry remains active.",
            ),
          );
      } catch {
        console.error(
          "Native editor cleanup could not be confirmed; server expiry remains active.",
        );
      }
    },
  };
}
