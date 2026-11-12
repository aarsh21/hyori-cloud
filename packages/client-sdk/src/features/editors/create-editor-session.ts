import type {
  BridgedArtCraftApp,
  EditorBackendPort,
  EditorDocument,
  EditorOutput,
  EditorSaveResult,
  EditorSession,
  EditorSessionOptions,
  EditorSnapshot,
  EditorStatus,
  EditorStopReason,
} from "#client-sdk/features/editors/editor-contract";
import { editorOpenFailure } from "#client-sdk/features/editors/create-editors";
import {
  classifyEditorOutput,
  copyEditorBytes,
  decodeEditorMessage,
  decodeEditorReady,
  isNativeEditorDocument,
  validateEditorDocument,
} from "#client-sdk/features/editors/editor-protocol";

import { Schema } from "@hyori-cloud/lib/effect";
import { validateAutosaveTiming } from "#client-sdk/features/editors/create-autosave-scheduler";
import { createNativeEditorSession } from "#client-sdk/features/editors/create-native-editor-session";
import { decodeNativeHostEvent, NativeTheme } from "#client-sdk/features/editors/native-runtime";
import type { NativeHostEvent } from "#client-sdk/features/editors/native-runtime";

interface PendingSave {
  output: EditorOutput;
  dirtyEpoch: number;
  requestId: string;
  saveId?: string;
  persisted?: Extract<EditorSaveResult, { status: "saved" }>;
}

