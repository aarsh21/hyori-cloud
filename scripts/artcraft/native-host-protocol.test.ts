import { expect, test } from "bun:test";
import { z } from "zod";
import {
  decodeNativeHostEvent,
  type NativeHostEvent,
} from "@hyori-cloud/client-sdk/editor-runtime";
import { createNativeHostProtocol } from "../../tooling/artcraft/patches/native-host-v3/host-protocol.ts";

const appVersion = "0.14.1-hyori-host.3";
const origin = "https://synthetic.invalid";

interface TestMessageInput {
  requestId?: string;
  intentId?: string;
  openId?: string;
  documentId?: string;
  revision?: string;
  saveId?: string;
  name?: string;
  bytes?: Uint8Array;
  writable?: boolean;
  replacementName?: string;
  maxBytes?: number;
  outputFormats?: { extension: string; kind: string }[];
  status?: string;
  fileRevision?: string;
  message?: string;
  saveAs?: boolean;
  theme?: string;
  reason?: "manual" | "automatic";
}

const tuple = {
  requestId: "request-1",
  openId: "open-1",
  documentId: "42",
  revision: "3",
  saveId: "open-1:1",
};

const savedMessage = z.object({
  type: z.literal("deckcraft:save"),
  requestId: z.string(),
  openId: z.string(),
  documentId: z.string(),
  revision: z.string(),
  saveId: z.string(),
  bytes: z.instanceof(Uint8Array),
  name: z.string(),
  saveAs: z.boolean(),
});

function fixture() {
  const parent = {};
  const posted: NativeHostEvent[] = [];
  let failPost = false;

  const bridge = createNativeHostProtocol({
    app: "deckcraft",
    version: appVersion,
    origin,
    parent,
    replacementExtensions: [".deckcraft"],
    post(message, target) {
      expect(target).toBe(origin);
      expect(decodeNativeHostEvent(message)).not.toBeNull();

      if (failPost && z.object({ type: z.string() }).parse(message).type === "deckcraft:save")
        throw new Error("Synthetic post failure");
      posted.push(message);
    },
    repaint() {},
  });

  function receive(operation: string, input: TestMessageInput) {
    bridge.receive({
      origin,
      source: parent,
      data: { ...input, type: `deckcraft:${operation}`, protocol: 3, version: appVersion },
    });
  }

  bridge.ready();
  receive("open", {
    openId: "open-1",
    name: "Synthetic.deckcraft",
    bytes: new Uint8Array([1]),
    writable: true,
    replacementName: "Synthetic.deckcraft",
    maxBytes: 1024,
    outputFormats: [
      { extension: ".deckcraft", kind: "document" },
      { extension: ".pdf", kind: "export" },
    ],
  });
  expect(bridge.takeOpen()?.openId).toBe("open-1");
  bridge.opened("open-1", "42", "1");

  function request(input: TestMessageInput = {}) {
    receive("request-save", {
      requestId: "request-1",
      openId: "open-1",
      documentId: "42",
      reason: "automatic",
      ...input,
    });
  }

  function serialize() {
    expect(bridge.takeSaveRequest()?.requestId).toBe("request-1");
    // A native input commit may advance the revision after request acceptance.
    bridge.observe("42", "3", true);
    bridge.serialized({
      requestId: "request-1",
      documentId: "42",
      revision: "3",
      name: "Synthetic.deckcraft",
      bytes: new Uint8Array([3, 4]),
      saveAs: false,
    });
  }

  return {
    bridge,
    parent,
    posted,
    receive,
    request,
    serialize,
    failPost() {
      failPost = true;
    },
  };
}

test("native protocol advertises exact protocol3 capabilities only after attachment and parsed-open acknowledgement", () => {
  const f = fixture();

  const ready = z
    .object({
      protocol: z.literal(3),
      version: z.literal(appVersion),
      capabilities: z.object({
        serialize: z.literal(true),
        parsedOpen: z.literal(true),
        documentRevision: z.literal(true),
        durableSaveAck: z.literal(true),
        theme: z.literal(true),
      }),
    })
    .parse(f.posted[0]);

  expect(ready.version).toBe(appVersion);
  expect(z.object({ type: z.string() }).parse(f.posted[1]).type).toBe("deckcraft:opened");
});

