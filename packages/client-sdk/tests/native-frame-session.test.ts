import { afterEach, describe, expect, test } from "bun:test";
import { createEditorSession } from "@hyori-cloud/client-sdk";
import type {
  EditorBackendPort,
  EditorDocument,
  EditorMessageEvent,
  EditorSaveResult,
} from "@hyori-cloud/client-sdk";
import { decodeNativeHostCommand } from "@hyori-cloud/client-sdk/editor-runtime";
import type { NativeHostCommand } from "@hyori-cloud/client-sdk/editor-runtime";
import { createNativeHostProtocol } from "../../../tooling/artcraft/patches/native-host-v3/host-protocol";

// The real frame-side transport state machine, with the Rust engine reduced to a scripted model.
// Messages cross asynchronously and are structured-cloned, as postMessage does.

const origin = "https://cloud.example";
const version = "0.14.0-hyori-host.9";
const sessions: ReturnType<typeof createEditorSession>[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

async function until(condition: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;

  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("The session did not reach the expected state");
    await delay(2);
  }
}

type Capture =
  | { kind: "now" }
  | { kind: "late"; ms: number }
  | { kind: "error"; code: "busy" | "serialization-failed" };

function harness(options: { readyTimeoutMs?: number; hidden?: () => boolean } = {}) {
  const parent = {};
  const frameWindow = {};
  const listeners = new Set<(event: EditorMessageEvent) => void>();
  const commands: NativeHostCommand[] = [];
  const saves: Parameters<EditorBackendPort["save"]>[0][] = [];
  const applied: string[] = [];
  const finished: { intentId: string; ran: boolean }[] = [];
  const model = { revision: 1, dirty: false };
  const captures: Capture[] = [];
  const reconnectListeners = new Set<() => void>();
  let ignoreDiscard = false;
  let themeMs = 0;
  let pumping = false;

  let backendSave: EditorBackendPort["save"] = async () => ({
    status: "saved",
    revision: String(saves.length + 1),
  });

  const bridge = createNativeHostProtocol({
    app: "wordcraft",
    version,
    origin,
    parent,
    replacementExtensions: [".docx"],
    post(message) {
      const data = structuredClone(message);

      setTimeout(() => {
        for (const listener of listeners) listener({ origin, source: frameWindow, data });
      }, 0);
    },
    repaint: () => setTimeout(pump, 0),
  });

  /** One native frame: fences, acknowledgement, open, theme and capture, in Rust's order. */
  function pump() {
    if (pumping) return;
    pumping = true;

    try {
      bridge.takeCancellation();
      bridge.takeFailure();
      // Absent before the explicit discard was added: an old frame keeps its snapshot.
      bridge.takeDiscard?.();
      const ack = bridge.takeAcknowledgement();

      if (ack !== null) {
        if (!ack.saveAs && ack.revision === String(model.revision)) model.dirty = false;
        bridge.acknowledged(
          "7",
          String(model.revision),
          "7",
          String(model.revision),
          model.dirty || ack.revision !== String(model.revision),
        );

        if (ack.intentId !== undefined)
          finished.push({
            intentId: ack.intentId,
            ran: !ack.continuationCancelled && !ack.saveAs && !model.dirty,
          });
      }

      const open = bridge.takeOpen();

      if (open !== null) bridge.opened(open.openId, "7", "1");
      const theme = bridge.takeThemeRequest();

      if (theme !== null)
        setTimeout(() => {
          applied.push(theme.theme);
          bridge.themeApplied(
            theme.requestId,
            theme.theme,
            theme.theme === "dark" ? "dark" : "light",
          );
        }, themeMs);
      const request = bridge.takeSaveRequest();

      if (request !== null) {
        const behaviour = captures.shift() ?? { kind: "now" };
        const revision = String(model.revision);

        const serialize = () =>
          bridge.serialized({
            requestId: request.requestId,
            documentId: request.documentId,
            revision,
            name: request.name,
            bytes: new Uint8Array([model.revision, request.saveAs ? 1 : 0]),
            saveAs: request.saveAs,
          });

        if (behaviour.kind === "now") serialize();
        else if (behaviour.kind === "late") setTimeout(serialize, behaviour.ms);
        else
          bridge.serializationFailed(request.requestId, behaviour.code, "Native capture refused");
      }
    } finally {
      pumping = false;
    }
  }

  const document: EditorDocument = {
    app: "wordcraft",
    bridge: "hyori-correlated-host-v3",
    protocol: 3,
    sessionId: "native_session",
    version,
    assetUrl: `/artcraft/wordcraft/${version}/index.html?host=parent`,
    name: "Report.docx",
    revision: "1",
    writable: true,
    replacementName: "Report.docx",
    maxBytes: 1024,
    outputFormats: [
      { extension: ".docx", kind: "document" },
      { extension: ".pdf", kind: "export" },
    ],
  };

  const session = createEditorSession({
    backend: {
      open: async () => document,
      download: async () => new Uint8Array([1, 2, 3]),
      save(input, context) {
        saves.push(input);

        return backendSave(input, context);
      },
    },
    messages: {
      origin,
      source: frameWindow,
      subscribe(listener) {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
      post(message, _target, transfer) {
        const command = decodeNativeHostCommand(message);

        if (command === null) throw new Error("The host sent an invalid native command");
        commands.push(command);
        const data = structuredClone(message, { transfer });

        setTimeout(() => {
          if (ignoreDiscard && "status" in command && command.status === "discarded") return;
          bridge.receive({ origin, source: parent, data });
          pump();
        }, 0);
      },
    },
    maxBytes: 1024,
    readyTimeoutMs: options.readyTimeoutMs ?? 400,
    autosave: { idleMs: 5, maxWaitMs: 20 },
    theme: "system",
    visibility: { hidden: options.hidden ?? (() => false), subscribe: () => () => {} },
    connectivity: {
      subscribe(listener) {
        reconnectListeners.add(listener);

        return () => {
          reconnectListeners.delete(listener);
        };
      },
    },
  });

  sessions.push(session);

  return {
    session,
    bridge,
    commands,
    saves,
    applied,
    finished,
    captures,
    reconnect() {
      for (const listener of reconnectListeners) listener();
    },
    reconnectListeners,
    requests: () =>
      commands.filter(
        (command): command is Extract<NativeHostCommand, { type: `${string}:request-save` }> =>
          command.type.endsWith(":request-save"),
      ),
    setSave(save: EditorBackendPort["save"]) {
      backendSave = save;
    },
    setThemeDelay(ms: number) {
      themeMs = ms;
    },
    emulateFrameWithoutDiscard() {
      ignoreDiscard = true;
    },
    async open() {
      await delay(0);
      bridge.ready();
      await until(() => session.getSnapshot().status === "editing");
    },
    edit() {
      model.revision += 1;
      model.dirty = true;
      bridge.observe("7", String(model.revision), true);
    },
    nativeSave(intentId: string) {
      return bridge.saveRequested("7", false, undefined, intentId);
    },
  };
}

const sourceSaves = (h: ReturnType<typeof harness>) =>
  h.saves.filter((save) => save.output.intent === "replace");

describe("SDK against the real frame protocol state machine (scripted engine, not WASM)", () => {
  test("an unreachable save retries its exact snapshot then autosaves edits made during the outage", async () => {
    const h = harness();
    h.setSave(async () => ({ status: "failed", message: "Offline", retryable: true }));
    await h.open();
    h.edit();
    await until(() => h.session.getSnapshot().status === "save-failed");
    const first = structuredClone(h.saves[0]);
    h.edit();
    h.setSave(async () => ({ status: "saved", revision: String(h.saves.length + 1) }));
    await until(() => h.saves.length >= 3);
    await until(() => !h.session.getSnapshot().hasUnsavedChanges);
    expect(h.saves[1]).toEqual(first);
    expect(h.saves[2]?.saveId).not.toBe(first?.saveId);
    expect(h.requests()).toHaveLength(2);
    expect(h.session.getSnapshot().autosave.status).toBe("idle");
  });

  test("reconnect retries share a three-attempt budget and disposal unsubscribes", async () => {
    const h = harness();
    h.setSave(async () => ({ status: "failed", message: "Offline", retryable: true }));
    await h.open();
    h.edit();
    await until(() => h.session.getSnapshot().status === "save-failed");
    const first = structuredClone(h.saves[0]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.reconnect();
      await until(
        () => h.saves.length === attempt + 2 && h.session.getSnapshot().status === "save-failed",
      );
      expect(h.saves.at(-1)).toEqual(first);
    }

    h.reconnect();
    await delay(1100);
    expect(h.saves).toHaveLength(4);
    h.setSave(async () => ({ status: "saved", revision: "2" }));
    expect(h.session.retry()).toBe(true);
    await until(() => !h.session.getSnapshot().hasUnsavedChanges);
    h.session.dispose();
    expect(h.reconnectListeners.size).toBe(0);
  });

  for (const status of ["conflict", "access-ended", "failed"] as const) {
    test(`${status} without transport retry permission never retries on reconnect`, async () => {
      const h = harness();
      h.setSave(async () => ({ status, message: "Rejected", retryable: false }));
      await h.open();
      h.edit();
      await until(
        () => h.session.getSnapshot().status === (status === "failed" ? "save-failed" : status),
      );
      h.reconnect();
      await delay(1100);
      expect(h.saves).toHaveLength(1);
    });
  }

  for (const outcome of ["cancelled", "conflict"] as const) {
    test(`a ${outcome} copy releases its snapshot on both sides and autosave resumes`, async () => {
      const h = harness();
      h.setSave(async (input) =>
        input.output.intent === "replace"
          ? { status: "saved", revision: "2" }
          : ({ status: outcome, message: "Copy not saved" } satisfies EditorSaveResult),
      );
      await h.open();
      h.edit();
      expect(h.session.requestSave({ saveAs: true, name: "Report copy.docx" })).toBe(true);
      await until(() => h.saves.length === 1);
      await until(() => h.session.getSnapshot().status === "editing");
      // The declined copy's bytes are kept, never silently thrown away.
      expect(h.session.getRecoveryOutputs().map((output) => output.name)).toEqual([
        "Report copy.docx",
      ]);
      h.edit();
      await until(() => sourceSaves(h).length === 1);
      await until(() => !h.session.getSnapshot().hasUnsavedChanges);
      expect(h.bridge.hasRecoverySnapshot()).toBe(false);
    });
  }

  test("a frame that predates `discarded` is still freed for a declined copy", async () => {
    const h = harness();
    h.emulateFrameWithoutDiscard();
    h.setSave(async (input) =>
      input.output.intent === "replace"
        ? { status: "saved", revision: "2" }
        : { status: "cancelled", message: "No folder" },
    );
    await h.open();
    h.edit();
    h.session.requestSave({ saveAs: true, name: "Report copy.docx" });
    await until(() => h.saves.length === 1);
    h.edit();
    await until(() => sourceSaves(h).length === 1);
    await until(() => !h.session.getSnapshot().hasUnsavedChanges);
  });

  test("a capture that outlives its wait is still persisted, and saving resumes", async () => {
    const h = harness({ readyTimeoutMs: 60 });
    await h.open();
    h.captures.push({ kind: "late", ms: 150 });
    h.edit();
    await until(() => h.requests().length === 1);
    await until(() => h.session.getSnapshot().autosave.status === "paused");
    await until(() => sourceSaves(h).length === 1, 1000);
    await until(() => h.session.getSnapshot().status === "editing");
    h.edit();
    await until(() => sourceSaves(h).length === 2);
    await until(() => !h.session.getSnapshot().hasUnsavedChanges);
    expect(h.bridge.hasRecoverySnapshot()).toBe(false);
  });

  test("a hidden page never times out a capture", async () => {
    let hidden = true;
    const h = harness({ readyTimeoutMs: 40, hidden: () => hidden });
    await h.open();
    h.captures.push({ kind: "late", ms: 150 });
    h.edit();
    await until(() => h.requests().length === 1);
    await delay(100);
    expect(h.session.getSnapshot().autosave.status).toBe("serializing");
    hidden = false;
    await until(() => sourceSaves(h).length === 1);
  });

  test("native Ctrl+S after a capture failure saves instead of being refused", async () => {
    const h = harness();
    await h.open();
    h.captures.push({ kind: "error", code: "serialization-failed" });
    h.edit();
    await until(() => h.session.getSnapshot().autosave.status === "paused");
    expect(h.nativeSave("ctrl-s")).toBe(true);
    await until(() => sourceSaves(h).length === 1);
    expect(sourceSaves(h)[0]?.saveMode).toBe("manual");
    await until(() => h.finished.length === 1);
    expect(h.finished[0]).toEqual({ intentId: "ctrl-s", ran: true });
  });

  test("a manual Save pressed during a busy automatic capture stays manual", async () => {
    const h = harness();
    await h.open();
    h.captures.push({ kind: "error", code: "busy" });
    h.edit();
    await until(() => h.requests().length === 1);
    expect(h.requests()[0]?.reason).toBe("automatic");
    expect(h.session.requestSave()).toBe(true);
    await until(() => h.requests().length === 2);
    expect(h.requests()[1]?.reason).toBe("manual");
    await until(() => sourceSaves(h).length === 1);
    expect(sourceSaves(h)[0]?.saveMode).toBe("manual");
  });

  test("native Ctrl+S while an automatic capture owns the frame still saves", async () => {
    const h = harness();
    h.setSave(async () => {
      await delay(30);

      return { status: "saved", revision: String(h.saves.length + 1) };
    });
    await h.open();
    h.edit();
    await until(() => h.saves.length === 1);
    h.edit();
    // The frame refuses the intent itself while its snapshot slot is taken.
    expect(h.nativeSave("ctrl-s-busy")).toBe(false);
    await until(() => h.saves.filter((save) => save.saveMode === "manual").length === 1);
  });

  test("rapid theme changes settle on the last one chosen", async () => {
    const h = harness();
    h.setThemeDelay(20);
    await h.open();
    await until(() => h.applied.length === 1);
    h.session.setTheme("dark");
    h.session.setTheme("light");
    h.session.setTheme("dark");
    h.session.setTheme("light");
    await until(() => h.applied.at(-1) === "light");
    await delay(60);
    expect(h.applied.at(-1)).toBe("light");
  });
});
