import { expect, test } from "bun:test";
import { EditorDocument } from "@hyori-cloud/client-sdk";
import type { EditorDocument as Document } from "@hyori-cloud/client-sdk";
import { Schema } from "@hyori-cloud/lib/effect";
import {
  decodeEditorMessage,
  validateEditorDocument,
} from "#client-sdk/features/editors/editor-protocol";

function descriptor(app: "wordcraft" | "deckcraft", name: string): Document {
  return {
    app,
    bridge: app === "deckcraft" ? "hyori-correlated-host-v1" : "upstream-host-parent",
    protocol: app === "deckcraft" ? 1 : null,
    sessionId: "a".repeat(64),
    assetUrl: `/artcraft/${app}/synthetic/index.html?host=parent`,
    version: app === "deckcraft" ? "0.14.1-hyori-host.1" : "0.14.0",
    name,
    replacementName: name,
    revision: "1",
    writable: true,
    maxBytes: 16,
    outputFormats: [{ extension: app === "deckcraft" ? ".deckcraft" : ".docx", kind: "document" }],
  };
}

test("legacy editor names reuse the Rust-owned scalar limit rather than an invented UTF-16 limit", () => {
  const name = `${"😀".repeat(128)}.docx`;
  expect(name.length).toBeGreaterThan(255);
  expect(Schema.decodeUnknownSync(EditorDocument)(descriptor("wordcraft", name)).name).toBe(name);
  expect(
    decodeEditorMessage(
      {
        origin: "https://cloud.example",
        source: {},
        data: { type: "wordcraft:save", name, bytes: new Uint8Array([1]), saveAs: false },
      },
      "wordcraft",
      16,
      "0.14.0",
    ).kind,
  ).toBe("save");
  expect(() =>
    Schema.decodeUnknownSync(EditorDocument)(descriptor("wordcraft", `${"😀".repeat(256)}.docx`)),
  ).toThrow();
});

test("modified Deck keeps its actual vendor UTF-16 name bound without changing Files names", () => {
  const allowed = `${"😀".repeat(122)}.deckcraft`;
  const unsupported = `${"😀".repeat(123)}.deckcraft`;
  expect(() => validateEditorDocument(descriptor("deckcraft", allowed), 16)).not.toThrow();
  expect(() => validateEditorDocument(descriptor("deckcraft", unsupported), 16)).toThrow();

  const packet = {
    protocol: 1,
    version: "0.14.1-hyori-host.1",
    type: "deckcraft:save",
    openId: "attachment",
    saveId: "attachment:1",
    name: allowed,
    bytes: new Uint8Array([1]),
    saveAs: false,
  };

  expect(
    decodeEditorMessage(
      { origin: "https://cloud.example", source: {}, data: packet },
      "deckcraft",
      16,
      "0.14.1-hyori-host.1",
    ).kind,
  ).toBe("save");
  expect(
    decodeEditorMessage(
      { origin: "https://cloud.example", source: {}, data: { ...packet, name: unsupported } },
      "deckcraft",
      16,
      "0.14.1-hyori-host.1",
    ).kind,
  ).toBe("invalid");
});