test("native revision changes report again while dirty remains true", () => {
  const f = fixture();
  f.bridge.observe("42", "2", true);
  f.bridge.observe("42", "3", true);
  f.bridge.observe("42", "3", true);

  const dirty = f.posted.flatMap((message) => {
    const parsed = z
      .object({ type: z.literal("deckcraft:dirty"), revision: z.string(), dirty: z.boolean() })
      .safeParse(message);

    return parsed.success ? [parsed.data] : [];
  });

  expect(dirty.map((message) => message.revision)).toEqual(["2", "3"]);
});

test("one retained native snapshot replays exact bytes and rejects concurrent new requests", () => {
  const f = fixture();
  f.request();
  f.serialize();
  const first = savedMessage.parse(f.posted.at(-1));
  first.bytes[0] = 99;
  f.request();
  const replay = savedMessage.parse(f.posted.at(-1));
  expect([...replay.bytes]).toEqual([3, 4]);
  expect(replay.saveId).toBe(first.saveId);
  expect(replay.revision).toBe("3");
  f.request({ requestId: "request-2" });
  expect(z.object({ code: z.literal("busy") }).parse(f.posted.at(-1)).code).toBe("busy");
  expect(f.bridge.takeSaveRequest()).toBeNull();
});

test("delayed durable ack cannot clean newer native edits or a different active document", () => {
  const f = fixture();
  f.request();
  f.serialize();
  f.bridge.observe("42", "4", true);
  f.receive("save-result", { ...tuple, status: "saved", fileRevision: "backend-version" });
  expect(f.bridge.takeAcknowledgement()?.revision).toBe("3");
  expect(() => f.bridge.acknowledged("42", "4", "42", "4", false)).toThrow(
    "cannot be marked clean",
  );
  f.bridge.acknowledged("42", "4", "42", "4", true);
  expect(
    z
      .object({ revision: z.literal("3"), currentRevision: z.literal("4"), dirty: z.literal(true) })
      .parse(f.posted.at(-1)).dirty,
  ).toBe(true);
  expect(f.bridge.getRecoverySnapshot()).toBeNull();
});

test("PDF-style ack generation bump is allowed only after exact pre-apply snapshot match", () => {
  const f = fixture();
  f.request();
  f.serialize();
  f.receive("save-result", { ...tuple, status: "saved", fileRevision: "backend-version" });
  expect(f.bridge.takeAcknowledgement()?.status).toBe("saved");
  f.bridge.acknowledged("42", "3", "42", "4", false);
  expect(
    z.object({ currentRevision: z.literal("4"), dirty: z.literal(false) }).parse(f.posted.at(-1))
      .dirty,
  ).toBe(false);
});

test("backend revision cannot impersonate native revision; mismatched tuple and protocol1 ack do not clear snapshot", () => {
  const f = fixture();
  f.request();
  f.serialize();

  for (const change of [
    { revision: "backend-version" },
    { requestId: "wrong" },
    { openId: "wrong" },
    { documentId: "43" },
    { saveId: "wrong" },
  ])
    f.receive("save-result", {
      ...tuple,
      ...change,
      status: "saved",
      fileRevision: "backend-version",
    });
  f.receive("save-result", { ...tuple, status: "saved" });
  expect(f.bridge.takeAcknowledgement()).toBeNull();
  expect(f.bridge.getRecoverySnapshot()?.revision).toBe("3");
});

