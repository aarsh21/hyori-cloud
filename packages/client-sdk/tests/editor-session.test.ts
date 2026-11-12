import { describe, expect, test } from "bun:test";

import { createEditorSession } from "#client-sdk/features/editors/create-editor-session";
import type {
  BridgedArtCraftApp,
  EditorBackendPort,
  EditorDocument,
  EditorMessageEvent,
  EditorMessagePort,
  EditorSaveResult,
} from "#client-sdk/features/editors/editor-contract";

const origin = "https://cloud.example";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(app: BridgedArtCraftApp = "wordcraft", overrides: Partial<EditorDocument> = {}) {
  const source = {};
  const subscribers = new Set<(event: EditorMessageEvent) => void>();
  const posted: (Parameters<EditorMessagePort["post"]>[0] & { target: string })[] = [];
  const saves: Parameters<EditorBackendPort["save"]>[0][] = [];
  const signals: AbortSignal[] = [];

  const document: EditorDocument = {
    app,
    bridge: "upstream-host-parent",
    protocol: null,
    sessionId: "session-1",
    version: "1.2.3",
    assetUrl: `/artcraft/${app}/1.2.3/index.html?host=parent`,
    name: "Report.native",
    revision: "1",
    writable: true,
    replacementName: "Report.native",
    outputFormats: [
      { extension: ".native", kind: "document" },
      { extension: ".pdf", kind: "export" },
    ],
    maxBytes: 16,
    ...overrides,
  };

  let save: EditorBackendPort["save"] = async () => ({ status: "saved", revision: "2" });
  let open: EditorBackendPort["open"] = async () => document;
  let download: EditorBackendPort["download"] = async () => new Uint8Array([1, 2, 3]);

  const messages: EditorMessagePort = {
    origin,
    source,
    subscribe(listener) {
      subscribers.add(listener);

      return () => {
        subscribers.delete(listener);
      };
    },
    post(message, target) {
      posted.push({ ...message, target });
    },
  };

  const backend: EditorBackendPort = {
    open(options) {
      signals.push(options.signal);

      return open(options);
    },
    download(input, options) {
      signals.push(options.signal);

      return download(input, options);
    },
    save(input, options) {
      saves.push(input);
      signals.push(options.signal);

      return save(input, options);
    },
  };

  function emit(data: EditorMessageEvent["data"], from = source, eventOrigin = origin) {
    for (const listener of subscribers) listener({ data, source: from, origin: eventOrigin });
  }

  return {
    document,
    backend,
    messages,
    saves,
    signals,
    posted,
    subscribers,
    emit,
    setSave: (next: EditorBackendPort["save"]) => {
      save = next;
    },
    setOpen: (next: EditorBackendPort["open"]) => {
      open = next;
    },
    setDownload: (next: EditorBackendPort["download"]) => {
      download = next;
    },
    ready: () => emit({ type: `${app}:ready`, version: document.version }),
    dirty: (dirty: boolean) => emit({ type: `${app}:dirty`, dirty }),
    output: (bytes = new Uint8Array([4, 5]), name = document.name, saveAs = false) =>
      emit({ type: `${app}:save`, name, bytes, saveAs }),
  };
}

function attach(f: ReturnType<typeof fixture>, readyTimeoutMs = 1000) {
  return createEditorSession({
    backend: f.backend,
    messages: f.messages,
    maxBytes: 32,
    readyTimeoutMs,
  });
}

