import { Schema } from "@hyori-cloud/lib/effect";
import { normalizeClientError } from "#client-sdk/errors";
import type {
  EditorAutosave,
  EditorDocument,
  EditorOutput,
  EditorSaveResult,
  EditorSession,
  EditorSessionOptions,
  EditorSnapshot,
  EditorStatus,
  EditorStopReason,
} from "#client-sdk/features/editors/editor-contract";
import { createAutosaveScheduler } from "#client-sdk/features/editors/create-autosave-scheduler";
import { editorOpenFailure } from "#client-sdk/features/editors/create-editors";
import {
  classifyEditorOutput,
  copyEditorBytes,
} from "#client-sdk/features/editors/editor-protocol";
import {
  decodeNativeHostCommand,
  decodeNativeHostEvent,
  NATIVE_HOST_PROTOCOL,
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

/** `recovery` captures only refill the local recovery list; they are never persisted. */
type Capture = { command: RequestSave; epoch: number; intent?: Intent; recovery?: true };

type Pending = {
  identity: NativeSnapshotIdentity;
  output: EditorOutput;
  epoch: number;
  expectedRevision: string;
  mode: RequestSave["reason"];
  intent?: Intent;
  persisted?: Extract<EditorSaveResult, { status: "saved" }>;
  retryAttempts?: number;
  retryable?: boolean;
};

const MAX_BUSY_ATTEMPTS = 3;
const MAX_THEME_ATTEMPTS = 3;

// Each kept copy may be as large as the document; a few is enough to never lose the latest.
const MAX_RECOVERED = 3;

// Native parse and serialization scale with document size; waits grow by one period per 8 MiB.
const BYTES_PER_PERIOD = 8 * 1024 * 1024;

/** Local protocol2 lifecycle. Native serialization and backend persistence each have one owner. */
export function createNativeEditorSession(
  options: EditorSessionOptions,
  descriptor: EditorDocument,
  initialReady?: Ready,
): EditorSession {
  const { backend, messages, readyTimeoutMs = 30_000, visibility } = options;
  const origin = messages.origin;
  const source = messages.source;
  const openId = crypto.randomUUID();
  const abort = new AbortController();
  const listeners = new Set<() => void>();
  let document = descriptor;
  let status: EditorStatus = "opening";
  let message: string | null = null;
  let reason: EditorStopReason | null = null;
  let ready: Ready | null = null;
  let opened = false;
  let openSent = false;
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  let documentBytes = 0;
  let documentId: string | null = null;
  let revision: string | null = null;
  let observedFalseRevision: string | null = null;
  let waitingForNative = false;
  let detached = false;
  // Edit permission withdrawn mid-session: the source stays readable, so copies remain possible.
  let downgraded = false;
  let epoch = 0;
  let savedEpoch = 0;
  let lastSavedAt: number | null = null;
  let capture: Capture | null = null;
  // A capture that outlived its wait. The frame may still answer it, so its ID is reused.
  let stale: Capture | null = null;
  let pending: Pending | null = null;
  const recovered: EditorOutput[] = [];
  let persisting = false;
  let queuedFlush: "manual" | "automatic" | null = null;
  let pause: Extract<EditorAutosave, { status: "paused" }>["reason"] | null = null;
  let busyAttempts = 0;
  let theme = options.theme ?? "system";
  let themeRequest: string | null = null;
  let themeAttempts = 0;
  let themeTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduler =
    options.autosave === undefined
      ? null
      : createAutosaveScheduler(options.autosave, () => {
          // A timer that finds nothing newer to save still ends "scheduled": say so.
          if (!flush("automatic") && active()) publish();
        });

  let snapshot = buildSnapshot();

  function active() {
    return status !== "disposed" && status !== "failed" && status !== "access-ended";
  }

  function editable() {
    return document.writable && !downgraded;
  }

  function idleStatus(): EditorStatus {
    return editable() ? "editing" : "read-only";
  }

  /** A timer that never expires while the page is hidden, where the frame's work is throttled. */
  function wait(ms: number, expired: () => void): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => {
      if (visibility?.hidden()) {
        // Rearm under the same slot the caller cleared/replaced, by returning through it.
        const next = wait(ms, expired);

        if (timer === handle) timer = next;

        if (operationTimer === handle) operationTimer = next;
      } else expired();
    }, ms);

    return handle;
  }

  function sized(base: number) {
    return base * (1 + Math.floor(documentBytes / BYTES_PER_PERIOD));
  }

  function autosave(): EditorAutosave {
    if (detached) return { status: "disabled", reason: "copy-required" };

    if (options.autosave === undefined) return { status: "disabled", reason: "not-enabled" };

    if (ready === null) return { status: "disabled", reason: "unsupported" };

    if (!editable() || status === "read-only") return { status: "disabled", reason: "read-only" };

    if (document.replacementName === null) return { status: "disabled", reason: "copy-required" };

    if (pause !== null) return { status: "paused", reason: pause };

    if (waitingForNative) return { status: "waiting", reason: "native-busy" };

    if (capture !== null && capture.recovery !== true) return { status: "serializing" };

    if (scheduler?.pending() || queuedFlush !== null) return { status: "scheduled" };

    return { status: "idle" };
  }

  function buildSnapshot(): EditorSnapshot {
    return Object.freeze({
      status,
      document,
      hasUnsavedChanges: epoch > savedEpoch || pending !== null || capture !== null,
      pendingSaveCount: Number(pending !== null),
      pendingOutput:
        pending === null ? null : { name: pending.output.name, intent: pending.output.intent },
      recoveryCount: recovered.length + Number(pending !== null),
      recovering: capture?.recovery === true,
      lastSavedAt,
      autosave: autosave(),
      message,
      reason,
    });
  }

  function publish() {
    snapshot = buildSnapshot();

    for (const listener of listeners) listener();
  }

  function remember(output: EditorOutput) {
    recovered.push(output);

    if (recovered.length > MAX_RECOVERED) recovered.shift();
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
    cancelIntent(stale?.intent);
    cancelIntent(pending?.intent);
  }

  function stop(next: "failed" | "access-ended", text: string, why: EditorStopReason) {
    if (!active()) return;
    cancelContinuations();
    waitingForNative = false;
    status = next;
    message = text;
    reason = why;

    if (next === "access-ended") pause = "access-ended";
    scheduler?.cancel();
    clearTimeout(timer);
    clearTimeout(operationTimer);
    clearTimeout(themeTimer);
    clearTimeout(retryTimer);
    stopWatching?.();
    stopConnectivity?.();
    bytes = null;
    capture = null;
    stale = null;
    abort.abort();
    publish();
  }

  function serializationFailed(text: string) {
    clearTimeout(operationTimer);
    cancelIntent(capture?.intent);
    waitingForNative = false;
    capture = null;
    status = idleStatus();
    pause = "serialization-failed";
    message = text;
    scheduler?.cancel();
    queuedFlush = null;
    // A failed capture can contain a draft not yet represented by a dirty packet.
    epoch += 1;
    publish();
  }

  function send(command: NativeHostCommand, transfer?: ArrayBuffer[]) {
    messages.post(command, origin, transfer);
  }

  function sendTheme(): boolean {
    if (!active() || ready === null) return false;

    // One request at a time: the frame refuses a second, and the latest wish is resent after.
    if (themeRequest !== null) return true;
    const requestId = crypto.randomUUID();

    try {
      send({
        type: `${document.app}:set-theme`,
        protocol: NATIVE_HOST_PROTOCOL,
        version: document.version,
        requestId,
        theme,
      });
      themeRequest = requestId;

      return true;
    } catch {
      return false;
    }
  }

  function setTheme(next: NativeTheme): boolean {
    if (!Schema.is(NativeTheme)(next)) return false;
    theme = next;
    themeAttempts = 0;

    return sendTheme();
  }

  function sendOpen() {
    if (!active() || ready === null || bytes === null || openSent) return;

    if (ready.maxBytes < document.maxBytes) {
      stop(
        "failed",
        "The native editor cannot accept this document's authorized byte limit",
        "unsupported",
      );

      return;
    }

    openSent = true;
    clearTimeout(timer);
    timer = wait(sized(readyTimeoutMs), () =>
      stop("failed", "The native editor did not acknowledge parsing the document", "timeout"),
    );
    // Exclusively ours since download; transferring avoids cloning the whole document again.
    const owned = bytes;

    bytes = null;

    try {
      send(
        {
          type: `${document.app}:open`,
          protocol: NATIVE_HOST_PROTOCOL,
          version: document.version,
          openId,
          name: document.name,
          bytes: owned,
          writable: document.writable,
          replacementName: document.replacementName,
          outputFormats: document.outputFormats,
          maxBytes: document.maxBytes,
        },
        [owned.buffer],
      );
    } catch {
      stop("failed", "Could not send the document to the native editor", "crashed");
    }
  }

  function mayReplace() {
    return !detached && editable() && status !== "read-only" && document.replacementName !== null;
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

  function startCapture(next: Capture) {
    capture = next;
    operationTimer = wait(sized(readyTimeoutMs), () => {
      if (capture !== next) return;

      if (next.recovery === true) {
        capture = null;
        publish();

        return;
      }

      if (detached) {
        cancelIntent(next.intent);
        status = "save-failed";
        pause = "save-failed";
        message =
          "The previous capture is unresolved. A new copy must wait for its snapshot or error.";
        publish();

        return;
      }

      // Keep its identity: a late snapshot is still accepted, and saving again asks for it.
      stale = next;
      serializationFailed(
        "The editor is taking a long time to prepare your changes. Save again to keep waiting.",
      );
    });
    publish();

    if (!active()) return false;

    try {
      send(next.command);

      return true;
    } catch {
      serializationFailed("Could not request a native snapshot");

      return false;
    }
  }

  function flush(why: "manual" | "automatic", copy?: Copy, intent?: Intent): boolean {
    function reject() {
      cancelIntent(intent);

      return false;
    }

    if (!active() || !opened || documentId === null || ready === null) return reject();

    if (copy === undefined && !mayReplace()) return reject();

    // A capture failure must not lock out the person's next plain Save; other pauses still do.
    if (pause !== null && pause !== "serialization-failed") return reject();

    if (status === "conflict" || status === "save-failed") return reject();

    if (capture !== null || pending !== null || persisting) {
      // Native job/options and SaveChanges continuations cannot become a generic future flush.
      if (copy !== undefined) return reject();

      // A plain Save still happens next; only its continuation is fenced.
      if (intent !== undefined) {
        cancelIntent(intent);
        queuedFlush = "manual";
        publish();

        return true;
      }

      if (queuedFlush !== "manual") queuedFlush = why;
      publish();

      return true;
    }

    if (stale !== null) {
      if (copy !== undefined) return reject();
      cancelIntent(intent);
      scheduler?.cancel();
      waitingForNative = false;
      pause = null;
      message = null;
      queuedFlush = null;
      status = "saving";
      const retried = stale;

      stale = null;

      return startCapture(retried);
    }

    if (why === "automatic" && (pause !== null || waitingForNative || epoch <= savedEpoch))
      return reject();

    const request = {
      type: `${document.app}:request-save`,
      protocol: NATIVE_HOST_PROTOCOL,
      version: document.version,
      requestId: crypto.randomUUID(),
      openId,
      documentId,
      reason: why,
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

    if (why === "manual") busyAttempts = 0;
    pause = null;
    message = null;
    queuedFlush = null;
    status = "saving";

    return startCapture({ command, epoch, intent });
  }

  /** After a conflict, refill recovery with exactly what is in the editor now. */
  function captureRecovery() {
    if (documentId === null || capture !== null) return;
    const format = document.outputFormats.find((candidate) => candidate.kind === "document");

    if (format === undefined) return;
    const dot = document.name.lastIndexOf(".");
    const stem = dot > 0 ? document.name.slice(0, dot) : document.name;

    const command = decodeNativeHostCommand({
      type: `${document.app}:request-save`,
      protocol: NATIVE_HOST_PROTOCOL,
      version: document.version,
      requestId: crypto.randomUUID(),
      openId,
      documentId,
      reason: "manual",
      saveAs: true,
      name: `${stem}${format.extension}`,
    });

    if (command === null || !("reason" in command)) return;
    startCapture({ command, epoch, recovery: true });
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

  /**
   * Tells the frame the host kept these bytes and will never persist them, so its single
   * snapshot slot is free again. A frame from before `discarded` ignores it; for copies, which can
   * never mark the source clean, the earlier completed-copy acknowledgement frees that frame too.
   */
  function releaseFrame(identity: NativeSnapshotIdentity, intent: EditorOutput["intent"]) {
    const { openId: open, documentId: id, revision: native, requestId, saveId } = identity;

    const envelope = {
      protocol: NATIVE_HOST_PROTOCOL,
      version: document.version,
      openId: open,
      documentId: id,
      revision: native,
      requestId,
      saveId,
    } as const;

    try {
      send({
        ...envelope,
        type: `${document.app}:save-result`,
        status: "discarded",
        message: "Kept by the host",
      });

      if (intent !== "replace")
        send({
          ...envelope,
          type: `${document.app}:save-result`,
          status: "saved",
          fileRevision: "not-persisted",
        });
    } catch {
      // The bytes are safe here regardless; a frame that missed this answers later saves busy.
    }
  }

  /** A save that certainly wrote nothing: keep its bytes locally and get back to editing. */
  function release(saved: Pending, text: string | null) {
    remember(saved.output);
    cancelIntent(saved.intent);
    releaseFrame(saved.identity, saved.output.intent);
    clearTimeout(operationTimer);
    pending = null;
    status = idleStatus();
    pause = null;
    message = text;
    publish();
    drain();
  }

  function enterConflict(saved: Pending, text: string) {
    remember(saved.output);
    pending = null;
    status = "conflict";
    pause = "conflict";
    message = text;
    scheduler?.cancel();
    queuedFlush = null;
    releaseFrame(saved.identity, saved.output.intent);
    publish();
    // The conflict snapshot can predate the last few edits; ask for the editor's current state.
    captureRecovery();
  }

  function acknowledge(saved: Pending) {
    const result = saved.persisted;

    if (result === undefined || !active()) return;

    if (saved.intent?.cancelled && !cancelIntent(saved.intent))
      throw new Error("Native continuation cancellation was not delivered");
    clearTimeout(operationTimer);
    operationTimer = wait(readyTimeoutMs, () => {
      if (!active() || pending !== saved) return;
      cancelIntent(saved.intent);
      status = "save-failed";
      pause = "save-failed";
      message =
        "Saved to storage, but the native editor did not acknowledge it. Retry will not write it again.";
      publish();
    });
    send({
      type: `${document.app}:save-result`,
      protocol: NATIVE_HOST_PROTOCOL,
      version: document.version,
      ...saved.identity,
      status: "saved",
      fileRevision: result.revision,
    });
  }

  function refused(saved: Pending, result: Exclude<EditorSaveResult, { status: "saved" }>) {
    saved.retryable = result.status === "failed" && result.retryable === true;
    cancelIntent(saved.intent);
    scheduler?.cancel();
    queuedFlush = null;

    const envelope = {
      type: `${document.app}:save-result`,
      protocol: NATIVE_HOST_PROTOCOL,
      version: document.version,
      ...saved.identity,
    } as const;

    if (result.status === "access-ended") {
      try {
        send({ ...envelope, status: result.status, message: result.message });
      } finally {
        stop("access-ended", result.message, result.reason ?? "access-revoked");
      }

      return;
    }

    const copy = saved.output.intent !== "replace";

    // Each of these certainly wrote nothing. A copy just gives up; the source keeps editing.
    if (copy && result.status !== "failed") {
      release(saved, result.status === "cancelled" ? null : result.message);

      return;
    }

    if (!copy && result.status === "read-only") {
      downgraded = true;
      send({ ...envelope, status: "read-only", message: result.message });
      release(saved, result.message);

      return;
    }

    if (!copy && result.status === "conflict") {
      send({ ...envelope, status: "conflict", message: result.message });
      enterConflict(saved, result.message);

      return;
    }

    // Possibly written: keep the exact bytes and save ID for an explicit retry.
    status = "save-failed";
    pause = "save-failed";
    message = result.message;
    publish();
    send({ ...envelope, status: "failed", message: result.message });
  }

  function retryPersistence(immediate = false) {
    const saved = pending;

    if (
      !active() ||
      status !== "save-failed" ||
      persisting ||
      saved === null ||
      !saved.retryable ||
      (saved.retryAttempts ?? 0) >= 3
    )
      return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(
      () => {
        if (!active() || pending !== saved || persisting || status !== "save-failed") return;
        saved.retryAttempts = (saved.retryAttempts ?? 0) + 1;
        pause = null;
        void persist(saved);
      },
      immediate ? 0 : 1000 * 2 ** (saved.retryAttempts ?? 0),
    );
  }

  async function persist(saved: Pending) {
    if (!active() || persisting || pending !== saved) return;
    clearTimeout(retryTimer);
    saved.retryable = false;
    persisting = true;
    status = "saving";
    publish();

    if (!active()) {
      persisting = false;

      return;
    }

    let awaitingBackend = saved.persisted === undefined;

    try {
      const result =
        saved.persisted ??
        (await backend.save(
          {
            sessionId: document.sessionId,
            expectedRevision: saved.expectedRevision,
            saveId: saved.identity.saveId,
            saveMode: saved.mode,
            // The port contract forbids mutating these, so the retained bytes go out uncopied.
            output: saved.output,
          },
          { signal: abort.signal },
        ));

      awaitingBackend = false;

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
      } else refused(saved, result);
    } catch (cause) {
      cancelIntent(saved.intent);

      if (active() && pending === saved) {
        const error = normalizeClientError(cause);
        saved.retryable ||=
          awaitingBackend &&
          (error.code === "SDK_TRANSPORT" || error.code === "service.unavailable");
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
        retryPersistence();
      }
    }
  }

  function drain() {
    if (!active() || pause !== null || pending !== null || capture !== null || persisting) return;
    const wanted = queuedFlush;

    queuedFlush = null;

    if (wanted !== null && epoch > savedEpoch) flush(wanted);
    else {
      schedule();

      // A dropped queued flush changes what the snapshot reports, even when nothing is scheduled.
      if (wanted !== null) publish();
    }
  }

  function acceptRecovery(value: Save) {
    clearTimeout(operationTimer);
    capture = null;
    const owned = copyEditorBytes(value.bytes, document.maxBytes);

    if (owned !== null) remember({ name: value.name, bytes: owned, intent: "save-as" });
    releaseFrame(value, "save-as");
    publish();
  }

  function acceptSave(value: Save) {
    const requested =
      capture?.command.requestId === value.requestId
        ? capture
        : capture === null && stale?.command.requestId === value.requestId
          ? stale
          : null;

    if (requested === null || pending !== null) return;

    if (requested.recovery === true) {
      acceptRecovery(value);

      return;
    }

    if (requested === stale) {
      stale = null;
      pause = null;
      message = null;
      status = "saving";
    }

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

  function receiveError(event: Extract<NativeHostEvent, { type: `${string}:error` }>) {
    if (event.operation === "theme") {
      if (event.requestId === undefined || event.requestId !== themeRequest) return;
      themeRequest = null;

      // Busy means an older request still occupies the frame; try the latest wish again shortly.
      if (event.code === "busy" && ++themeAttempts <= MAX_THEME_ATTEMPTS) {
        clearTimeout(themeTimer);
        themeTimer = setTimeout(sendTheme, 250 * themeAttempts);
      }

      return;
    }

    if (event.operation === "open") {
      if (openSent && !opened) stop("failed", event.message, "unreadable");
      else if (opened) {
        // The engine hit a problem after opening. Editing may continue, but say so.
        message = `The editor reported a problem: ${event.message}`;
        publish();
      }

      return;
    }

    if (event.requestId === undefined) {
      // Only a native Save pressed while another save owns the frame reports busy without an ID.
      // The frame has already dropped its job; the Save itself still runs next.
      if (event.code === "busy" && opened) flush("manual");

      return;
    }

    if (stale !== null && event.requestId === stale.command.requestId && capture === null) {
      // The late answer to a capture we stopped waiting for: the frame has let it go.
      cancelIntent(stale.intent);
      stale = null;

      return;
    }

    if (capture === null || event.requestId !== capture.command.requestId) return;

    if (capture.recovery === true) {
      // An older frame still holds the conflict snapshot; recovery keeps that one.
      clearTimeout(operationTimer);
      capture = null;
      publish();

      return;
    }

    if (event.code === "busy" && capture.command.reason === "automatic") {
      clearTimeout(operationTimer);
      capture = null;
      status = idleStatus();

      // A manual Save queued behind this automatic capture goes now, with its manual reason.
      if (queuedFlush !== null) {
        busyAttempts = 0;
        drain();

        return;
      }

      if (++busyAttempts < MAX_BUSY_ATTEMPTS) schedule();
      else {
        scheduler?.cancel();
        queuedFlush = null;
        waitingForNative = true;
      }

      publish();
    } else serializationFailed(event.message);
  }

  function receive(event: NativeHostEvent) {
    if (
      !active() ||
      !event.type.startsWith(`${document.app}:`) ||
      event.version !== document.version
    )
      return;

    switch (event.type) {
      case "wordcraft:engine-request":
      case "gridcraft:engine-request":
      case "pdfcraft:engine-request":
      case "deckcraft:engine-request":
        // Asked once, before the engine starts. Asking again means the frame started over, like a
        // second ready: it gets nothing more, and the person recovers their work.
        if (engineRequested || ready !== null) {
          stop(
            "failed",
            "The native editor restarted. Recover your work before reopening.",
            "crashed",
          );

          return;
        }

        engineRequested = true;
        void handEngine();

        return;
      case "wordcraft:ready":
      case "gridcraft:ready":
      case "pdfcraft:ready":
      case "deckcraft:ready":
        if (openSent) {
          stop(
            "failed",
            "The native editor restarted. Recover your work before reopening.",
            "crashed",
          );

          return;
        }

        ready = event;
        clearTimeout(timer);
        sendTheme();
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
        opened = true;
        status = idleStatus();
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
            status = idleStatus();
            pause = null;
            message = null;
          }
        }

        {
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
                  protocol: NATIVE_HOST_PROTOCOL,
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
        status = idleStatus();
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
        receiveError(event);

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
        if (event.requestId !== themeRequest) return;
        themeRequest = null;
        themeAttempts = 0;

        // Toggled again while this one was applying: catch up to the latest choice.
        if (event.theme !== theme) sendTheme();

        return;
    }

    event satisfies never;
  }

  // Started with the session, so the engine is usually in hand before the frame asks for it.
  const named = document.engine ?? null;

  const engine =
    named !== null && options.engine !== undefined
      ? options.engine.load(named, { signal: abort.signal }).then(
          (loaded) => loaded,
          () => null,
        )
      : undefined;

  let engineRequested = false;

  /** Once, before ready: the descriptor's verified engine, or null to load it the ordinary way. */
  async function handEngine() {
    const envelope = {
      type: `${document.app}:engine`,
      protocol: NATIVE_HOST_PROTOCOL,
      version: document.version,
    } as const;

    if (engine === undefined) {
      send({ ...envelope, bytes: null });

      return;
    }

    const loaded = await engine;

    if (!active()) return;

    if (loaded === null) {
      stop("failed", "The editor couldn't be loaded", "unavailable");

      return;
    }

    send({ ...envelope, bytes: loaded }, [loaded]);
  }

  const unsubscribe = messages.subscribe((event) => {
    if (event.origin !== origin || event.source !== source) return;
    const decoded = decodeNativeHostEvent(event.data);

    if (decoded !== null) receive(decoded);
  });

  // Capture before the page is hidden: throttled frames may take a long time to answer after.
  const stopWatching = visibility?.subscribe(() => {
    if (visibility.hidden() && active() && opened && epoch > savedEpoch) flush("automatic");
  });

  const stopConnectivity = options.connectivity?.subscribe(() => retryPersistence(true));

  async function download() {
    try {
      const downloaded = await backend.download(document, { signal: abort.signal });

      if (!active()) return;
      bytes = copyEditorBytes(downloaded, document.maxBytes);

      if (bytes === null) throw new Error("Invalid native editor input");
      documentBytes = bytes.byteLength;
      sendOpen();
    } catch (cause) {
      if (active())
        stop(
          "failed",
          "Could not download the authorized document",
          cause instanceof Error && cause.message === "Invalid native editor input"
            ? "unsupported"
            : editorOpenFailure(cause),
        );
    }
  }

  // Ready covers fetching and compiling a large engine, which slow networks stretch the most.
  timer = wait(readyTimeoutMs * 4, () =>
    stop("failed", "The native editor did not become ready in time", "timeout"),
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
    dismiss() {
      if (
        status !== "save-failed" ||
        pending === null ||
        persisting ||
        pending.output.intent === "replace" ||
        pending.persisted !== undefined
      )
        return false;
      release(pending, null);

      return true;
    },
    getRecoveryOutputs: () =>
      [...recovered, ...(pending === null ? [] : [pending.output])].map((output) => ({
        ...output,
        bytes: new Uint8Array(output.bytes),
      })),
    dispose() {
      if (status === "disposed") return;
      cancelContinuations();
      waitingForNative = false;
      unsubscribe();
      stopWatching?.();
      stopConnectivity?.();
      abort.abort();
      scheduler?.cancel();
      clearTimeout(timer);
      clearTimeout(operationTimer);
      clearTimeout(themeTimer);
      clearTimeout(retryTimer);
      capture = null;
      stale = null;
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
