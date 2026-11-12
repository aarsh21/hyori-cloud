import { describe, expect, test } from "bun:test";
import {
  createDeckHostProtocol,
  HARD_MAX_BYTES,
  type HostOutgoing,
  type HostEvent,
} from "../../tooling/artcraft/patches/deckcraft-host-v2/host-protocol.ts";

const version = "0.14.1-hyori-host.2";
const origin = "https://cloud.example";

type OpenDescriptor = {
  type: "deckcraft:open";
  protocol: 1;
  version: string;
  openId: string;
  name: string;
  bytes: Uint8Array;
  maxBytes: number;
  writable: boolean;
  replacementName: string | null;
  outputFormats: { extension: string; kind: "document" | "export" }[];
};

function fixture() {
  const parent = {};
  const messages: HostOutgoing[] = [];
  let failPost = false;

  const protocol = createDeckHostProtocol({
    origin,
    parent,
    version,
    repaint() {},
    post(message, target) {
      expect(target).toBe(origin);

      if (failPost) throw new Error("synthetic post failure");
      messages.push(message);
    },
  });

  const descriptor: OpenDescriptor = {
    type: "deckcraft:open",
    protocol: 1,
    version,
    openId: "open-1",
    name: "Synthetic.deckcraft",
    bytes: new Uint8Array([1, 2, 3]),
    maxBytes: 100,
    writable: true,
    replacementName: "Synthetic.deckcraft",
    outputFormats: [
      { extension: ".deckcraft", kind: "document" },
      { extension: ".pdf", kind: "export" },
    ],
  };

  function receive(event: Pick<HostEvent, "data">) {
    protocol.receive({ origin, source: parent, ...event });
  }

  function open() {
    protocol.ready();
    receive({ data: descriptor });
    const opened = protocol.takeOpen();
    expect(opened).not.toBeNull();
    protocol.opened(descriptor.openId, "doc-7");
  }

  function acknowledge(saveId: string) {
    receive({
      data: {
        type: "deckcraft:save-result",
        protocol: 1,
        version,
        saveId,
        status: "saved",
        revision: "r2",
      },
    });
  }

  return {
    protocol,
    parent,
    messages,
    descriptor,
    receive,
    open,
    acknowledge,
    failNextPost() {
      failPost = true;
    },
    allowPost() {
      failPost = false;
    },
  };
}

