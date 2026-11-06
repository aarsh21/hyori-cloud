import { afterEach, describe, expect, test } from "bun:test";
import { createEditorSession } from "@hyori-cloud/client-sdk";
import type {
  EditorBackendPort,
  EditorDocument,
  EditorMessageEvent,
  EditorMessagePort,
  EditorSaveResult,
  EditorSessionOptions,
} from "@hyori-cloud/client-sdk";
import { decodeNativeHostCommand } from "@hyori-cloud/client-sdk/editor-runtime";
import type { NativeHostCommand, NativeHostEvent } from "@hyori-cloud/client-sdk/editor-runtime";

type Command<Operation extends string> = Extract<
  NativeHostCommand,
  { type: `${string}:${Operation}` }
>;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sessions: ReturnType<typeof createEditorSession>[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

async function until(condition: () => boolean) {
  const deadline = Date.now() + 1500;

  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Native session did not reach the expected state");
    await delay(2);
  }
}

function fixture(
  overrides: Partial<EditorDocument> = {},
  autosave: EditorSessionOptions["autosave"] = { idleMs: 8, maxWaitMs: 35 },
) {
  const source = {};
  const listeners = new Set<(event: EditorMessageEvent) => void>();
  const commands: NativeHostCommand[] = [];
  const requests: Command<"request-save">[] = [];
  const saves: Parameters<EditorBackendPort["save"]>[0][] = [];

  const document: EditorDocument = {
    app: "wordcraft",
    bridge: "hyori-correlated-host-v2",
    protocol: 2,
    sessionId: "native_session",
    version: "0.14.0-hyori-host.3",
    assetUrl: "/artcraft/wordcraft/0.14.0-hyori-host.3/index.html?host=parent",
    name: "Synthetic.native",
    revision: "1",
    writable: true,
    replacementName: "Synthetic.native",
    maxBytes: 128,
    outputFormats: [
      { extension: ".native", kind: "document", maxBytes: 64 },
      { extension: ".pdf", kind: "export" },
    ],
    ...overrides,
  };

  const envelope = { protocol: 2, version: document.version } as const;
  let openId = "";
  let nativeRevision = "1";
  let nativeDocumentId = "7";
  let failCancel = false;
  const continuations = new Map<string, string>();
  const cancelledIntents = new Set<string>();
  const executedIntents: string[] = [];
  let sequence = 0;
  let ack = true;
  let ackDirty = false;
  let bumpedRevision: string | null = null;

  let backendSave: EditorBackendPort["save"] = async () => ({
    status: "saved",
    revision: String(saves.length + 1),
  });

  function emit(
    data: EditorMessageEvent["data"],
    sender = source,
    origin = "https://cloud.example",
  ) {
    for (const listener of listeners) listener({ data, origin, source: sender });
  }

  const messages: EditorMessagePort = {
    source,
    origin: "https://cloud.example",
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    post(message) {
      const command = decodeNativeHostCommand(message);

      if (command === null) throw new Error("The host sent an invalid native command");
      commands.push(command);

      if ("reason" in command) {
        requests.push(command);

        if (command.intentId !== undefined) continuations.set(command.requestId, command.intentId);
      } else if ("intentId" in command) {
        if (failCancel) throw new Error("Cancel post failed");
        cancelledIntents.add(command.intentId);
      }

      if (command.type.endsWith(":save-result") && "fileRevision" in command && ack) {
        const intentId = continuations.get(command.requestId);

        if (intentId !== undefined && !cancelledIntents.has(intentId))
          executedIntents.push(intentId);
        continuations.delete(command.requestId);
        emit({
          ...envelope,
          type: `${document.app}:saved`,
          openId: command.openId,
          documentId: command.documentId,
          revision: command.revision,
          requestId: command.requestId,
          saveId: command.saveId,
          currentRevision: bumpedRevision ?? nativeRevision,
          dirty: ackDirty,
        } satisfies NativeHostEvent);
      }
    },
  };

  const backend: EditorBackendPort = {
    open: async () => document,
    download: async () => new Uint8Array([1, 2]),
    save(input, options) {
      saves.push(input);

      return backendSave(input, options);
    },
  };

  const session = createEditorSession({
    backend,
    messages,
    maxBytes: 128,
    readyTimeoutMs: 250,
    autosave,
    theme: "dark",
  });

  sessions.push(session);

  const ready = () =>
    emit({
      ...envelope,
      type: `${document.app}:ready`,
      maxBytes: 128,
      capabilities: {
        serialize: true,
        parsedOpen: true,
        documentRevision: true,
        durableSaveAck: true,
        theme: true,
      },
    } satisfies NativeHostEvent);

  async function open() {
    await tick();

    if (!commands.some((command) => "bytes" in command)) ready();
    const command = commands.find((value): value is Command<"open"> => "bytes" in value);

    if (command === undefined) throw new Error("No native open");
    openId = command.openId;
    emit({
      ...envelope,
      type: `${document.app}:opened`,
      openId,
      documentId: nativeDocumentId,
      revision: nativeRevision,
    } satisfies NativeHostEvent);
  }

  function dirty(next = String(BigInt(nativeRevision) + 1n)) {
    nativeRevision = next;
    emit({
      ...envelope,
      type: `${document.app}:dirty`,
      openId,
      documentId: nativeDocumentId,
      revision: nativeRevision,
      dirty: true,
    } satisfies NativeHostEvent);
  }

  function output(
    request = requests.at(-1),
    bytes = new Uint8Array([3, 4]),
    revision = nativeRevision,
  ) {
    if (request === undefined) throw new Error("No capture requested");
    sequence += 1;

    const event: Extract<NativeHostEvent, { type: `${string}:save` }> = {
      ...envelope,
      type: `${document.app}:save`,
      openId,
      documentId: request.documentId,
      requestId: request.requestId,
      saveId: `${openId}:${sequence}`,
      revision,
      name: request.name ?? document.name,
      bytes,
      saveAs: request.saveAs === true,
    };

    emit(event);

    return event;
  }

  return {
    session,
    document,
    commands,
    requests,
    saves,
    emit,
    ready,
    open,
    dirty,
    output,
    listeners,
    cancelledIntents,
    executedIntents,
    failCancel: (value: boolean) => {
      failCancel = value;
    },
    nativeIntent(intentId: string, name?: string) {
      const event: Extract<NativeHostEvent, { type: `${string}:save-requested` }> = {
        ...envelope,
        type: `${document.app}:save-requested`,
        openId,
        documentId: nativeDocumentId,
        intentId,
        saveAs: name !== undefined,
      };

      if (name !== undefined) Object.assign(event, { name });
      emit(event);
    },
    observe(next: string, dirty: boolean) {
      nativeRevision = next;
      emit({
        ...envelope,
        type: `${document.app}:dirty`,
        openId,
        documentId: nativeDocumentId,
        revision: next,
        dirty,
      } satisfies NativeHostEvent);
    },
    changeDocument(id: string, next = "1", dirty = false) {
      nativeDocumentId = id;
      nativeRevision = next;
      emit({
        ...envelope,
        type: `${document.app}:dirty`,
        openId,
        documentId: id,
        revision: next,
        dirty,
      } satisfies NativeHostEvent);
    },
    identity: () => ({
      ...envelope,
      openId,
      documentId: nativeDocumentId,
      revision: nativeRevision,
    }),
    setSave: (save: EditorBackendPort["save"]) => {
      backendSave = save;
    },
    setAck: (enabled: boolean, dirty = false, bump: string | null = null) => {
      ack = enabled;
      ackDirty = dirty;
      bumpedRevision = bump;
    },
  };
}

