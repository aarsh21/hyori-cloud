import { describe, expect, test } from "bun:test";
import { createEditorSession } from "@hyori-cloud/client-sdk";
import type {
  EditorBackendPort,
  EditorDocument,
  EditorHostMessage,
  EditorMessageEvent,
  EditorMessagePort,
} from "@hyori-cloud/client-sdk";

const origin = "https://cloud.example";
const version = "0.14.1-hyori-host.1";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(assetVersion = version) {
  const source = {};
  const listeners = new Set<(event: EditorMessageEvent) => void>();
  const posted: EditorHostMessage[] = [];
  const saves: Parameters<EditorBackendPort["save"]>[0][] = [];

  const descriptor: EditorDocument = {
    app: "deckcraft",
    bridge: "hyori-correlated-host-v1",
    protocol: 1,
    version: assetVersion,
    assetUrl: `/artcraft/deckcraft/${assetVersion}/index.html?host=parent`,
    sessionId: "authorized-session",
    name: "Slides.deckcraft",
    replacementName: "Slides.deckcraft",
    revision: "1",
    writable: true,
    maxBytes: 32,
    outputFormats: [
      { extension: ".deckcraft", kind: "document" },
      { extension: ".pptx", kind: "document" },
      { extension: ".pdf", kind: "export" },
    ],
  };

  let save: EditorBackendPort["save"] = async () => ({ status: "saved", revision: "2" });
  let failAcknowledgement = false;

  const messages: EditorMessagePort = {
    origin,
    source,
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    post(message) {
      if (message.type === "deckcraft:save-result" && failAcknowledgement)
        throw new Error("Synthetic failed post, not failed persistence");
      posted.push(message);
    },
  };

  const session = createEditorSession({
    messages,
    maxBytes: 32,
    readyTimeoutMs: 100,
    backend: {
      open: async () => descriptor,
      download: async () => new Uint8Array([1, 2, 3]),
      save(input, options) {
        saves.push(input);

        return save(input, options);
      },
    },
  });

  function emit(data: EditorMessageEvent["data"], sender = source, senderOrigin = origin) {
    for (const listener of listeners) listener({ data, source: sender, origin: senderOrigin });
  }

  function packet() {
    const message = posted.find((value) => "openId" in value);

    if (!message || !("openId" in message)) throw new Error("No correlated open was posted");

    return message;
  }

  function ready() {
    emit({
      type: "deckcraft:ready",
      protocol: 1,
      version: assetVersion,
      acknowledgements: true,
      maxBytes: 64 * 1024 * 1024,
    });
  }

  function opened() {
    emit({
      type: "deckcraft:opened",
      protocol: 1,
      version: assetVersion,
      openId: packet().openId,
      name: descriptor.name,
      documentId: "native-document",
    });
  }

  function output(
    sequence = 1,
    overrides: Partial<{
      protocol: number;
      version: string;
      openId: string;
      name: string;
      bytes: Uint8Array;
      saveAs: boolean;
    }> = {},
  ) {
    const openId = packet().openId;
    emit({
      type: "deckcraft:save",
      protocol: 1,
      version: assetVersion,
      openId,
      saveId: `${openId}:${sequence}`,
      name: descriptor.name,
      bytes: new Uint8Array([4, 5]),
      saveAs: false,
      ...overrides,
    });
  }

  function acknowledgements() {
    return posted.filter((value) => "status" in value);
  }

  return {
    session,
    posted,
    saves,
    descriptor,
    listeners,
    packet,
    emit,
    ready,
    opened,
    output,
    acknowledgements,
    setSave(next: EditorBackendPort["save"]) {
      save = next;
    },
    failAcknowledgement(value: boolean) {
      failAcknowledgement = value;
    },
  };
}

async function open(f: ReturnType<typeof fixture>) {
  await tick();
  f.ready();
  f.opened();
}

