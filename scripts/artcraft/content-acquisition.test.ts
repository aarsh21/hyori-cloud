import { expect, test, spyOn } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checkPdfCompiledTables } from "./content-pdf-tables.ts";
import { deckRunRoot } from "./deckcraft-run.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { acquireArtCraft, acquireArtCraftFromArchives } from "./acquire.ts";
import { acquireRetainedDeckCraft } from "./deckcraft-acquire.ts";
import { checkAcquiredNotices } from "./content-acquired.ts";
import { checkRedistributionEvidence } from "./redistribution.ts";
import { sha256 } from "./evidence-bytes.ts";

// Explicit public-only local inputs; absent caches skip only these large-payload acceptance tests.
const inputs = z
  .object({
    ARTCRAFT_TEST_INPUTS: z.string().optional(),
    ARTCRAFT_TEST_DECK_EVIDENCE: z.string().optional(),
  })
  .parse(process.env);

const receiptSchema = z
  .object({
    assets: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })),
  })
  .passthrough();

async function checkFiles(output: string) {
  const receipt = receiptSchema.parse(
    JSON.parse(await readFile(join(output, "artifact-manifest.json"), "utf8")),
  );

  for (const asset of receipt.assets) {
    const body = await readFile(join(output, asset.path));
    expect(body.length).toBe(asset.bytes);
    expect(sha256(body)).toBe(asset.sha256);
  }

  expect((await checkAcquiredNotices(output)).verifiedNoticeFiles).toBe(173);

  return receipt;
}

test.skipIf(!inputs.ARTCRAFT_TEST_INPUTS)(
  "compiled PdfCraft numeric tables have positive exact observations, never inferred absence",
  async () => {
    const config = z
      .object({ editors: z.array(z.object({ app: z.string(), releaseArchive: z.string() })) })
      .parse(JSON.parse(await readFile(inputs.ARTCRAFT_TEST_INPUTS!, "utf8")));

    const result = await checkPdfCompiledTables(
      config.editors.find((editor) => editor.app === "pdfcraft")!.releaseArchive,
    );

    for (const name of ["WIDTHS", "WIN_ANSI", "MAC_ROMAN", "STANDARD"])
      expect(result.tables.find((table) => table.name === name)!.offsets.length).toBeGreaterThan(0);
    expect(result.tables.find((table) => table.name === "WIDTHS")!.offsets).toEqual([4880728]);
    expect(result.tables.find((table) => table.name === "WIDTHS")!.bytes).toBe(7168);
    expect(result.deployable).toBe(false);
    expect(result.legalOpinion).toBe(false);
  },
  120000,
);