describe("protocol2 autosave through the public SDK (synthetic ports, not native runtime acceptance)", () => {
  test("gates on both authorized descriptor and strict protocol2 ready", async () => {
    const f = fixture();

    await tick();
    f.emit({ type: "wordcraft:ready", version: f.document.version });
    expect(f.commands).toHaveLength(0);
    expect(f.session.getSnapshot().autosave).toEqual({ status: "disabled", reason: "unsupported" });
    await f.open();
    expect(f.session.getSnapshot().autosave).toEqual({ status: "idle" });
    expect(f.session.getSnapshot().lastSavedAt).toBeNull();
  });

  test("coalesces a dirty burst, captures automatically, and marks saved only after durable source save", async () => {
    const f = fixture();
    const durable = Promise.withResolvers<EditorSaveResult>();

    f.setSave(() => durable.promise);
    await f.open();
    f.dirty();
    f.dirty();
    f.dirty();
    expect(f.session.getSnapshot().autosave.status).toBe("scheduled");
    await until(() => f.requests.length === 1);
    expect(f.requests[0]?.reason).toBe("automatic");
    expect(f.session.getSnapshot().autosave.status).toBe("serializing");
    f.output();
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]?.saveMode).toBe("automatic");
    expect(f.session.getSnapshot().status).toBe("saving");
    expect(f.session.getSnapshot().lastSavedAt).toBeNull();
    durable.resolve({ status: "saved", revision: "2" });
    await tick();
    expect(f.session.getSnapshot()).toMatchObject({
      status: "editing",
      hasUnsavedChanges: false,
      pendingSaveCount: 0,
      document: { revision: "2" },
      autosave: { status: "idle" },
    });
    expect(f.session.getSnapshot().lastSavedAt).toBeNumber();
  });

  test("continuous dirty true→true observations cannot postpone capture beyond maxWait", async () => {
    const f = fixture({}, { idleMs: 20, maxWaitMs: 50 });

    await f.open();

    for (let index = 0; index < 12 && f.requests.length === 0; index += 1) {
      f.dirty();
      await delay(8);
    }

    expect(f.requests).toHaveLength(1);
  });

  test("an older acknowledgement never clears a newer draft; latest capture follows serially", async () => {
    const f = fixture();
    const durable = Promise.withResolvers<EditorSaveResult>();

    f.setSave(() => durable.promise);
    await f.open();
    f.dirty("18446744073709551610");
    f.session.requestSave();
    f.output();
    f.dirty("3");
    f.dirty("3");
    await delay(20);
    expect(f.requests).toHaveLength(1);
    durable.resolve({ status: "saved", revision: "2" });
    await tick();
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(true);
    await until(() => f.requests.length === 2);
    expect(f.saves).toHaveLength(1);
    expect(f.requests[1]?.reason).toBe("automatic");
  });

  test("manual flush can settle drafts and adopt an exact Pdf post-ack clock bump", async () => {
    const f = fixture({ app: "pdfcraft", version: "0.17.0-hyori-host.3" });

    await f.open();
    f.dirty("2");
    expect(f.session.requestSave()).toBe(true);
    expect(f.requests[0]?.reason).toBe("manual");
    // Native manual settling changes the opaque clock before returning its coherent snapshot.
    f.dirty("7");
    f.setAck(true, false, "8");
    f.output();
    await tick();
    expect(f.saves[0]?.saveMode).toBe("manual");
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(false);
    f.emit({
      ...f.identity(),
      type: "pdfcraft:dirty",
      revision: "8",
      dirty: false,
    } satisfies NativeHostEvent);
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  test("failed persistence retains exact bytes and backend ID; retry never recaptures", async () => {
    const f = fixture();

    f.setSave(async () => {
      throw new Error("lost persistence reply");
    });
    await f.open();
    f.dirty();
    f.session.requestSave();
    f.output();
    await tick();
    const before = f.saves[0];

    expect(f.session.getSnapshot()).toMatchObject({
      status: "save-failed",
      autosave: { status: "paused", reason: "save-failed" },
      pendingSaveCount: 1,
      lastSavedAt: null,
    });
    f.dirty();
    await delay(25);
    expect(f.requests).toHaveLength(1);
    expect(f.session.requestSave()).toBe(false);
    f.session.getRecoveryOutputs()[0]?.bytes.fill(0);
    expect(f.session.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([3, 4]));
    f.setSave(async () => ({ status: "saved", revision: "2" }));
    expect(f.session.retry()).toBe(true);
    await tick();
    expect(f.saves[1]).toEqual(before);
    expect(f.requests).toHaveLength(1);
  });

  test("an acknowledgement failure retries the durable result without a second backend write", async () => {
    const f = fixture();

    f.setAck(false);
    await f.open();
    f.dirty();
    f.session.requestSave();
    f.output();
    await until(() => f.session.getSnapshot().status === "save-failed");
    expect(f.session.getSnapshot().lastSavedAt).toBeNumber();
    f.setAck(true);
    expect(f.session.retry()).toBe(true);
    await tick();
    expect(f.saves).toHaveLength(1);
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  for (const outcome of ["conflict", "access-ended"] as const) {
    test(`${outcome} stops automatic work and refuses blind recapture/retry`, async () => {
      const f = fixture();

      f.setSave(async () => ({ status: outcome, message: "Authority ended" }));
      await f.open();
      f.dirty();
      f.session.requestSave();
      f.output();
      await tick();
      expect(f.session.getSnapshot().status).toBe(outcome);
      expect(f.session.requestSave()).toBe(false);
      expect(f.session.retry()).toBe(false);
      f.dirty();
      await delay(20);
      expect(f.requests).toHaveLength(1);
      expect(f.session.getRecoveryOutputs()).toHaveLength(1);
    });
  }

  test("serialization failure pauses; explicit requestSave captures afresh without fake backend retry", async () => {
    const f = fixture();

    await f.open();
    f.dirty();
    await until(() => f.requests.length === 1);
    f.emit({
      protocol: 2,
      version: f.document.version,
      type: "wordcraft:error",
      operation: "save",
      requestId: f.requests[0]?.requestId,
      code: "serialization-failed",
      message: "Native capture failed",
    });
    expect(f.session.getSnapshot().autosave).toEqual({
      status: "paused",
      reason: "serialization-failed",
    });
    expect(f.session.getSnapshot().pendingSaveCount).toBe(0);
    expect(f.session.retry()).toBe(false);
    await delay(20);
    expect(f.requests).toHaveLength(1);
    expect(f.session.requestSave()).toBe(true);
    expect(f.requests[1]?.reason).toBe("manual");
    f.output();
    await tick();
    expect(f.saves).toHaveLength(1);
  });

  for (const safePoint of ["Enter", "IME cancel"] as const) {
    test(`long native draft defers after busy3 and ${safePoint} resumes automatic durability without manual retry`, async () => {
      const f = fixture({ app: "gridcraft", version: "0.15.0-hyori-host.3" });
      await f.open();
      f.dirty();

      for (let count = 1; count <= 3; count += 1) {
        await until(() => f.requests.length === count);
        const request = f.requests[count - 1];
        expect(request?.reason).toBe("automatic");
        // The live draft outlasts the configured maxWait without being forcibly settled.
        await delay(40);
        f.emit({
          protocol: 2,
          version: f.document.version,
          type: "gridcraft:error",
          operation: "save",
          requestId: request?.requestId,
          code: "busy",
          message: "Draft input is active",
        });
      }

      expect(f.session.getSnapshot().autosave).toEqual({
        status: "waiting",
        reason: "native-busy",
      });
      await delay(45);
      expect(f.requests).toHaveLength(3);
      expect(f.saves).toHaveLength(0);
      f.observe("2", false); // The same token is not a new safe point.
      await delay(20);
      expect(f.requests).toHaveLength(3);
      f.observe("3", safePoint === "Enter");
      expect(f.session.getSnapshot().hasUnsavedChanges).toBe(true);
      await until(() => f.requests.length === 4);
      expect(f.requests[3]?.reason).toBe("automatic");
      f.output();
      await tick();
      expect(f.saves).toHaveLength(1);
      expect(f.session.getSnapshot()).toMatchObject({
        status: "editing",
        hasUnsavedChanges: false,
        autosave: { status: "idle" },
      });
      expect(f.session.getSnapshot().lastSavedAt).toBeNumber();
    });
  }

  for (const writable of [true, false]) {
    test(`explicit copy with writable=${writable} never retargets or cleans the source`, async () => {
      const f = fixture({ writable, replacementName: null });

      await f.open();
      expect(f.session.getSnapshot().autosave).toEqual({
        status: "disabled",
        reason: writable ? "copy-required" : "read-only",
      });
      f.dirty();
      await delay(20);
      expect(f.requests).toHaveLength(0);
      expect(f.session.requestSave()).toBe(false);
      expect(f.session.requestSave({ saveAs: true, name: "Explicit copy.native" })).toBe(true);
      f.output();
      await tick();
      expect(f.saves[0]?.output.intent).toBe("save-as");
      expect(f.session.getSnapshot()).toMatchObject({
        hasUnsavedChanges: true,
        lastSavedAt: null,
        document: { name: "Synthetic.native", revision: "1", replacementName: null },
      });
      await delay(20);
      expect(f.requests).toHaveLength(1);
    });
  }

  test("copy on an editable source preserves replacement capability and source dirty baseline", async () => {
    const f = fixture();

    await f.open();
    f.dirty();
    f.session.requestSave({ saveAs: true, name: "Explicit copy.native" });
    f.output();
    await tick();
    expect(f.session.getSnapshot()).toMatchObject({
      hasUnsavedChanges: true,
      lastSavedAt: null,
      document: { name: "Synthetic.native", revision: "1", replacementName: "Synthetic.native" },
    });
    expect(f.session.requestSave()).toBe(true);
    f.output();
    await tick();
    expect(f.saves[1]?.output.intent).toBe("replace");
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  test("forged identities, unsolicited snapshots, false clean and native failure displays cannot claim durability", async () => {
    const f = fixture();

    await f.open();
    f.dirty();
    f.emit({ ...f.identity(), type: "wordcraft:dirty", dirty: false } satisfies NativeHostEvent);
    f.emit({
      ...f.identity(),
      type: "wordcraft:saved",
      requestId: "forged",
      saveId: "forged",
      currentRevision: "2",
      dirty: false,
    } satisfies NativeHostEvent);
    f.emit({
      ...f.identity(),
      type: "wordcraft:save-paused",
      requestId: "forged",
      saveId: "forged",
      status: "failed",
      message: "Advisory only",
    } satisfies NativeHostEvent);
    expect(f.session.getSnapshot()).toMatchObject({
      status: "editing",
      hasUnsavedChanges: true,
      lastSavedAt: null,
    });
    f.session.requestSave();
    const request = f.requests[0];

    f.emit(
      {
        ...f.identity(),
        type: "wordcraft:save",
        requestId: request?.requestId,
        saveId: "forged",
        name: f.document.name,
        saveAs: false,
        bytes: new Uint8Array([5]),
      },
      {},
    );
    f.emit({
      ...f.identity(),
      type: "wordcraft:save",
      requestId: "wrong",
      saveId: "forged",
      name: f.document.name,
      saveAs: false,
      bytes: new Uint8Array([5]),
    });
    expect(f.saves).toHaveLength(0);
    f.output();
    await tick();
    expect(f.saves).toHaveLength(1);
  });

  test("native menu save-requested flushes immediately with manual reason", async () => {
    const f = fixture();

    await f.open();
    const { protocol, version, openId, documentId } = f.identity();

    f.emit({
      protocol,
      version,
      openId,
      documentId,
      type: "wordcraft:save-requested",
      saveAs: false,
    } satisfies NativeHostEvent);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.reason).toBe("manual");
  });

  test("strict ready arriving before backend open is retained without replaying documents", async () => {
    const f = fixture();

    f.ready();
    await f.open();
    expect(f.session.getSnapshot().status).toBe("editing");
    expect(f.commands.filter((command) => "bytes" in command)).toHaveLength(1);
  });

  test("mixed descriptor protocol and bridge fail closed before native commands", async () => {
    const f = fixture({ protocol: 1 });

    await tick();
    f.ready();
    expect(f.session.getSnapshot().status).toBe("failed");
    expect(f.commands).toHaveLength(0);
  });

  test("per-format byte limits are preserved even below the global byte ceiling", async () => {
    const f = fixture();

    await f.open();
    f.dirty();
    f.session.requestSave();
    f.output(undefined, new Uint8Array(65));
    expect(f.saves).toHaveLength(0);
    expect(f.session.getSnapshot().autosave).toEqual({
      status: "paused",
      reason: "serialization-failed",
    });
  });

  test("an unobserved capture clock cannot silently establish a source-clean baseline", async () => {
    const f = fixture();

    await f.open();
    f.session.requestSave();
    f.output(undefined, new Uint8Array([3]), "9");
    await tick();
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(true);
    expect(f.session.getSnapshot().lastSavedAt).toBeNumber();
  });

  test("every snapshot identity member must match before native clean is adopted", async () => {
    const f = fixture();

    f.setAck(false);
    await f.open();
    f.dirty();
    f.session.requestSave();
    const saved = f.output();

    await tick();
    const { bytes: _bytes, name: _name, saveAs: _saveAs, ...identity } = saved;

    const confirmation = {
      ...identity,
      type: "wordcraft:saved",
      currentRevision: saved.revision,
      dirty: false,
    } satisfies NativeHostEvent;

    for (const key of ["requestId", "openId", "documentId", "revision", "saveId"] as const) {
      f.emit({
        ...confirmation,
        [key]: key === "documentId" || key === "revision" ? "999" : "wrong",
      });
      expect(f.session.getSnapshot().pendingSaveCount).toBe(1);
      expect(f.session.getSnapshot().hasUnsavedChanges).toBe(true);
    }

    f.emit(confirmation);
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  test("explicit exports leave source revision, timestamp and dirty baseline untouched", async () => {
    const f = fixture();

    await f.open();
    f.dirty();
    f.session.requestSave({ saveAs: true, name: "Explicit export.pdf" });
    f.output();
    await tick();
    expect(f.saves[0]?.output.intent).toBe("export");
    expect(f.session.getSnapshot()).toMatchObject({
      hasUnsavedChanges: true,
      lastSavedAt: null,
      document: { revision: "1", name: "Synthetic.native" },
    });
  });

  test("disposal during persistence preserves owned recovery bytes and rejects late completion", async () => {
    const f = fixture();
    const durable = Promise.withResolvers<EditorSaveResult>();

    f.setSave(() => durable.promise);
    await f.open();
    f.dirty();
    f.session.requestSave();
    f.output();
    f.session.dispose();
    durable.resolve({ status: "saved", revision: "late" });
    await tick();
    expect(f.session.getSnapshot()).toMatchObject({
      status: "disposed",
      lastSavedAt: null,
      document: { revision: "1" },
    });
    expect(f.session.getRecoveryOutputs()).toHaveLength(1);
    f.session.getRecoveryOutputs()[0]?.bytes.fill(0);
    expect(f.session.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([3, 4]));
    expect(f.listeners.size).toBe(0);
  });

  test("subscriber disposal when capture starts prevents later native or backend calls", async () => {
    const f = fixture();

    await f.open();
    f.session.subscribe(() => {
      if (f.session.getSnapshot().status === "saving") f.session.dispose();
    });
    f.dirty();
    expect(f.session.requestSave()).toBe(false);
    expect(f.requests).toHaveLength(0);
    expect(f.saves).toHaveLength(0);
  });

  test("Pdf false post-ack observation before saved is not durability but does not strand the exact ack", async () => {
    const f = fixture({ app: "pdfcraft", version: "0.17.0-hyori-host.3" });
    f.setAck(false);
    await f.open();
    f.dirty("2");
    f.session.requestSave();
    const saved = f.output();
    await tick();
    f.observe("3", false);
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(true);
    const { bytes: _bytes, name: _name, saveAs: _saveAs, ...identity } = saved;
    f.emit({
      ...identity,
      type: "pdfcraft:saved",
      currentRevision: "3",
      dirty: false,
    } satisfies NativeHostEvent);
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  test("native export/options intent is preserved exactly through manual capture", async () => {
    const f = fixture({ replacementName: null });
    await f.open();
    f.dirty();
    f.nativeIntent("selected-slides-export", "Selected.pdf");
    expect(f.requests[0]).toMatchObject({
      reason: "manual",
      intentId: "selected-slides-export",
      saveAs: true,
      name: "Selected.pdf",
    });
    f.output();
    await tick();
    expect(f.saves[0]?.output).toMatchObject({ intent: "export", name: "Selected.pdf" });
    expect(f.executedIntents).toEqual(["selected-slides-export"]);
    expect(f.session.getSnapshot().lastSavedAt).toBeNull();
  });

  test("a busy native continuation is cancelled, never converted into a queued generic flush", async () => {
    const f = fixture();
    await f.open();
    f.dirty();
    f.session.requestSave();
    f.nativeIntent("must-not-run-new");
    expect(f.cancelledIntents.has("must-not-run-new")).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.intentId).toBeUndefined();
    f.output();
    await tick();
    await delay(40);
    expect(f.requests).toHaveLength(1);
    expect(f.executedIntents).toEqual([]);
  });

  for (const outcome of ["failed", "conflict", "read-only", "access-ended"] as const) {
    test(`${outcome} cancels the exact continuation while preserving captured bytes`, async () => {
      const f = fixture();
      f.setSave(async () => ({
        status: outcome,
        message: "Destination cancelled or save refused",
      }));
      await f.open();
      f.dirty();
      f.nativeIntent("save-then-close");
      f.output();
      await tick();
      expect(f.cancelledIntents.has("save-then-close")).toBe(true);
      expect(f.session.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([3, 4]));
      expect(f.executedIntents).toEqual([]);

      if (outcome === "failed") {
        const attempted = f.saves[0];
        f.setSave(async () => ({ status: "saved", revision: "2" }));
        expect(f.session.retry()).toBe(true);
        await tick();
        expect(f.saves[1]).toEqual(attempted);
        expect(f.executedIntents).toEqual([]);
      }
    });
  }

  test("failed cancel post blocks every later saved acknowledgement until cancellation is delivered", async () => {
    const f = fixture();
    f.failCancel(true);
    f.setSave(async () => {
      throw new Error("Ambiguous save");
    });
    await f.open();
    f.dirty();
    f.nativeIntent("stale-new");
    f.output();
    await tick();
    f.setSave(async () => ({ status: "saved", revision: "2" }));
    expect(f.session.retry()).toBe(true);
    await tick();
    expect(f.session.getSnapshot().status).toBe("save-failed");
    expect(f.commands.filter((command) => "fileRevision" in command)).toHaveLength(0);
    expect(f.executedIntents).toEqual([]);
    f.failCancel(false);
    expect(f.session.retry()).toBe(true);
    await tick();
    expect(f.saves).toHaveLength(2);
    expect(f.cancelledIntents.has("stale-new")).toBe(true);
    expect(f.executedIntents).toEqual([]);
  });

  test("read-only and unauthorized-format native jobs are rejected and cancelled before capture", async () => {
    const readonly = fixture({ writable: false, replacementName: null });
    await readonly.open();
    readonly.nativeIntent("readonly-source");
    expect(readonly.requests).toHaveLength(0);
    expect(readonly.cancelledIntents.has("readonly-source")).toBe(true);
    readonly.nativeIntent("bad-format", "Unexpected.txt");
    expect(readonly.requests).toHaveLength(0);
    expect(readonly.cancelledIntents.has("bad-format")).toBe(true);
  });

  test("serialization error and disposal cancel continuation without resurrecting it on later capture", async () => {
    const f = fixture();
    await f.open();
    f.dirty();
    f.nativeIntent("failed-native-job");
    f.emit({
      protocol: 2,
      version: f.document.version,
      type: "wordcraft:error",
      operation: "save",
      requestId: f.requests[0]?.requestId,
      code: "serialization-failed",
      message: "Native capture failed",
    });
    expect(f.cancelledIntents.has("failed-native-job")).toBe(true);
    expect(f.session.requestSave()).toBe(true);
    expect(f.requests[1]?.intentId).toBeUndefined();
    f.output();
    await tick();
    expect(f.executedIntents).toEqual([]);
    f.dirty();
    f.nativeIntent("dispose-before-capture");
    f.session.dispose();
    expect(f.cancelledIntents.has("dispose-before-capture")).toBe(true);
  });

  test("same-open new document detaches to explicit copy without mutating the source descriptor", async () => {
    const f = fixture();
    await f.open();
    f.changeDocument("8", "1", false);
    expect(f.session.getSnapshot().autosave).toEqual({
      status: "disabled",
      reason: "copy-required",
    });
    await delay(45);
    expect(f.requests).toHaveLength(0);
    expect(f.session.requestSave()).toBe(false);
    expect(f.session.requestSave({ saveAs: true, name: "New document.native" })).toBe(true);
    expect(f.requests[0]?.documentId).toBe("8");
    f.output();
    await tick();
    expect(f.saves[0]).toMatchObject({
      sessionId: "native_session",
      expectedRevision: "1",
      output: { intent: "save-as" },
    });
    expect(f.session.getSnapshot()).toMatchObject({
      hasUnsavedChanges: true,
      lastSavedAt: null,
      document: {
        sessionId: "native_session",
        revision: "1",
        writable: true,
        name: "Synthetic.native",
        replacementName: "Synthetic.native",
      },
    });
    expect(f.session.requestSave()).toBe(false);
  });

  test("new document preserves in-flight old source bytes/ID and cancels its continuation before reconciliation", async () => {
    const f = fixture();
    const durable = Promise.withResolvers<EditorSaveResult>();
    f.setSave(() => durable.promise);
    await f.open();
    f.dirty();
    f.nativeIntent("old-source-new-action");
    f.output();
    const old = f.saves[0];
    f.changeDocument("8", "10", true);
    expect(f.cancelledIntents.has("old-source-new-action")).toBe(true);
    expect(f.session.requestSave({ saveAs: true, name: "New.native" })).toBe(false);
    expect(f.session.getRecoveryOutputs()[0]?.bytes).toEqual(old?.output.bytes);
    durable.resolve({ status: "saved", revision: "2" });
    await tick();
    const sourceTime = f.session.getSnapshot().lastSavedAt;
    expect(f.executedIntents).toEqual([]);
    expect(f.session.requestSave({ saveAs: true, name: "New.native" })).toBe(true);
    expect(f.requests[1]?.documentId).toBe("8");
    f.output();
    await tick();
    expect(f.session.getSnapshot().lastSavedAt).toBe(sourceTime);
    expect(f.session.getSnapshot().document?.revision).toBe("2");
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(true);
  });

  test("new document cannot replace an unresolved old capture, including after its timeout", async () => {
    const f = fixture();
    await f.open();
    f.dirty("2");
    f.nativeIntent("old-capture");
    const old = f.requests[0];
    f.changeDocument("8", "1", false);
    await until(() => f.session.getSnapshot().status === "save-failed");
    expect(f.session.requestSave({ saveAs: true, name: "New.native" })).toBe(false);
    f.output(old, new Uint8Array([6, 7]), "2");
    expect(f.saves).toHaveLength(0);
    expect(f.session.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([6, 7]));
    expect(f.session.retry()).toBe(true);
    await tick();
    expect(f.executedIntents).toEqual([]);
    expect(f.session.requestSave({ saveAs: true, name: "New.native" })).toBe(true);
    expect(f.requests[1]?.documentId).toBe("8");
  });

  test("theme is sent only after negotiated ready, and disposal cancels pending timers", async () => {
    const f = fixture();

    expect(f.session.setTheme("light")).toBe(false);
    await f.open();
    expect(f.commands.filter((command) => command.type.endsWith(":set-theme"))).toHaveLength(1);
    expect(f.session.setTheme("dark")).toBe(true);
    f.dirty();
    f.session.dispose();
    await delay(30);
    expect(f.requests).toHaveLength(0);
    expect(f.listeners.size).toBe(0);
  });
});