test("failed persistence pauses without losing or silently reserializing immutable recovery output", () => {
  const f = fixture();
  f.request();
  f.serialize();
  f.receive("save-result", { ...tuple, status: "conflict", message: "Synthetic conflict" });
  expect(f.bridge.takeAcknowledgement()).toBeNull();
  expect([...f.bridge.getRecoverySnapshot()!.bytes]).toEqual([3, 4]);
  f.request({ requestId: "new-silent-retry" });
  expect(z.object({ code: z.literal("busy") }).parse(f.posted.at(-1)).code).toBe("busy");
});

test("native FileNew/Open permanently detaches replacement but explicit authorized copy remains possible", () => {
  const f = fixture();
  f.bridge.observe("43", "1", true);
  f.request({ documentId: "43" });
  expect(z.object({ code: z.literal("identity-changed") }).parse(f.posted.at(-1)).code).toBe(
    "identity-changed",
  );
  f.request({ documentId: "43", saveAs: true, name: "Chosen.deckcraft", reason: "manual" });
  expect(f.bridge.takeSaveRequest()?.name).toBe("Chosen.deckcraft");
  f.bridge.serialized({
    requestId: "request-1",
    documentId: "43",
    revision: "2",
    name: "Chosen.deckcraft",
    bytes: new Uint8Array([9]),
    saveAs: true,
  });
  expect(savedMessage.parse(f.posted.at(-1)).saveAs).toBe(true);
});

test("malformed copy names, unauthorized extensions and wrong iframe/origin/version are rejected", () => {
  const f = fixture();

  for (const input of [
    { name: "Implicit.deckcraft" },
    { saveAs: true },
    { saveAs: true, name: "../escape.deckcraft" },
    { saveAs: true, name: "Unsupported.pptx" },
  ]) {
    f.request(input);
    expect(f.bridge.takeSaveRequest()).toBeNull();
  }

  const before = f.posted.length;

  const data = {
    type: "deckcraft:request-save",
    protocol: 3,
    version: appVersion,
    requestId: "wrong",
    openId: "open-1",
    documentId: "42",
  };

  for (const event of [
    { origin: "https://other.invalid", source: f.parent, data },
    { origin, source: {}, data },
    { origin, source: f.parent, data: { ...data, version: "old" } },
    { origin, source: f.parent, data: { ...data, protocol: 1 } },
  ])
    f.bridge.receive(event);
  expect(f.posted.length).toBe(before);
  expect(f.bridge.takeSaveRequest()).toBeNull();
});

test("theme acknowledgements require the exact native UI-pass request and do not change native document revision", () => {
  const f = fixture();
  f.receive("set-theme", { requestId: "theme-1", theme: "system" });
  expect(f.bridge.takeThemeRequest()).toEqual({ requestId: "theme-1", theme: "system" });
  expect(() => f.bridge.themeApplied("wrong", "system", "dark")).toThrow("identity");
  f.bridge.themeApplied("theme-1", "system", "dark");
  expect(
    z
      .object({
        type: z.literal("deckcraft:theme-applied"),
        theme: z.literal("system"),
        resolvedTheme: z.literal("dark"),
      })
      .parse(f.posted.at(-1)).resolvedTheme,
  ).toBe("dark");
});

test("post failure retains the only recovery bytes after native serialization", () => {
  const f = fixture();
  f.request();
  f.failPost();
  expect(() => f.serialize()).toThrow("post failure");
  expect([...f.bridge.getRecoverySnapshot()!.bytes]).toEqual([3, 4]);
});

test("manual native intent routes through a reasoned request and descriptor-authorized export copy", () => {
  const f = fixture();
  f.bridge.saveRequested("42", false);
  expect(f.posted.at(-1)?.type).toBe("deckcraft:save-requested");
  f.request({ reason: "manual", saveAs: true, name: "Chosen.pdf" });
  const request = f.bridge.takeSaveRequest();
  expect(request?.reason).toBe("manual");
  expect(request?.name).toBe("Chosen.pdf");
  f.bridge.serialized({
    requestId: "request-1",
    documentId: "42",
    revision: "1",
    name: "Chosen.pdf",
    bytes: new Uint8Array([37, 80, 68, 70]),
    saveAs: true,
  });
  expect(savedMessage.parse(f.posted.at(-1)).saveAs).toBe(true);
});

