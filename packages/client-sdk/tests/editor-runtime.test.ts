import { describe, expect, test } from "bun:test";

import {
  decodeNativeHostCommand,
  decodeNativeHostEvent,
} from "@hyori-cloud/client-sdk/editor-runtime";

const envelope = { type: "wordcraft:opened", protocol: 2, version: "test-host.3" } as const;
const identity = { openId: "open-1", documentId: "18446744073709551615", revision: "12" };
const snapshot = { ...identity, requestId: "request-1", saveId: "save-1" };

describe("canonical native editor IPC", () => {
  test("preserves opaque u64 strings, full identity and all four families", () => {
    for (const app of ["wordcraft", "gridcraft", "pdfcraft", "deckcraft"] as const) {
      const value = { ...envelope, ...identity, type: `${app}:opened` } as const;

      expect(decodeNativeHostEvent(value)).toEqual(value);
    }
  });

  test("rejects extra fields, wrong discriminants and cross-protocol envelopes", () => {
    const value = { ...envelope, ...identity };

    for (const changed of [
      { extra: true },
      { protocol: 1 },
      { type: "wordcraft:saved" },
      { type: "evil:opened" },
      { revision: 12 },
      { revision: "-1" },
      { revision: "01" },
      { revision: "18446744073709551616" },
    ])
      expect(decodeNativeHostEvent({ ...value, ...changed })).toBeNull();
  });

  test("requires every negotiated capability and rejects a fabricated capability", () => {
    const value = {
      ...envelope,
      type: "wordcraft:ready",
      maxBytes: 100,
      capabilities: {
        serialize: true,
        parsedOpen: true,
        documentRevision: true,
        durableSaveAck: true,
        theme: true,
      },
    } as const;

    expect(decodeNativeHostEvent(value)).toEqual(value);
    expect(
      decodeNativeHostEvent({ ...value, capabilities: { ...value.capabilities, theme: false } }),
    ).toBeNull();
    expect(
      decodeNativeHostEvent({
        ...value,
        capabilities: { ...value.capabilities, collaboration: true },
      }),
    ).toBeNull();
  });

  test("save result separates native revision and durable file revision without stripping", () => {
    const value = {
      ...envelope,
      ...snapshot,
      type: "wordcraft:save-result",
      status: "saved",
      fileRevision: "file-r2",
    } as const;

    expect(decodeNativeHostCommand(value)).toEqual(value);
    expect(decodeNativeHostCommand({ ...value, status: "failed" })).toBeNull();
    expect(decodeNativeHostCommand({ ...value, fileRevision: undefined })).toBeNull();
  });

  test("bounded bytes and filenames are checked before opening", () => {
    const value = {
      ...envelope,
      type: "wordcraft:open",
      openId: "open-1",
      name: "Test.docx",
      bytes: new Uint8Array([1, 2]),
      writable: true,
      replacementName: "Test.docx",
      outputFormats: [{ extension: ".docx", kind: "document" }],
      maxBytes: 2,
    } as const;

    expect(decodeNativeHostCommand(value)).toEqual(value);
    expect(decodeNativeHostCommand({ ...value, maxBytes: 1 })).toBeNull();
    expect(decodeNativeHostCommand({ ...value, bytes: new Uint8Array() })).toBeNull();
    expect(decodeNativeHostCommand({ ...value, name: "../Test.docx" })).toBeNull();
    expect(
      decodeNativeHostCommand({
        ...value,
        outputFormats: [{ extension: ".docx", kind: "document", extra: true }],
      }),
    ).toBeNull();
  });

  test("copy commands require an explicit name; default replace has none", () => {
    const value = {
      ...envelope,
      type: "wordcraft:request-save",
      requestId: "r",
      openId: "o",
      documentId: "1",
      reason: "manual",
    } as const;

    expect(decodeNativeHostCommand(value)).toEqual(value);
    expect(decodeNativeHostCommand({ ...value, saveAs: true })).toBeNull();
    expect(decodeNativeHostCommand({ ...value, name: "Copy.docx" })).toBeNull();
    expect(decodeNativeHostCommand({ ...value, saveAs: true, name: "Copy.docx" })).not.toBeNull();
    expect(
      decodeNativeHostCommand({ ...value, reason: "automatic", saveAs: true, name: "Copy.docx" }),
    ).toBeNull();
    expect(decodeNativeHostCommand({ ...value, reason: undefined })).toBeNull();
    expect(decodeNativeHostCommand({ ...value, intentId: "native-export-1" })).not.toBeNull();
    expect(
      decodeNativeHostCommand({ ...value, reason: "automatic", intentId: "native-export-1" }),
    ).toBeNull();
  });

  test("native manual intents remain correlated and cancellation cannot carry a save acknowledgement", () => {
    const requested = {
      ...envelope,
      type: "deckcraft:save-requested",
      openId: "open",
      documentId: "1",
      intentId: "export-selected-slides",
      saveAs: true,
      name: "Selected.pdf",
    } as const;

    expect(decodeNativeHostEvent(requested)).toEqual(requested);

    const cancelled = {
      ...envelope,
      type: "deckcraft:cancel-intent",
      openId: requested.openId,
      documentId: requested.documentId,
      intentId: requested.intentId,
    } as const;

    expect(decodeNativeHostCommand(cancelled)).toEqual(cancelled);
    expect(decodeNativeHostCommand({ ...cancelled, intentId: "" })).toBeNull();
    expect(
      decodeNativeHostCommand({ ...cancelled, status: "saved", fileRevision: "2" }),
    ).toBeNull();
    expect(decodeNativeHostEvent(cancelled)).toBeNull();
  });
});