describe("modified DeckCraft host byte protocol", () => {
  test("ready advertises exact modified version, bounded bytes and acknowledgements once", () => {
    const f = fixture();
    f.protocol.ready();
    f.protocol.ready();
    expect(f.messages).toEqual([
      {
        type: "deckcraft:ready",
        protocol: 1,
        version,
        supportedInputFormats: [".deckcraft", ".pptx"],
        maxBytes: HARD_MAX_BYTES,
        acknowledgements: true,
      },
    ]);
  });
  test("rejects a non-origin URL as attachment authority", () => {
    expect(() =>
      createDeckHostProtocol({
        origin: `${origin}/path`,
        version,
        parent: {},
        post() {},
        repaint() {},
      }),
    ).toThrow();
  });
  test("ignores foreign origin and source before parsing", () => {
    const f = fixture();
    f.protocol.ready();
    f.protocol.receive({ origin: "https://evil.example", source: f.parent, data: f.descriptor });
    f.protocol.receive({ origin, source: {}, data: f.descriptor });
    expect(f.protocol.takeOpen()).toBeNull();
  });
  test("rejects wrong protocol and asset version", () => {
    const f = fixture();
    f.protocol.ready();
    f.receive({ data: { ...f.descriptor, protocol: 2 } });
    expect(f.protocol.takeOpen()).toBeNull();
    f.receive({ data: { ...f.descriptor, version: "0.14.1" } });
    expect(f.protocol.takeOpen()).toBeNull();
    expect(f.messages.at(-1)?.type).toBe("deckcraft:error");
  });
  test("input copy is retained until parser acknowledgement, not post delivery", () => {
    const f = fixture();
    f.protocol.ready();
    f.receive({ data: f.descriptor });
    f.descriptor.bytes[0] = 99;
    expect(f.messages.some((message) => message.type === "deckcraft:opened")).toBe(false);
    expect(f.protocol.takeOpen()?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.protocol.takeOpen()).toBeNull();
    expect(() => f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([4]), false)).toThrow();
    f.protocol.opened("open-1", "doc-7");
    expect(f.messages.at(-1)?.type).toBe("deckcraft:opened");
  });
  test("oversized, empty and shared inputs never reach parser", () => {
    for (const bytes of [
      new Uint8Array(101),
      new Uint8Array(0),
      new Uint8Array(new SharedArrayBuffer(2)),
    ]) {
      const f = fixture();
      f.protocol.ready();
      f.receive({ data: { ...f.descriptor, bytes } });
      expect(f.protocol.takeOpen()).toBeNull();
    }
  });
  test("rejects unsafe names, unsupported formats and duplicate output policy", () => {
    for (const override of [
      { name: "../file.deckcraft" },
      { name: "x.txt" },
      { name: "x​.deckcraft" },
      {
        outputFormats: [
          { extension: ".deckcraft", kind: "document" },
          { extension: ".deckcraft", kind: "document" },
        ],
      },
    ]) {
      const f = fixture();
      f.protocol.ready();
      f.receive({ data: { ...f.descriptor, ...override } });
      expect(f.protocol.takeOpen()).toBeNull();
    }
  });
  test("parse failure permits retry but never acknowledges opening", () => {
    const f = fixture();
    f.protocol.ready();
    f.receive({ data: f.descriptor });
    f.protocol.takeOpen();
    f.protocol.openFailed("open-1", "bad archive");
    expect(f.messages.at(-1)?.type).toBe("deckcraft:error");
    f.receive({ data: f.descriptor });
    expect(f.protocol.takeOpen()).not.toBeNull();
  });
  test("does not replay a new open over editor changes", () => {
    const f = fixture();
    f.open();
    f.receive({ data: { ...f.descriptor, openId: "open-2" } });
    expect(f.protocol.takeOpen()).toBeNull();
  });
  test("successful save post retains independent recovery bytes until matching persistence ack", () => {
    const f = fixture();
    f.open();
    const bytes = new Uint8Array([4, 5]);
    const id = f.protocol.save("doc-7", f.descriptor.name, bytes, false);
    bytes[0] = 99;
    const packet = f.messages.at(-1);

    if (packet?.type !== "deckcraft:save") throw new Error("missing save");
    packet.bytes[0] = 88;
    expect(f.protocol.getRecoveryOutput()?.bytes).toEqual(new Uint8Array([4, 5]));
    const recovery = f.protocol.getRecoveryOutput()!;
    recovery.bytes[1] = 77;
    expect(f.protocol.getRecoveryOutput()?.bytes[1]).toBe(5);
    f.acknowledge("stale");
    expect(f.protocol.takeAcknowledgement()).toBeNull();
    f.acknowledge(id);
    expect(f.protocol.getRecoveryOutput()).not.toBeNull();
    expect(f.protocol.takeAcknowledgement()?.status).toBe("saved");
    expect(f.protocol.getRecoveryOutput()).toBeNull();
    f.protocol.confirmSaved(id, true);
    expect(f.messages.at(-1)).toMatchObject({ type: "deckcraft:saved", saveId: id, dirty: true });
  });
  test("longest valid open id produces an acknowledgeable stable save id", () => {
    const f = fixture();
    f.descriptor.openId = "o".repeat(128);
    f.open();
    const id = f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([4]), false);
    f.acknowledge(id);
    expect(f.protocol.takeAcknowledgement()?.status).toBe("saved");
  });
  test("spoofed and version-mismatched save acks cannot erase recovery", () => {
    const f = fixture();
    f.open();
    const saveId = f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([4]), false);

    const data = {
      type: "deckcraft:save-result",
      protocol: 1,
      version,
      saveId,
      status: "saved",
      revision: "r2",
    };

    f.protocol.receive({ origin, source: {}, data });
    f.protocol.receive({ origin: "https://evil.example", source: f.parent, data });
    f.receive({ data: { ...data, version: "0.14.1" } });
    expect(f.protocol.takeAcknowledgement()).toBeNull();
    expect(f.protocol.getRecoveryOutput()).not.toBeNull();
  });
  test("all backend failure statuses retain bytes and block overwriting pending snapshot", () => {
    for (const status of ["conflict", "read-only", "access-ended", "failed"] as const) {
      const f = fixture();
      f.open();
      const saveId = f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([4]), false);
      f.receive({
        data: {
          type: "deckcraft:save-result",
          protocol: 1,
          version,
          saveId,
          status,
          message: "synthetic failure",
        },
      });
      expect(f.protocol.takeAcknowledgement()?.status).toBe(status);
      expect(f.protocol.getRecoveryOutput()?.bytes).toEqual(new Uint8Array([4]));
      expect(() =>
        f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([5]), false),
      ).toThrow();
    }
  });
  test("failed post resends the old id and snapshot rather than claiming save success", () => {
    const f = fixture();
    f.open();
    f.failNextPost();
    const id = f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([4]), false);
    expect(f.protocol.takeLocalError()).toContain("retained");
    f.allowPost();
    expect(f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([5]), false)).toBe(id);
    expect(f.protocol.getRecoveryOutput()?.bytes).toEqual(new Uint8Array([4]));
  });
  test("bounds output and binds saves to parsed host document identity", () => {
    const f = fixture();
    f.open();
    expect(() =>
      f.protocol.save("other-document", f.descriptor.name, new Uint8Array([4]), false),
    ).toThrow();
    expect(() => f.protocol.save("doc-7", f.descriptor.name, new Uint8Array(101), false)).toThrow();
    expect(() => f.protocol.save("doc-7", "x.pptx", new Uint8Array([4]), false)).toThrow();
  });
  test("read-only forbids document saves but permits descriptor-authorized exports", () => {
    const f = fixture();
    f.descriptor.writable = false;
    f.open();
    expect(() => f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([4]), false)).toThrow();
    f.protocol.save("doc-7", "x.pdf", new Uint8Array([4]), true);
    expect(f.messages.at(-1)).toMatchObject({ type: "deckcraft:save", saveAs: true });
  });
  test("read-only permits an explicit native copy, marked as a copy", () => {
    const f = fixture();
    f.descriptor.writable = false;
    f.open();
    f.protocol.save("doc-7", "Copy.deckcraft", new Uint8Array([4]), true);
    expect(f.messages.at(-1)).toMatchObject({
      type: "deckcraft:save",
      name: "Copy.deckcraft",
      saveAs: true,
    });
  });
  test("read-only still refuses replacement, under the source's name or any other", () => {
    const f = fixture();
    f.descriptor.writable = false;
    f.open();
    const before = f.messages.length;
    expect(() => f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([4]), false)).toThrow(
      /read-only/,
    );
    expect(() => f.protocol.save("doc-7", "Other.deckcraft", new Uint8Array([4]), false)).toThrow(
      /read-only/,
    );
    expect(f.messages).toHaveLength(before);
  });
  test("read-only's explicit copy of the source's own name stays a copy", () => {
    const f = fixture();
    f.descriptor.writable = false;
    f.open();
    f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([4]), true);
    expect(f.messages.at(-1)).toMatchObject({ saveAs: true });
  });
  test("a host-opened PPTX's native copy is a copy, with no replacement to fall back to", () => {
    const f = fixture();
    f.descriptor.name = "Talk.pptx";
    f.descriptor.replacementName = null;
    f.open();
    f.protocol.save("doc-7", "Talk.deckcraft", new Uint8Array([4]), true);
    expect(f.messages.at(-1)).toMatchObject({ name: "Talk.deckcraft", saveAs: true });
    expect(() => f.protocol.save("doc-7", "Talk.pptx", new Uint8Array([4]), false)).toThrow();
  });
  test("the protocol stays version 1", () => {
    const f = fixture();
    f.open();
    f.protocol.save("doc-7", f.descriptor.name, new Uint8Array([4]), false);
    expect(f.messages.at(-1)).toMatchObject({ protocol: 1, version });
  });
  test("different document name is save-as rather than implicit source replacement", () => {
    const f = fixture();
    f.open();
    f.protocol.save("doc-7", "New.deckcraft", new Uint8Array([4]), false);
    expect(f.messages.at(-1)).toMatchObject({ saveAs: true });
  });
});