test("automatic copy and reasonless requests are rejected by the single canonical command decoder", () => {
  const f = fixture();
  f.request({ reason: "automatic", saveAs: true, name: "NeverAutoCopy.pdf" });
  expect(f.bridge.takeSaveRequest()).toBeNull();
  f.receive("request-save", { requestId: "no-reason", openId: "open-1", documentId: "42" });
  expect(f.bridge.takeSaveRequest()).toBeNull();
  f.request();
  expect(f.bridge.takeSaveRequest()?.reason).toBe("automatic");
});

test("manual export intent retains its identity and format while allowing an explicit renamed destination", () => {
  const f = fixture();
  expect(f.bridge.saveRequested("42", true, "Native.pdf", "intent-1")).toBe(true);
  f.request({ reason: "manual", intentId: "intent-1", saveAs: true, name: "Renamed.deckcraft" });
  expect(f.bridge.takeSaveRequest()).toBeNull();
  expect(f.posted.at(-1)?.type).toBe("deckcraft:error");
  f.request({ reason: "manual", intentId: "intent-1", saveAs: true, name: "Renamed.pdf" });
  expect(f.bridge.takeSaveRequest()).toMatchObject({
    intentId: "intent-1",
    reason: "manual",
    name: "Renamed.pdf",
  });
});

test("stale cancellation is a no-op, matching cancellation removes only the queued native intent", () => {
  const f = fixture();
  f.bridge.saveRequested("42", false, undefined, "intent-1");
  f.request({ reason: "manual", intentId: "intent-1" });

  for (const changed of [{ openId: "other" }, { documentId: "43" }, { intentId: "other" }])
    f.receive("cancel-intent", {
      openId: "open-1",
      documentId: "42",
      intentId: "intent-1",
      ...changed,
    });
  expect(f.bridge.takeCancellation()).toBeNull();
  f.receive("cancel-intent", { openId: "open-1", documentId: "42", intentId: "intent-1" });
  expect(f.bridge.takeSaveRequest()).toBeNull();
  expect(f.bridge.takeCancellation()?.intentId).toBe("intent-1");
  expect(f.bridge.takeCancellation()).toBeNull();
  f.request({ reason: "manual", intentId: "intent-1" });
  expect(f.bridge.takeSaveRequest()).toBeNull();
  expect(f.posted.at(-1)).toMatchObject({ code: "identity-changed" });
});

test("ordered cancellation before durable ack fences continuation without withdrawing snapshot or clean eligibility", () => {
  const f = fixture();
  f.bridge.saveRequested("42", false, undefined, "intent-1");
  f.request({ reason: "manual", intentId: "intent-1" });
  f.serialize();
  f.receive("cancel-intent", { openId: "open-1", documentId: "42", intentId: "intent-1" });
  f.receive("save-result", { ...tuple, status: "saved", fileRevision: "backend-version" });
  expect(f.bridge.takeAcknowledgement()).toBeNull();
  expect([...f.bridge.getRecoverySnapshot()!.bytes]).toEqual([3, 4]);
  expect(f.bridge.takeCancellation()?.intentId).toBe("intent-1");
  expect(f.bridge.takeAcknowledgement()).toMatchObject({
    intentId: "intent-1",
    continuationCancelled: true,
    revision: "3",
  });
  f.bridge.acknowledged("42", "3", "42", "3", false);
  expect(f.posted.at(-1)).toMatchObject({ type: "deckcraft:saved", dirty: false });
});