describe("public SDK modified DeckCraft protocol (fake ports; not cloud or WASM evidence)", () => {
  test("shipping .2 keeps protocol1 correlation and rejects mixed-version save messages", async () => {
    const f = fixture("0.14.1-hyori-host.2");

    try {
      await open(f);
      expect(f.session.getSnapshot().status).toBe("editing");
      expect(f.packet()).toMatchObject({ version: "0.14.1-hyori-host.2", protocol: 1 });
      f.output(1, { version: "0.14.1-hyori-host.1" });
      expect(f.saves).toHaveLength(0);
      f.output(1);
      await tick();
      expect(f.saves).toHaveLength(1);
      expect(f.acknowledgements()).toHaveLength(1);
      expect(f.acknowledgements()[0]).toMatchObject({
        version: "0.14.1-hyori-host.2",
        status: "saved",
      });
    } finally {
      f.session.dispose();
    }
  });

  test("unknown future Deck asset versions remain unsupported", async () => {
    const f = fixture("0.14.1-hyori-host.3");

    try {
      await tick();
      expect(f.session.getSnapshot().status).toBe("failed");
      expect(f.posted).toHaveLength(0);
      expect(f.saves).toHaveLength(0);
    } finally {
      f.session.dispose();
    }
  });

  test("requires actual parsing acknowledgement and exact source/origin/protocol/version", async () => {
    const f = fixture();
    await tick();
    f.ready();
    expect(f.session.getSnapshot().status).toBe("opening");
    const packet = f.packet();
    expect(packet).toMatchObject({
      type: "deckcraft:open",
      protocol: 1,
      version,
      maxBytes: 32,
      writable: true,
    });
    f.output();
    f.emit({
      type: "deckcraft:opened",
      protocol: 1,
      version,
      openId: "another-attachment",
      name: f.descriptor.name,
      documentId: "native",
    });
    expect(f.saves).toHaveLength(0);
    expect(f.session.getSnapshot().status).toBe("opening");
    f.opened();
    f.output(1, { protocol: 2 });
    f.output(1, { version: "0.14.1" });
    f.output(1, { openId: "another-attachment" });

    const valid = {
      type: "deckcraft:save",
      protocol: 1,
      version,
      openId: packet.openId,
      saveId: `${packet.openId}:1`,
      name: f.descriptor.name,
      bytes: new Uint8Array([9]),
      saveAs: false,
    };

    f.emit(valid, {});
    f.emit(valid, undefined, "https://attacker.example");
    expect(f.saves).toHaveLength(0);
    expect(f.session.getSnapshot().status).toBe("editing");
    f.session.dispose();
  });

  test("deduplicates pending and completed resends without repeating backend persistence", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<{ status: "saved"; revision: string }>();
    f.setSave(() => pending.promise);
    await open(f);
    f.output();
    f.output();
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]?.saveId).toBe(`${f.packet().openId}:1`);
    expect(f.acknowledgements()).toHaveLength(0);
    pending.resolve({ status: "saved", revision: "2" });
    await tick();
    f.output();
    expect(f.saves).toHaveLength(1);
    expect(f.acknowledgements()).toHaveLength(2);
    expect(f.acknowledgements()[0]).toMatchObject({
      status: "saved",
      revision: "2",
      saveId: `${f.packet().openId}:1`,
    });
    expect(f.session.getSnapshot().document?.revision).toBe("2");
    f.session.dispose();
  });

  test("retries a failed acknowledgement without saving already committed bytes twice", async () => {
    const f = fixture();
    await open(f);
    f.failAcknowledgement(true);
    f.output();
    await tick();
    expect(f.session.getSnapshot().status).toBe("save-failed");
    expect(f.session.getSnapshot().message).toContain("output was saved");
    expect(f.session.getRecoveryOutputs()).toHaveLength(1);
    f.failAcknowledgement(false);
    expect(f.session.retry()).toBe(true);
    await tick();
    expect(f.saves).toHaveLength(1);
    expect(f.session.getSnapshot().status).toBe("editing");
    expect(f.session.getSnapshot().document?.revision).toBe("2");
    expect(f.session.getRecoveryOutputs()).toHaveLength(0);
    f.session.dispose();
  });

  test("retains the stable save ID and original revision across ambiguous backend failure", async () => {
    const f = fixture();
    let attempt = 0;
    f.setSave(async () => {
      attempt += 1;

      if (attempt === 1) throw new Error("Commit reply was lost");

      return { status: "saved", revision: "2" };
    });
    await open(f);
    f.output();
    await tick();
    expect(f.session.getSnapshot().message).toContain("Could not confirm persistence");
    expect(f.acknowledgements()).toHaveLength(0);
    expect(f.session.retry()).toBe(true);
    await tick();
    expect(f.saves).toHaveLength(2);
    expect(f.saves[0]?.saveId).toBe(f.saves[1]?.saveId);
    expect(f.saves[0]?.expectedRevision).toBe(f.saves[1]?.expectedRevision);
    expect(f.acknowledgements()[0]).toMatchObject({ status: "saved" });
    f.session.dispose();
  });

  test("child clean or saved packets never stand in for backend durability", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<{ status: "saved"; revision: string }>();
    f.setSave(() => pending.promise);
    await open(f);
    f.emit({ type: "deckcraft:dirty", protocol: 1, version, dirty: true });
    f.output();
    f.emit({ type: "deckcraft:dirty", protocol: 1, version, dirty: false });
    f.emit({
      type: "deckcraft:saved",
      protocol: 1,
      version,
      saveId: `${f.packet().openId}:1`,
      dirty: false,
    });
    expect(f.session.getSnapshot().status).toBe("saving");
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(true);
    f.emit({ type: "deckcraft:dirty", protocol: 1, version, dirty: true });
    pending.resolve({ status: "saved", revision: "2" });
    await tick();
    expect(f.session.getSnapshot().hasUnsavedChanges).toBe(true);
    f.session.dispose();
  });

  for (const status of ["conflict", "read-only", "access-ended", "failed"] as const) {
    test(`${status}: acknowledges actual backend failure and retains recovery bytes`, async () => {
      const f = fixture();
      f.setSave(async () => ({ status, message: "Current server policy rejected this save" }));
      await open(f);
      f.output();
      await tick();
      expect(f.acknowledgements()[0]).toMatchObject({
        status,
        message: "Current server policy rejected this save",
      });
      expect(f.session.getSnapshot().status).toBe(status === "failed" ? "save-failed" : status);
      expect(f.session.getRecoveryOutputs()[0]?.bytes).toEqual(new Uint8Array([4, 5]));

      if (status !== "failed") expect(f.session.retry()).toBe(false);
      f.session.dispose();
    });
  }

  test("rejects reused IDs with changed bytes and old or out-of-order sequences", async () => {
    const f = fixture();
    await open(f);
    f.output(2);
    expect(f.saves).toHaveLength(0);
    f.output();
    await tick();
    f.output(1, { bytes: new Uint8Array([8]) });
    expect(f.saves).toHaveLength(1);
    expect(f.acknowledgements()).toHaveLength(1);
    expect(f.session.getSnapshot().message).toContain("reused a save ID");
    f.output(2);
    await tick();
    expect(f.saves).toHaveLength(2);
    f.output(1);
    expect(f.saves).toHaveLength(2);
    f.session.dispose();
  });

  test("Save As detaches replacement identity, while exports do not advance source revision", async () => {
    const f = fixture();
    await open(f);
    f.output(1, { name: "Slides.pdf" });
    await tick();
    expect(f.saves[0]?.output.intent).toBe("export");
    expect(f.session.getSnapshot().document?.revision).toBe("1");
    f.output(2, { name: "Copy.deckcraft", saveAs: true });
    await tick();
    f.output(3);
    await tick();
    expect(f.saves[1]?.output.intent).toBe("save-as");
    expect(f.saves[2]?.output.intent).toBe("save-as");
    expect(f.session.getSnapshot().document?.revision).toBe("1");
    f.session.dispose();
  });

  test("open failures and fresh-frame readiness do not replay a stale attachment", async () => {
    const f = fixture();
    await tick();
    f.ready();
    f.emit({
      type: "deckcraft:error",
      protocol: 1,
      version,
      operation: "open",
      operationId: f.packet().openId,
      error: "Invalid native document",
    });
    expect(f.session.getSnapshot().status).toBe("failed");
    f.ready();
    expect(f.posted).toHaveLength(1);
    f.session.dispose();
    const restarted = fixture();
    await open(restarted);
    restarted.ready();
    expect(restarted.session.getSnapshot().status).toBe("failed");
    expect(restarted.posted).toHaveLength(1);
    restarted.session.dispose();
    expect(restarted.listeners.size).toBe(0);
  });
});