test.skipIf(!inputs.ARTCRAFT_TEST_DECK_EVIDENCE)(
  "missing or changed retained build bytes roll back without an acquired destination",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hyori-deck-acquire-failure-"));

    try {
      const build = receiptSchema.parse(
        JSON.parse(await readFile(join(deckRunRoot, "build-manifest.json"), "utf8")),
      );

      const first = build.assets.find((asset) => asset.path.startsWith("artifact/"))!;
      const evidence = join(root, "evidence");
      const target = join(evidence, first.path);
      await mkdir(dirname(target), { recursive: true });
      const original = await readFile(join(inputs.ARTCRAFT_TEST_DECK_EVIDENCE!, first.path));
      await writeFile(target, Buffer.concat([original, Buffer.from("changed")]));
      const output = join(root, "output");
      await expect(acquireRetainedDeckCraft(output, evidence)).rejects.toThrow("checksum mismatch");
      expect((await readdir(root)).sort()).toEqual(["evidence"]);
      await rm(target);
      await expect(acquireRetainedDeckCraft(output, evidence)).rejects.toThrow();
      expect((await readdir(root)).sort()).toEqual(["evidence"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);

test.skipIf(!inputs.ARTCRAFT_TEST_INPUTS)(
  "public acquisition uses unchanged pins and delivers verified notices with an entirely local downloader",
  async () => {
    const config = z
      .object({ editors: z.array(z.object({ app: z.string(), releaseArchive: z.string() })) })
      .parse(JSON.parse(await readFile(inputs.ARTCRAFT_TEST_INPUTS!, "utf8")));

    const archives = new Map<string, Buffer>();

    for (const editor of config.editors)
      archives.set(
        official.editors.find((pin) => pin.app === editor.app)!.url,
        await readFile(editor.releaseArchive),
      );

    const localFetch = Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const body = archives.get(String(input));

        if (!body) throw new Error("No network permitted in acquisition acceptance fixture");

        return new Response(new Uint8Array(body));
      },
      {
        preconnect() {
          throw new Error("No network preconnect permitted");
        },
      },
    );

    const fetch = spyOn(globalThis, "fetch").mockImplementation(localFetch);

    const root = await mkdtemp(join(tmpdir(), "hyori-official-acquisition-"));

    try {
      const output = join(root, "output");
      await acquireArtCraft(output);
      expect(fetch).toHaveBeenCalledTimes(4);
      await checkFiles(output);
      const verified = await checkRedistributionEvidence();

      for (const editor of official.editors)
        for (const file of editor.legal)
          expect(
            await readFile(join(output, `legal/${file.path.slice("licenses/".length)}`)),
          ).toEqual(Buffer.from(verified.get(file.path)!));
      await expect(acquireArtCraft(output)).rejects.toThrow("Refusing to overwrite");
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      fetch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);

test.skipIf(!inputs.ARTCRAFT_TEST_INPUTS)(
  "offline acquisition fails closed for installed notice tampering, deletion, weakened receipts and false clearance",
  async () => {
    const noNetwork = Object.assign(
      () => {
        throw new Error("Offline acquisition attempted network");
      },
      {
        preconnect() {
          throw new Error("Offline acquisition attempted preconnect");
        },
      },
    );

    const fetch = spyOn(globalThis, "fetch").mockImplementation(noNetwork);

    const root = await mkdtemp(join(tmpdir(), "hyori-offline-acquisition-"));

    try {
      const output = join(root, "output");
      await acquireArtCraftFromArchives(output, inputs.ARTCRAFT_TEST_INPUTS!);
      const receipt = await checkFiles(output);
      const notice = join(output, "legal/content/conditions/e0.txt");
      const original = await readFile(notice);
      await writeFile(notice, Buffer.concat([original, Buffer.from("changed")]));
      await expect(checkAcquiredNotices(output)).rejects.toThrow("bytes changed");
      await writeFile(notice, original);
      await rm(notice);
      await expect(checkAcquiredNotices(output)).rejects.toThrow();
      await writeFile(
        join(output, "artifact-manifest.json"),
        JSON.stringify({
          ...receipt,
          assets: receipt.assets.filter(
            (asset) => asset.path !== "legal/content/conditions/e0.txt",
          ),
        }),
      );
      await expect(checkAcquiredNotices(output)).rejects.toThrow("receipt missing or changed");
      await writeFile(notice, original);
      await writeFile(
        join(output, "artifact-manifest.json"),
        JSON.stringify({ ...receipt, deployable: true }),
      );
      await expect(checkAcquiredNotices(output)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);

test.skipIf(!inputs.ARTCRAFT_TEST_DECK_EVIDENCE)(
  "retained modified Deck acquisition preserves every recorded artifact byte and verifies delivered notices offline",
  async () => {
    const noNetwork = Object.assign(
      () => {
        throw new Error("Retained Deck acquisition attempted network");
      },
      {
        preconnect() {
          throw new Error("Retained Deck acquisition attempted preconnect");
        },
      },
    );

    const fetch = spyOn(globalThis, "fetch").mockImplementation(noNetwork);

    const root = await mkdtemp(join(tmpdir(), "hyori-deck-acquisition-"));

    try {
      const output = join(root, "output");
      await acquireRetainedDeckCraft(output, inputs.ARTCRAFT_TEST_DECK_EVIDENCE!);
      const receipt = await checkFiles(output);
      expect(receipt.deployable).toBe(false);

      const source = receiptSchema.parse(
        JSON.parse(await readFile(join(output, "legal/RETAINED-BUILD-MANIFEST.json"), "utf8")),
      );

      for (const asset of source.assets.filter((asset) => asset.path.startsWith("artifact/")))
        expect(await readFile(join(output, asset.path.slice("artifact/".length)))).toEqual(
          await readFile(join(inputs.ARTCRAFT_TEST_DECK_EVIDENCE!, asset.path)),
        );
      const notice = join(output, "legal/content/conditions/e0.txt");
      await readFile(notice);
      await rm(notice);
      await expect(checkAcquiredNotices(output)).rejects.toThrow();
      await expect(
        acquireRetainedDeckCraft(output, inputs.ARTCRAFT_TEST_DECK_EVIDENCE!),
      ).rejects.toThrow("Refusing to overwrite");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