test("failure then explicit same-snapshot retry can never revive a failed native continuation", () => {
  const f = fixture();
  f.bridge.saveRequested("42", false, undefined, "intent-1");
  f.request({ reason: "manual", intentId: "intent-1" });
  f.serialize();
  f.receive("save-result", { ...tuple, status: "conflict", message: "Synthetic conflict" });
  f.request({ reason: "manual", intentId: "intent-1" });
  expect(f.posted.at(-1)).toMatchObject({ type: "deckcraft:save", saveId: tuple.saveId });
  expect([...f.bridge.getRecoverySnapshot()!.bytes]).toEqual([3, 4]);
  f.receive("save-result", { ...tuple, status: "saved", fileRevision: "backend-version" });
  expect(f.bridge.takeAcknowledgement()).toBeNull();
  expect(f.bridge.takeFailure()).toMatchObject({ status: "conflict", intentId: "intent-1" });
  expect(f.bridge.takeAcknowledgement()).toMatchObject({ continuationCancelled: true });
  f.bridge.acknowledged("42", "3", "42", "3", false);
});

test("native serialization failure cancels the matching uncaptured continuation and permits a fresh intent", () => {
  const f = fixture();
  f.bridge.saveRequested("42", false, undefined, "intent-1");
  f.request({ reason: "manual", intentId: "intent-1" });
  expect(f.bridge.takeSaveRequest()?.intentId).toBe("intent-1");
  f.bridge.serializationFailed("request-1", "busy", "Native composition is active");
  expect(f.bridge.takeCancellation()?.intentId).toBe("intent-1");
  expect(f.bridge.getRecoverySnapshot()).toBeNull();
  expect(f.bridge.saveRequested("42", false, undefined, "intent-2")).toBe(true);
});

test("PDF post-ack currentRevision suppresses duplicate false observation while later draft cancellation still emits", () => {
  const f = fixture();
  f.request();
  f.serialize();
  f.receive("save-result", { ...tuple, status: "saved", fileRevision: "backend-version" });
  expect(f.bridge.takeAcknowledgement()?.status).toBe("saved");
  f.bridge.acknowledged("42", "3", "42", "4", false);
  const count = f.posted.length;
  f.bridge.observe("42", "4", false);
  expect(f.posted).toHaveLength(count);
  f.bridge.observe("42", "5", false);
  expect(f.posted.at(-1)).toMatchObject({ type: "deckcraft:dirty", revision: "5", dirty: false });
});

test("confirmation retry reaches native once consumed, then cached confirmation reports newer state without reapplying native bytes", () => {
  const f = fixture();
  f.request();
  f.serialize();
  const ack = { ...tuple, status: "saved", fileRevision: "backend-version" };
  f.receive("save-result", ack);
  expect(f.bridge.takeAcknowledgement()?.status).toBe("saved");
  // A lost confirmation must be retriable without a second native serialization/application.
  f.receive("save-result", ack);
  expect(f.bridge.takeAcknowledgement()?.status).toBe("saved");
  f.bridge.acknowledged("42", "3", "42", "4", false);
  f.receive("save-result", ack);
  expect(f.posted.at(-1)).toMatchObject({
    type: "deckcraft:saved",
    currentRevision: "4",
    dirty: false,
  });
  expect(f.bridge.takeAcknowledgement()).toBeNull();
  f.bridge.observe("42", "5", true);
  f.receive("save-result", ack);
  expect(f.posted.at(-1)).toMatchObject({
    type: "deckcraft:saved",
    currentRevision: "5",
    dirty: true,
  });
  expect(f.bridge.getRecoverySnapshot()).toBeNull();
});

test("internal native export capability queries use only the actual parsed-open output descriptor", () => {
  const f = fixture();
  expect(f.bridge.canExport("Chosen.pdf")).toBe(true);
  expect(f.bridge.canExport("Chosen.PNG")).toBe(false);
  expect(f.bridge.hasPendingSave()).toBe(false);
  expect(f.bridge.hasRecoverySnapshot()).toBe(false);
  f.request();
  expect(f.bridge.hasPendingSave()).toBe(true);
  expect(f.bridge.hasRecoverySnapshot()).toBe(false);
  f.serialize();
  expect(f.bridge.hasRecoverySnapshot()).toBe(true);
});
