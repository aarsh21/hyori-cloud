import { expect, test } from "bun:test";
import {
  markedDeckPayloadHash,
  markedDeckReceiptSchema,
  markedDeckVersion,
} from "./deckcraft-artifact-identity.ts";
import { sha256 } from "./evidence-bytes.ts";

const prefix = `deckcraft/${markedDeckVersion}/`;

test("marked Deck canonical payload hash fixes key order, ASCII path order and no newline", () => {
  const first = { sha256: "a".repeat(64), bytes: 12, path: `${prefix}index.html` };
  const second = { sha256: "b".repeat(64), path: `${prefix}hyori-host.js`, bytes: 34 };

  const canonical = JSON.stringify([
    { path: second.path, bytes: second.bytes, sha256: second.sha256 },
    { path: first.path, bytes: first.bytes, sha256: first.sha256 },
  ]);

  expect(markedDeckPayloadHash([first, second])).toBe(sha256(Buffer.from(canonical)));
  expect(markedDeckPayloadHash([second, first])).toBe(markedDeckPayloadHash([first, second]));
  expect(markedDeckPayloadHash([first, second])).not.toBe(sha256(Buffer.from(`${canonical}\n`)));
});

test("marked Deck cannot hash a .1, shared notice, foreign path or duplicate payload", () => {
  const file = { path: `${prefix}index.html`, bytes: 1, sha256: "a".repeat(64) };
  expect(() => markedDeckPayloadHash([file, file])).toThrow("Duplicate");
  expect(() =>
    markedDeckPayloadHash([{ ...file, path: "deckcraft/0.14.1-hyori-host.1/index.html" }]),
  ).toThrow("namespace");
  expect(() => markedDeckPayloadHash([{ ...file, path: `${prefix}legal/NOTICE` }])).toThrow(
    "namespace",
  );
  expect(() => markedDeckPayloadHash([{ ...file, path: "legal/NOTICE" }])).toThrow("namespace");
});

test("new marked receipt does not accept historical versions or fabricated product acceptance", () => {
  const receipt = {
    schemaVersion: 1,
    kind: "marked-modified-deck-static-receipt",
    artifactVersion: markedDeckVersion,
    sourceArchiveSha256: "6e03f2e9532c0102ec01d8be8bba556a0191ee11d5ca64412a5b48457afddfb7",
    buildManifestSha256: "a".repeat(64),
    payloadSha256: "b".repeat(64),
    sourceSummarySha256: "c".repeat(64),
    files: Array.from({ length: 6 }, (_, index) => ({
      path: `${prefix}${index}.js`,
      bytes: 1,
      sha256: "d".repeat(64),
    })),
    proof: {
      isolatedOfflineLockedWasmBuild: true,
      exactSourceReplayVerified: true,
      sourceMarksReplacementVerified: true,
      originalFontNoticeInputsUnchanged: true,
      legalOpinion: false,
      actualSdkBackendIntegration: false,
      realBrowserWasmRoundTrip: false,
      allFourLaunchReady: false,
    },
  };

  expect(markedDeckReceiptSchema.parse(receipt).artifactVersion).toBe(markedDeckVersion);
  expect(() =>
    markedDeckReceiptSchema.parse({ ...receipt, artifactVersion: "0.14.1-hyori-host.1" }),
  ).toThrow();
  expect(() =>
    markedDeckReceiptSchema.parse({
      ...receipt,
      proof: { ...receipt.proof, actualSdkBackendIntegration: true },
    }),
  ).toThrow();
});