describe("ArtCraft local protocol (fake ports; not WASM/fidelity evidence)", () => {
  for (const app of ["wordcraft", "gridcraft", "pdfcraft"] as const) {
    test(`${app}: waits for ready, pins source/origin, and posts exact-origin open once`, async () => {
      const f = fixture(app);
      const session = attach(f);
      await tick();
      expect(session.getSnapshot().status).toBe("opening");
      f.emit({ type: `${app}:ready`, version: f.document.version }, {}, origin);
      f.emit(
        { type: `${app}:ready`, version: f.document.version },
        f.messages.source,
        "https://attacker.example",
      );
      f.emit({ type: `${app}:ready`, version: f.document.version }, f.messages.source, "null");
      expect(f.posted).toHaveLength(0);
      f.ready();
      expect(f.posted).toEqual([
        {
          type: `${app}:open`,
          name: "Report.native",
          bytes: new Uint8Array([1, 2, 3]),
          target: origin,
        },
      ]);
      expect(session.getSnapshot().status).toBe("editing");
      f.emit(
        { type: `${app}:save`, name: f.document.name, bytes: new Uint8Array([9]), saveAs: false },
        {},
      );
      f.emit(
        { type: `${app}:save`, name: f.document.name, bytes: new Uint8Array([9]), saveAs: false },
        f.messages.source,
        "https://attacker.example",
      );
      expect(f.saves).toHaveLength(0);
      session.dispose();
    });

    test(`${app}: accepts the actual upstream save payload`, async () => {
      const f = fixture(app);
      const session = attach(f);
      await tick();
      f.ready();

      const message = {
        type: `${app}:save`,
        name: f.document.name,
        bytes: new Uint8Array([7]).buffer,
      };

      f.emit(app === "gridcraft" ? message : { ...message, saveAs: false });
      await tick();
      expect(f.saves[0]?.output.intent).toBe("replace");
      expect(session.getSnapshot().document?.revision).toBe("2");
      expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
      session.dispose();
    });
  }

  test("captures ready before backend open completes without buffering document messages", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<EditorDocument>();
    f.setOpen(() => pending.promise);
    const session = attach(f);
    f.ready();
    f.output();
    pending.resolve(f.document);
    await tick();
    expect(f.posted).toHaveLength(1);
    expect(f.saves).toHaveLength(0);
    session.dispose();
  });

  test("rejects mismatched assets and unapproved DeckCraft versions", async () => {
    const f = fixture();
    const session = attach(f);
    f.emit({ type: "wordcraft:ready", version: "unapproved-version" });
    await tick();
    expect(session.getSnapshot().status).toBe("failed");
    expect(f.posted).toHaveLength(0);
    session.dispose();

    const deck = fixture();
    // Simulate a broken backend binding at runtime, without weakening the SDK contract.
    deck.setOpen(async () => JSON.parse(JSON.stringify({ ...deck.document, app: "deckcraft" })));
    const blocked = attach(deck);
    await tick();
    expect(blocked.getSnapshot().status).toBe("failed");
    expect(deck.posted).toHaveLength(0);
    blocked.dispose();
  });

  test("bounds and validates names, bytes, dirty, error and saveAs envelopes", async () => {
    const f = fixture();
    const session = attach(f);
    await tick();
    f.ready();

    const invalid = [
      { name: "../escape.native", bytes: new Uint8Array([1]), saveAs: false },
      { name: "sub\\escape.native", bytes: new Uint8Array([1]), saveAs: false },
      { name: "x\u0000.native", bytes: new Uint8Array([1]), saveAs: false },
      { name: "x".repeat(256), bytes: new Uint8Array([1]), saveAs: false },
      { name: f.document.name, bytes: new Uint8Array(17), saveAs: false },
      { name: f.document.name, bytes: new Uint8Array(0), saveAs: false },
      { name: f.document.name, bytes: [1, 2], saveAs: false },
      { name: f.document.name, bytes: new Int32Array([1]), saveAs: false },
      { name: f.document.name, bytes: new Uint8Array(new SharedArrayBuffer(2)), saveAs: false },
      { name: f.document.name, bytes: new Uint8Array([1]), saveAs: "false" },
      { name: f.document.name, bytes: new Uint8Array([1]) },
    ];

    for (const payload of invalid) f.emit({ type: "wordcraft:save", ...payload });
    f.emit({ type: "wordcraft:dirty", dirty: "false" });
    f.emit({ type: "wordcraft:failed", error: "x".repeat(2049) });
    f.emit({
      type: "pdfcraft:save",
      name: f.document.name,
      bytes: new Uint8Array([1]),
      saveAs: false,
    });
    f.emit(null);
    expect(f.saves).toHaveLength(0);
    expect(session.getSnapshot().message).toContain("invalid or oversized");
    expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
    session.dispose();
  });

  test("copies only a Uint8Array's selected byte range", async () => {
    const f = fixture();
    const session = attach(f);
    await tick();
    f.ready();
    const source = new Uint8Array([90, 4, 5, 91]);
    f.output(source.subarray(1, 3));
    source.fill(0);
    await tick();
    expect(f.saves[0]?.output.bytes).toEqual(new Uint8Array([4, 5]));
    session.dispose();
  });

  test("retains failed bytes, ignores child clean, and retries unchanged against the open revision", async () => {
    const f = fixture();
    f.setSave(async (input) => {
      input.output.bytes.fill(0);
      throw new Error("offline");
    });
    const session = attach(f);
    await tick();
    f.ready();
    f.dirty(true);
    f.output();
    f.dirty(false);
    await tick();
    expect(session.getSnapshot()).toMatchObject({
      status: "save-failed",
      hasUnsavedChanges: true,
      pendingSaveCount: 1,
    });
    expect(session.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([4, 5]));
    f.setSave(async () => ({ status: "saved", revision: "3" }));
    expect(session.retry()).toBe(true);
    await tick();
    expect(f.saves[1]?.expectedRevision).toBe("1");
    expect(f.saves[0]?.saveId).toBeString();
    expect(f.saves[1]?.saveId).toBe(f.saves[0]?.saveId);
    expect(f.saves[1]?.output.bytes).toEqual(new Uint8Array([4, 5]));
    expect(session.getSnapshot()).toMatchObject({
      status: "editing",
      hasUnsavedChanges: false,
      pendingSaveCount: 0,
    });
    session.dispose();
  });

  test("serializes saves and coalesces queued whole-document replacements with the latest revision", async () => {
    const f = fixture();
    const first = Promise.withResolvers<EditorSaveResult>();
    f.setSave(() => first.promise);
    const session = attach(f);
    await tick();
    f.ready();
    f.output(new Uint8Array([1]));

    for (let value = 2; value <= 10; value += 1) f.output(new Uint8Array([value]));
    expect(f.saves).toHaveLength(1);
    expect(session.getSnapshot().pendingSaveCount).toBe(2);
    f.setSave(async () => ({ status: "saved", revision: "3" }));
    first.resolve({ status: "saved", revision: "2" });
    await tick();
    expect(f.saves).toHaveLength(2);
    expect(f.saves[1]?.expectedRevision).toBe("2");
    expect(f.saves[1]?.saveId).not.toBe(f.saves[0]?.saveId);
    expect(f.saves[1]?.output.bytes).toEqual(new Uint8Array([10]));
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
    session.dispose();
  });

  test("never coalesces distinct copies/exports and bounds retained output work", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<EditorSaveResult>();
    f.setSave(() => pending.promise);
    const session = attach(f);
    await tick();
    f.ready();
    f.output(new Uint8Array([1]), "Report.pdf");
    f.output(new Uint8Array([2]), "Copy.pdf");
    f.output(new Uint8Array([3]), "Third.pdf");
    expect(f.saves).toHaveLength(1);
    expect(session.getRecoveryOutputs().map((output) => output.name)).toEqual([
      "Report.pdf",
      "Copy.pdf",
    ]);
    expect(session.getSnapshot().message).toContain("queue is full");
    session.dispose();
    pending.resolve({ status: "saved", revision: "2" });
    await tick();
  });

  for (const app of ["wordcraft", "gridcraft", "pdfcraft"] as const) {
    test(`${app}: server-owned format rules distinguish export and copy from replacement`, async () => {
      const f = fixture(app);
      const session = attach(f);
      await tick();
      f.ready();
      f.dirty(true);
      f.output(new Uint8Array([1]), "Report.pdf");
      await tick();
      expect(f.saves[0]?.output.intent).toBe("export");
      expect(session.getSnapshot().document?.revision).toBe("1");
      expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
      f.output(new Uint8Array([2]), "Copy.native", app !== "gridcraft");
      await tick();
      expect(f.saves[1]?.output.intent).toBe("save-as");
      expect(f.saves[1]?.expectedRevision).toBe("1");
      expect(session.getSnapshot().document?.revision).toBe("1");
      expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
      f.output(new Uint8Array([3]), "Report.html");
      expect(f.saves).toHaveLength(2);
      session.dispose();
    });
  }

  test("Save As permanently detaches the child's replacement identity, even with the original name", async () => {
    const f = fixture();
    const session = attach(f);
    await tick();
    f.ready();
    f.output(new Uint8Array([1]), f.document.name, true);
    await tick();
    f.output(new Uint8Array([2]), f.document.name, false);
    await tick();
    expect(f.saves.map((save) => save.output.intent)).toEqual(["save-as", "save-as"]);
    expect(session.getSnapshot().document?.revision).toBe("1");
    session.dispose();
  });

  for (const status of ["conflict", "read-only", "access-ended"] as const) {
    test(`${status}: retains recovery bytes and refuses blind retry or additional writes`, async () => {
      const f = fixture();
      f.setSave(async () => ({ status, message: "Access changed" }));
      const session = attach(f);
      await tick();
      f.ready();
      f.output();
      await tick();
      expect(session.getSnapshot().status).toBe(status);
      expect(session.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([4, 5]));
      expect(session.retry()).toBe(false);
      f.output(new Uint8Array([8]));
      await tick();
      expect(f.saves).toHaveLength(1);
      session.dispose();
    });
  }

  test("read-only open permits viewing and recovery but never invokes persistence", async () => {
    const f = fixture("wordcraft", { writable: false });
    const session = attach(f);
    await tick();
    f.ready();
    expect(session.getSnapshot().status).toBe("read-only");
    f.dirty(true);
    f.output();
    expect(f.saves).toHaveLength(0);
    expect(session.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([4, 5]));
    session.dispose();
  });

  test("read-only explicit copies and exports persist without granting replacement", async () => {
    const f = fixture("wordcraft", { writable: false });
    const session = attach(f);

    try {
      await tick();
      f.ready();
      f.dirty(true);
      f.output(new Uint8Array([4, 5]), "Copy.native", true);
      await tick();
      expect(f.saves[0]?.output.intent).toBe("save-as");
      expect(session.getSnapshot()).toMatchObject({
        status: "read-only",
        document: { writable: false, revision: "1" },
        hasUnsavedChanges: false,
        pendingSaveCount: 0,
      });
      f.dirty(true);
      f.output(new Uint8Array([6]), "Copy.pdf");
      await tick();
      expect(f.saves[1]?.output.intent).toBe("export");
      expect(session.getSnapshot()).toMatchObject({
        status: "read-only",
        document: { writable: false, revision: "1" },
        hasUnsavedChanges: true,
        pendingSaveCount: 0,
      });
    } finally {
      session.dispose();
    }
  });

  test("explicit copy supersedes a locally blocked read-only replacement", async () => {
    const f = fixture("wordcraft", { writable: false });
    const session = attach(f);

    try {
      await tick();
      f.ready();
      f.output();
      expect(f.saves).toHaveLength(0);
      f.output(new Uint8Array([8, 9]), "Copy.native", true);
      await tick();
      expect(f.saves).toHaveLength(1);
      expect(f.saves[0]?.output).toMatchObject({
        name: "Copy.native",
        intent: "save-as",
        bytes: new Uint8Array([8, 9]),
      });
      expect(session.getSnapshot().pendingSaveCount).toBe(0);
      expect(session.getSnapshot().status).toBe("read-only");
    } finally {
      session.dispose();
    }
  });

  test("read-only non-replacement queue drains serially after a confirmed save", async () => {
    const f = fixture("wordcraft", { writable: false });
    const pending = Promise.withResolvers<EditorSaveResult>();
    f.setSave(() => pending.promise);
    const session = attach(f);

    try {
      await tick();
      f.ready();
      f.output(new Uint8Array([1]), "First.pdf");
      f.output(new Uint8Array([2]), "Second.pdf");
      expect(f.saves).toHaveLength(1);
      expect(session.getSnapshot().pendingSaveCount).toBe(2);
      f.setSave(async () => ({ status: "saved", revision: "3" }));
      pending.resolve({ status: "saved", revision: "2" });
      await tick();
      expect(f.saves.map((save) => save.output.name)).toEqual(["First.pdf", "Second.pdf"]);
      expect(session.getSnapshot()).toMatchObject({ status: "read-only", pendingSaveCount: 0 });
    } finally {
      pending.resolve({ status: "saved", revision: "2" });
      session.dispose();
    }
  });

  test("an edit made after a save starts remains unsaved after persistence succeeds", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<EditorSaveResult>();
    f.setSave(() => pending.promise);
    const session = attach(f);
    await tick();
    f.ready();
    f.dirty(true);
    f.output();
    f.dirty(false);
    f.dirty(true);
    pending.resolve({ status: "saved", revision: "2" });
    await tick();
    expect(session.getSnapshot()).toMatchObject({ status: "editing", hasUnsavedChanges: true });
    session.dispose();
  });

  test("disposal cancels download, removes listeners and ignores late completion", async () => {
    const f = fixture();
    const download = Promise.withResolvers<Uint8Array>();
    f.setDownload(() => download.promise);
    const session = attach(f);
    await tick();
    f.ready();
    session.dispose();
    download.resolve(new Uint8Array([1]));
    await tick();
    expect(f.subscribers.size).toBe(0);
    expect(f.signals.every((signal) => signal.aborted)).toBe(true);
    expect(f.posted).toHaveLength(0);
    expect(session.getSnapshot().status).toBe("disposed");
  });

  test("disposal during persistence retains bytes and does not accept its late revision", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<EditorSaveResult>();
    f.setSave(() => pending.promise);
    const session = attach(f);
    await tick();
    f.ready();
    f.output();
    session.dispose();
    pending.resolve({ status: "saved", revision: "too-late" });
    await tick();
    expect(session.getSnapshot().document?.revision).toBe("1");
    const recovery = session.getRecoveryOutputs();
    recovery[0]?.bytes.fill(0);
    expect(session.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([4, 5]));
    expect(f.signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("controller disposal retires its bound backend only once without erasing recovery", async () => {
    const f = fixture();
    let closes = 0;
    f.backend.close = async () => {
      closes += 1;
    };

    f.setSave(async () => ({ status: "conflict", message: "Changed baseline" }));
    const session = attach(f);
    await tick();
    f.ready();
    f.output();
    await tick();
    session.dispose();
    session.dispose();
    await tick();
    expect(closes).toBe(1);
    expect(session.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([4, 5]));
  });

  test("a restarted frame fails closed without replaying open over unsaved output", async () => {
    const f = fixture();
    const session = attach(f);
    await tick();
    f.ready();
    f.dirty(true);
    f.ready();
    expect(session.getSnapshot()).toMatchObject({ status: "failed", hasUnsavedChanges: true });
    expect(f.posted).toHaveLength(1);
    session.dispose();
  });

  test("ready timeout is bounded, but ready during a slow download satisfies it", async () => {
    const f = fixture();
    const session = attach(f, 5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(session.getSnapshot().status).toBe("failed");
    session.dispose();
    const slow = fixture();
    const download = Promise.withResolvers<Uint8Array>();
    slow.setDownload(() => download.promise);
    const attached = attach(slow, 5);
    await tick();
    slow.ready();
    await new Promise((resolve) => setTimeout(resolve, 15));
    download.resolve(new Uint8Array([1]));
    await tick();
    expect(attached.getSnapshot().status).toBe("editing");
    attached.dispose();
  });

  test("pins attachment origin and window identity even if the injected port object changes", async () => {
    const f = fixture();
    const session = attach(f);
    await tick();
    const attacker = {};
    f.messages.origin = "https://attacker.example";
    f.messages.source = attacker;
    f.emit(
      { type: "wordcraft:ready", version: f.document.version },
      attacker,
      "https://attacker.example",
    );
    expect(f.posted).toHaveLength(0);
    f.ready();
    expect(f.posted[0]?.target).toBe(origin);
    session.dispose();
  });

  test("subscriber disposal during open or save prevents later capability calls", async () => {
    const f = fixture();
    const session = attach(f, 5);
    session.subscribe(() => {
      if (session.getSnapshot().document) session.dispose();
    });
    await tick();
    expect(f.signals).toHaveLength(1);
    expect(session.getSnapshot().status).toBe("disposed");
    const saving = fixture();
    const attached = attach(saving);
    await tick();
    saving.ready();
    attached.subscribe(() => {
      if (attached.getSnapshot().status === "saving") attached.dispose();
    });
    saving.output();
    expect(saving.saves).toHaveLength(0);
    expect(attached.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([4, 5]));
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(session.getSnapshot().status).toBe("disposed");
  });

  test("legacy assets remain manual even with autosave requested, and only source commits timestamp", async () => {
    const f = fixture();

    const session = createEditorSession({
      backend: f.backend,
      messages: f.messages,
      maxBytes: 32,
      autosave: { idleMs: 5, maxWaitMs: 10 },
    });

    await tick();
    f.ready();
    expect(session.getSnapshot().autosave).toEqual({ status: "disabled", reason: "unsupported" });
    expect(session.requestSave()).toBe(false);
    expect(session.setTheme("dark")).toBe(false);
    f.dirty(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(f.saves).toHaveLength(0);
    f.output();
    await tick();
    const committedAt = session.getSnapshot().lastSavedAt;

    expect(committedAt).toBeNumber();
    f.output(new Uint8Array([8]), "Copy.native", true);
    await tick();
    expect(session.getSnapshot().lastSavedAt).toBe(committedAt);
    f.output(new Uint8Array([9]), "Export.pdf", false);
    await tick();
    expect(session.getSnapshot().lastSavedAt).toBe(committedAt);
    session.dispose();
  });

  test("invalid target origins are rejected before any subscription or backend call", () => {
    const f = fixture();

    for (const invalid of [
      "*",
      "null",
      "https://cloud.example/",
      "https://cloud.example/path",
      "file://",
    ]) {
      expect(() =>
        createEditorSession({
          backend: f.backend,
          messages: { ...f.messages, origin: invalid },
          maxBytes: 32,
        }),
      ).toThrow();
    }

    expect(f.subscribers.size).toBe(0);
    expect(f.signals).toHaveLength(0);
  });
});