export function createEditorSession(options: EditorSessionOptions): EditorSession {
  const { backend, messages, maxBytes, readyTimeoutMs = 30_000 } = options;
  const expectedOrigin = messages.origin;
  const expectedSource = messages.source;
  const origin = new URL(expectedOrigin);

  if (
    origin.origin !== expectedOrigin ||
    !["https:", "http:"].includes(origin.protocol) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(readyTimeoutMs) ||
    readyTimeoutMs <= 0
  ) {
    throw new Error("Invalid editor attachment configuration");
  }

  if (options.autosave !== undefined) validateAutosaveTiming(options.autosave);

  if (options.theme !== undefined && !Schema.is(NativeTheme)(options.theme))
    throw new Error("Invalid native theme");

  let desiredTheme = options.theme;
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  const readyVersions = new Map<BridgedArtCraftApp, string>();
  const nativeReady = new Map<string, Extract<NativeHostEvent, { type: `${string}:ready` }>>();
  let nativeSession: EditorSession | null = null;
  let nativeUnsubscribe: (() => void) | undefined;
  let lastSavedAt: number | null = null;
  let document: EditorDocument | null = null;
  let status: EditorStatus = "opening";
  let message: string | null = null;
  let reason: EditorStopReason | null = null;
  let originalBytes: Uint8Array<ArrayBuffer> | null = null;
  let opened = false;
  let openSent = false;
  const openId = crypto.randomUUID();
  let deckSequence = 0;
  let lastAcknowledged: PendingSave | null = null;
  let current: PendingSave | null = null;
  let queued: PendingSave | null = null;
  // Copies given up on after a failure: never retried, still downloadable.
  const dismissed: EditorOutput[] = [];
  let persisting = false;
  let dirtyEpoch = 0;
  let savedEpoch = 0;
  let rejectedOutput = false;
  let replacementDisabled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: EditorSnapshot = buildSnapshot();

  function buildSnapshot(): EditorSnapshot {
    return Object.freeze({
      status,
      document,
      hasUnsavedChanges:
        dirtyEpoch > savedEpoch || current !== null || queued !== null || rejectedOutput,
      pendingSaveCount: Number(current !== null) + Number(queued !== null),
      pendingOutput:
        current === null ? null : { name: current.output.name, intent: current.output.intent },
      recoveryCount: dismissed.length + Number(current !== null) + Number(queued !== null),
      // Only a native editor can be asked for its current state.
      recovering: false,
      lastSavedAt,
      autosave: {
        status: "disabled",
        reason: options.autosave === undefined ? "not-enabled" : "unsupported",
      } satisfies EditorSnapshot["autosave"],
      message,
      reason,
    });
  }

  function publish() {
    snapshot = buildSnapshot();

    for (const listener of listeners) listener();
  }

  function stop(
    nextStatus: "failed" | "access-ended",
    text: string,
    why: EditorStopReason = nextStatus === "failed" ? "crashed" : "access-revoked",
  ) {
    if (!active()) return;

    status = nextStatus;
    message = text;
    reason = why;
    abort.abort();
    clearTimeout(timer);
    originalBytes = null;
    publish();
  }

  function reportCloseFailure() {
    console.error("Editor session cleanup could not be confirmed; server expiry remains active.");
  }

  function active() {
    return status !== "disposed" && status !== "failed" && status !== "access-ended";
  }

  function sendOpen() {
    if (!active() || openSent || !document) return;
    const version = readyVersions.get(document.app);

    if (version === undefined) return;

    if (version !== document.version) {
      stop(
        "failed",
        "The editor asset version does not match the open descriptor",
        "editor-updated",
      );

      return;
    }

    clearTimeout(timer);

    if (!originalBytes) return;

    try {
      openSent = true;

      // No transfer list: the acknowledged protocol retains its input until parsing succeeds.
      if (document.app === "deckcraft") {
        timer = setTimeout(
          () =>
            stop(
              "failed",
              "The editor did not acknowledge opening the document in time",
              "timeout",
            ),
          readyTimeoutMs,
        );
        messages.post(
          {
            type: "deckcraft:open",
            protocol: 1,
            version: document.version,
            openId,
            name: document.name,
            bytes: new Uint8Array(originalBytes),
            maxBytes: document.maxBytes,
            writable: document.writable,
            replacementName: document.replacementName,
            outputFormats: document.outputFormats,
          },
          expectedOrigin,
        );

        return;
      }

      messages.post(
        { type: `${document.app}:open`, name: document.name, bytes: originalBytes },
        expectedOrigin,
      );

      if (!active()) return;

      originalBytes = null;
      opened = true;
      status = document.writable ? "editing" : "read-only";
      publish();
    } catch {
      stop("failed", "Could not send the document to the editor");
    }
  }

  function rejectOutput(reason: string) {
    rejectedOutput = true;
    message = reason;
    publish();
  }

  function acknowledge(saved: PendingSave, result: EditorSaveResult) {
    if (!document || !saved.saveId) return;

    // Protocol 1 predates a distinct cancellation; to that frame it is an ordinary failure.
    const outcome: EditorSaveResult =
      result.status === "saved"
        ? { status: result.status, revision: result.revision }
        : {
            status: result.status === "cancelled" ? "failed" : result.status,
            message: result.message,
          };

    messages.post(
      {
        type: "deckcraft:save-result",
        protocol: 1,
        version: document.version,
        saveId: saved.saveId,
        ...outcome,
      },
      expectedOrigin,
    );
  }

  function matchesOutput(left: EditorOutput, right: EditorOutput) {
    return (
      left.name === right.name &&
      left.intent === right.intent &&
      left.bytes.length === right.bytes.length &&
      left.bytes.every((byte, index) => byte === right.bytes[index])
    );
  }

  function acceptOutput(output: EditorOutput, saveId?: string) {
    if (!document) return;

    if (saveId) {
      if (lastAcknowledged?.saveId === saveId) {
        if (!matchesOutput(lastAcknowledged.output, output)) {
          rejectOutput("The editor reused a save ID for different output");

          return;
        }

        if (lastAcknowledged.persisted) {
          try {
            acknowledge(lastAcknowledged, lastAcknowledged.persisted);
          } catch {
            rejectOutput("The saved output could not be acknowledged; resend the same save");
          }
        }

        return;
      }

      if (current?.saveId === saveId) {
        if (!matchesOutput(current.output, output))
          rejectOutput("The editor reused a save ID for different output");

        return;
      }

      const suffix = saveId.slice(openId.length + 1);

      if (
        current ||
        !saveId.startsWith(`${openId}:`) ||
        !/^[1-9]\d{0,9}$/.test(suffix) ||
        Number(suffix) !== deckSequence + 1 ||
        Number(suffix) > 0xffff_ffff
      ) {
        rejectOutput("The editor sent an unexpected save ID or another save is still pending");

        return;
      }

      deckSequence += 1;
    }

    const pending: PendingSave = { output, dirtyEpoch, requestId: saveId ?? crypto.randomUUID() };

    if (saveId) pending.saveId = saveId;

    if (
      !current ||
      (status === "read-only" && current.output.intent === "replace" && output.intent !== "replace")
    )
      current = pending;
    else if (!queued || (queued.output.intent === "replace" && output.intent === "replace"))
      queued = pending;
    else {
      rejectOutput(
        "The save queue is full; save this output again after the pending operation finishes",
      );

      return;
    }

    publish();

    if (status !== "save-failed") void persist();
  }

  function finishSave(result: EditorSaveResult, saved: PendingSave) {
    if (!document) return;

    switch (result.status) {
      case "saved":
        if (!result.revision || result.revision.length > 2048) {
          status = "save-failed";
          message = "Persistence returned no revision";

          return;
        }

        if (saved.output.intent === "replace") {
          document = Object.freeze({ ...document, revision: result.revision });
        }

        if (saved.output.intent !== "export") savedEpoch = saved.dirtyEpoch;

        if (saved.saveId) lastAcknowledged = saved;
        current = queued;
        queued = null;
        status = document.writable ? "editing" : "read-only";
        message = rejectedOutput ? message : null;

        return;
      case "access-ended":
        stop("access-ended", result.message);

        return;
      case "conflict":
      case "read-only":
      case "cancelled":
      case "failed":
        status =
          result.status === "failed" || result.status === "cancelled"
            ? "save-failed"
            : result.status;
        message = result.message;

        return;
    }
  }

  async function persist() {
    if (
      !active() ||
      persisting ||
      !current ||
      !document ||
      !opened ||
      status === "conflict" ||
      ((!document.writable || status === "read-only") && current.output.intent === "replace") ||
      status === "save-failed"
    )
      return;
    persisting = true;
    status = "saving";
    const saved = current;
    const expectedRevision = document.revision;
    publish();

    if (!active()) {
      persisting = false;

      return;
    }

    try {
      const input: Parameters<EditorBackendPort["save"]>[0] = {
        sessionId: document.sessionId,
        expectedRevision,
        saveId: saved.requestId,
        // A capability may transfer/mutate its input. Keep our own retry bytes intact.
        output: { ...saved.output, bytes: new Uint8Array(saved.output.bytes) },
      };

      const result = saved.persisted ?? (await backend.save(input, { signal: abort.signal }));

      if (active()) {
        if (result.status === "saved") {
          if (!result.revision || result.revision.length > 2048) {
            finishSave(result, saved);

            return;
          }

          if (saved.persisted === undefined && saved.output.intent === "replace")
            lastSavedAt = Date.now();
          saved.persisted = result;
        }

        acknowledge(saved, result);

        if (active()) finishSave(result, saved);
      }
    } catch {
      if (active()) {
        status = "save-failed";
        message = saved.persisted
          ? "The output was saved, but the editor acknowledgement failed; retry will not save it again"
          : "Could not confirm persistence; the bytes and save ID are retained for retry";
      }
    } finally {
      persisting = false;

      if (active()) {
        publish();

        if ((snapshot.status === "editing" || snapshot.status === "read-only") && current)
          void persist();
      }
    }
  }

  const unsubscribe = messages.subscribe((event) => {
    if (
      !active() ||
      event.origin !== expectedOrigin ||
      event.source !== expectedSource ||
      nativeSession !== null
    )
      return;
    const native = decodeNativeHostEvent(event.data);

    if (native !== null) {
      if (native.type.endsWith(":ready") && "capabilities" in native)
        nativeReady.set(native.type, native);

      return;
    }

    if (!document) {
      // A frame may finish loading before the backend open operation. Cache only the four
      // bounded ready envelopes, never document bytes or arbitrary pre-open messages.
      const ready = decodeEditorReady(event);

      if (ready) readyVersions.set(ready.app, ready.version);

      return;
    }

    const decoded = decodeEditorMessage(event, document.app, document.maxBytes, document.version);

    switch (decoded.kind) {
      case "ready":
        if (openSent) {
          // A navigated/reloaded editor has lost its in-memory document. Never replay open
          // over unsaved output or let the new frame save against the old attachment.
          stop("failed", "The editor restarted; recover pending output before reopening");

          return;
        }

        readyVersions.set(document.app, decoded.version);
        sendOpen();

        return;
      case "opened":
        if (!openSent || opened || decoded.openId !== openId || decoded.name !== document.name)
          return;
        clearTimeout(timer);
        originalBytes = null;
        opened = true;
        status = document.writable ? "editing" : "read-only";
        publish();

        return;
      case "saved":
        // This may confirm applying an already durable save, never persistence by itself.
        if (decoded.saveId === lastAcknowledged?.saveId && decoded.dirty) {
          dirtyEpoch += 1;
          publish();
        }

        return;
      case "error":
        if (decoded.operation === "open" && decoded.operationId === openId)
          stop("failed", decoded.error, "unreadable");
        else if (opened) rejectOutput(decoded.error);

        return;
      case "dirty":
        if (opened && decoded.dirty) {
          dirtyEpoch += 1;
          publish();
        }

        // Child clean is not a persistence acknowledgement.
        return;
      case "save": {
        if (!opened || (document.app === "deckcraft" && decoded.openId !== openId)) return;

        const output = classifyEditorOutput(
          replacementDisabled ? { ...document, replacementName: null } : document,
          decoded,
        );

        // Word/Pdf Save As changes the child's active document even if parent persistence fails.
        // Later ordinary saves of that new document must not fall back to replacing the source.
        if (output?.intent === "save-as") replacementDisabled = true;

        if (output) acceptOutput(output, decoded.saveId);
        else rejectOutput("The editor sent a format not authorized by the open descriptor");

        return;
      }

      case "failed":
        stop("failed", decoded.error);

        return;
      case "invalid":
        rejectOutput("The editor sent an invalid or oversized message");

        return;
      case "ignore":
        return;
    }
  });

  async function open() {
    try {
      const descriptor = await backend.open({ signal: abort.signal });

      if (!active()) return;
      validateEditorDocument(descriptor, maxBytes);
      document = Object.freeze({
        ...descriptor,
        outputFormats: Object.freeze(
          descriptor.outputFormats.map((format) => Object.freeze({ ...format })),
        ),
      });
      publish();

      if (!active()) return;

      if (isNativeEditorDocument(document)) {
        unsubscribe();
        nativeSession = createNativeEditorSession(
          {
            ...options,
            theme: desiredTheme,
            messages: {
              origin: expectedOrigin,
              source: expectedSource,
              subscribe: (listener) => messages.subscribe(listener),
              post: (command, target) => messages.post(command, target),
            },
          },
          document,
          nativeReady.get(`${document.app}:ready`),
        );
        const native = nativeSession;

        const relay = () => {
          snapshot = native.getSnapshot();

          for (const listener of listeners) listener();
        };

        nativeUnsubscribe = native.subscribe(relay);
        relay();

        return;
      }

      timer = setTimeout(
        () => stop("failed", "The editor did not become ready in time", "timeout"),
        readyTimeoutMs,
      );
      sendOpen();

      if (!active()) return;
      const downloaded = await backend.download(document, { signal: abort.signal });

      if (!active()) return;
      originalBytes = copyEditorBytes(downloaded, document.maxBytes);

      if (!originalBytes) throw new Error("Invalid editor download");
      sendOpen();
    } catch (cause) {
      if (active())
        stop("failed", "Could not open the authorized document", editorOpenFailure(cause));
    }
  }

  void open();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (status === "disposed") return () => {};

      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    requestSave: (copy) => nativeSession?.requestSave(copy) ?? false,
    setTheme(theme) {
      if (!Schema.is(NativeTheme)(theme)) return false;
      desiredTheme = theme;

      return nativeSession?.setTheme(theme) ?? false;
    },
    retry() {
      if (nativeSession !== null) return nativeSession.retry();

      if (status !== "save-failed" || !current || persisting) return false;
      status = "editing";
      void persist();

      return true;
    },
    dismiss() {
      if (nativeSession !== null) return nativeSession.dismiss();

      if (
        status !== "save-failed" ||
        !current ||
        persisting ||
        current.output.intent === "replace" ||
        current.persisted
      )
        return false;
      dismissed.push(current.output);

      if (dismissed.length > 3) dismissed.shift();
      current = queued;
      queued = null;
      status = document?.writable === false ? "read-only" : "editing";
      message = null;
      publish();

      if (current) void persist();

      return true;
    },
    getRecoveryOutputs: () =>
      nativeSession?.getRecoveryOutputs() ?? [
        ...dismissed.map((output) => ({ ...output, bytes: new Uint8Array(output.bytes) })),
        ...[current, queued].flatMap((pending) =>
          pending ? [{ ...pending.output, bytes: new Uint8Array(pending.output.bytes) }] : [],
        ),
      ],
    dispose() {
      if (status === "disposed") return;
      unsubscribe();

      if (nativeSession !== null) {
        nativeSession.dispose();
        nativeUnsubscribe?.();
        abort.abort();
        status = "disposed";
        listeners.clear();

        return;
      }

      abort.abort();
      clearTimeout(timer);
      originalBytes = null;
      lastAcknowledged = null;
      status = "disposed";
      publish();
      listeners.clear();

      try {
        void backend.close?.().catch(reportCloseFailure);
      } catch {
        reportCloseFailure();
      }
    },
  };
}
