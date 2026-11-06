import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { noticeMembers } from "./closure-collect.ts";
import {
  assertNormalTargetTree,
  cargoMetadataSchema,
  hostInclusiveIds,
  parseTargetTree,
} from "./closure-graph.ts";
import { declaredWebRecipe } from "./closure-recipe.ts";
import { checkClosureEvidence, deploymentClosureManifest, readClosureManifest } from "./closure.ts";
import { readCrateArchive, readGitSourceArchive } from "./evidence-bytes.ts";

const root = new URL("../../tooling/artcraft/closure/", import.meta.url);

function tar(entries: { name: string; type?: string; text?: string }[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const bytes = Buffer.from(entry.text ?? "data");
    header.write(entry.name, 0, 100);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156);
    header.write("ustar\0", 257);
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
      148,
    );
    const payload = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
    bytes.copy(payload);
    blocks.push(header, payload);
  }

  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe("locked declared wasm32 closure and matched notices", () => {
  test("checks all four graphs and the conservative, source-matched notice corpus", async () => {
    const { manifest, files } = await checkClosureEvidence();
    expect(manifest.apps.map((app) => app.normal?.packages.length)).toEqual([225, 172, 236, 363]);
    expect(manifest.apps.map((app) => app.hostOnlyIds.length)).toEqual([28, 27, 28, 48]);
    expect(manifest.packages).toHaveLength(540);
    expect(files.size).toBe(3471);
    expect(manifest.files.filter((file) => file.role === "legal")).toHaveLength(2435);
    expect(manifest.packages.every((pkg) => pkg.status === "harvested-pending-content-audit")).toBe(
      true,
    );
    expect(manifest.packages.every((pkg) => pkg.gaps.length === 1)).toBe(true);
    expect(manifest.proof.declaredTargetGraphsResolved).toBe(true);
    expect(manifest.proof.exactReleasedBinaryClosureVerified).toBe(false);
    expect(manifest.proof.fullNoticeAuditComplete).toBe(false);
    expect(manifest.toolchain.upstreamBuildScriptsExecuted).toBe(false);
  });

  test("rejects a dropped package, missing notice descriptor or unpinned registry source", async () => {
    const missingPackage = await readClosureManifest();
    missingPackage.packages.pop();
    await expect(checkClosureEvidence(missingPackage)).rejects.toThrow(
      "incomplete matched package",
    );
    const missingFile = await readClosureManifest();
    const notice = missingFile.packages[0]!.files[0]!;
    missingFile.files = missingFile.files.filter((file) => file.path !== notice);
    await expect(checkClosureEvidence(missingFile)).rejects.toThrow("missing matched notice");
    const checksum = await readClosureManifest();
    checksum.sources.find((source) => source.kind === "crate")!.sha256 = "0".repeat(64);
    await expect(checkClosureEvidence(checksum)).rejects.toThrow(
      "registry notice is not lock-matched",
    );
  });

  test("rejects feature changes and host-only packages advertised as target-normal", async () => {
    const changed = await readClosureManifest();
    changed.apps[0]!.normal!.packages[0]!.features.push("invented-feature");
    await expect(checkClosureEvidence(changed)).rejects.toThrow(
      "normal dependency/feature graph mismatch",
    );
    const host = await readClosureManifest();
    host.apps[0]!.normal!.packages.push({ id: host.apps[0]!.hostOnlyIds[0]!, features: [] });
    await expect(checkClosureEvidence(host)).rejects.toThrow(
      "normal dependency/feature graph mismatch",
    );
  });

  test("does not accept full-audit or deployment claims, or a missing graph", async () => {
    const approved = await readClosureManifest();
    Object.assign(approved.proof, { fullNoticeAuditComplete: true });
    await expect(checkClosureEvidence(approved)).rejects.toThrow();
    const deployed = await readClosureManifest();
    Object.assign(deployed, { deployable: true });
    await expect(checkClosureEvidence(deployed)).rejects.toThrow();
    const missing = await readClosureManifest();
    missing.apps.pop();
    await expect(checkClosureEvidence(missing)).rejects.toThrow();
  });

  test("rejects unsafe source members and contradictory incomplete graph gates", async () => {
    const member = await readClosureManifest();
    member.files.find(
      (file) => file.role === "legal" && file.transform === "identity" && file.member,
    )!.member = "../LICENSE";
    await expect(checkClosureEvidence(member)).rejects.toThrow("unsafe/missing source member");
    const gate = await readClosureManifest();
    gate.proof.declaredTargetGraphsResolved = false;
    await expect(checkClosureEvidence(gate)).rejects.toThrow("graph-resolution gate contradicts");
  });

  test("pins the manifest so coordinated notice/reference removal cannot pass acquisition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyori-artcraft-manifest-pin-test-"));

    try {
      const manifest = await readClosureManifest();
      const pkg = manifest.packages[0]!;
      const removed = pkg.files.pop()!;
      manifest.files = manifest.files.filter((file) => file.path !== removed);
      await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(readClosureManifest(directory)).rejects.toThrow(
        "closure manifest checksum mismatch",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("detects legal-byte corruption in a copy without modifying retained legal material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyori-artcraft-closure-test-"));

    try {
      await cp(root, directory, { recursive: true });
      const manifest = await readClosureManifest(directory);
      const file = manifest.files.find((candidate) => candidate.role === "legal")!;
      const path = join(directory, file.path);
      const bytes = await readFile(path);
      bytes[0] = bytes[0]! ^ 1;
      await writeFile(path, bytes);
      await expect(checkClosureEvidence(manifest, directory)).rejects.toThrow("checksum mismatch");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("deployment manifest includes matched legal files, not local audit paths or machine usernames", async () => {
    const manifest = deploymentClosureManifest(await readClosureManifest());
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("/home/");
    expect(serialized).not.toContain("cargoBinary");
    expect(
      manifest.files.every(
        (file) => file.role === "legal" && file.path.startsWith("closure/packages/"),
      ),
    ).toBe(true);
    expect(
      manifest.packages.every((pkg) =>
        pkg.files.every((path) => manifest.files.some((file) => file.path === path)),
      ),
    ).toBe(true);
    expect(manifest.repositoryAuditEvidenceExcluded).toBe(true);
    expect(manifest.deployable).toBe(false);
  });
});

const metadata = cargoMetadataSchema.parse({
  packages: [
    {
      id: "root",
      name: "web",
      version: "1.0.0",
      source: null,
      manifest_path: "<source>/apps/web/Cargo.toml",
      license: "MIT",
      license_file: null,
      targets: [{ kind: ["bin"], crate_types: ["bin"] }],
    },
    {
      id: "registry-lib",
      name: "lib",
      version: "1.0.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
      manifest_path: "<cargo>/lib/Cargo.toml",
      license: "MIT",
      license_file: null,
      targets: [{ kind: ["lib"], crate_types: ["lib"] }],
    },
    {
      id: "git-lib",
      name: "lib",
      version: "1.0.0",
      source:
        "git+https://github.com/owner/lib?rev=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      manifest_path: "<cargo>/git/lib/Cargo.toml",
      license: "MIT",
      license_file: null,
      targets: [{ kind: ["lib"], crate_types: ["lib"] }],
    },
    {
      id: "macro",
      name: "derive",
      version: "1.0.0",
      source: "registry+https://github.com/rust-lang/crates.io-index",
      manifest_path: "<cargo>/derive/Cargo.toml",
      license: "MIT",
      license_file: null,
      targets: [{ kind: ["proc-macro"], crate_types: ["proc-macro"] }],
    },
  ],
});

describe("target graph and recipe contracts", () => {
  test("matches package sources, not just names/versions, and never imports host features", () => {
    const normalText =
      "0web v1.0.0 (<source>/apps/web)\\t\\tMIT\n1lib v1.0.0\\truntime\\tMIT\n1lib v1.0.0 (https://github.com/owner/lib?rev=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#aaaaaaaa)\\tgit-feature\\tMIT\n";

    const normal = parseTargetTree(normalText, metadata);
    assertNormalTargetTree(normal, metadata);
    expect(normal.packages.find((pkg) => pkg.id === "registry-lib")?.features).toEqual(["runtime"]);
    expect(normal.packages.find((pkg) => pkg.id === "git-lib")?.features).toEqual(["git-feature"]);
    const hostText = `${normalText}1derive v1.0.0 (proc-macro)\\tmacro-host\\tMIT\n2lib v1.0.0\\thost-only-feature\\tMIT\n`;
    expect(hostInclusiveIds(hostText, metadata)).toContain("macro");
    expect(() => parseTargetTree(hostText, metadata)).toThrow("Multiple feature units");
    expect(() =>
      assertNormalTargetTree({ packages: [{ id: "macro", features: [] }], edges: [] }, metadata),
    ).toThrow("Host proc macro");
  });

  test("rejects skipped parents, unknown package origins and malformed feature columns", () => {
    expect(() => parseTargetTree("2lib v1.0.0\\t\\tMIT", metadata)).toThrow("skipped a parent");
    expect(() =>
      parseTargetTree("0lib v1.0.0 (https://unrecognized/source)\\t\\tMIT", metadata),
    ).toThrow("Ambiguous/missing");
    expect(() => parseTargetTree("0lib v1.0.0", metadata)).toThrow("Unexpected cargo tree line");
  });

  test("changed tagged Trunk commands, selector features and hooks fail closed", async () => {
    const paths = [
      "packaging/web/package.sh",
      "packaging/env.sh",
      ".github/workflows/release.yml",
      "apps/wordcraft-web/Trunk.toml",
      "apps/wordcraft-web/index.html",
    ];

    const files = new Map<string, Buffer>();

    for (const path of paths)
      files.set(path, await readFile(new URL(`evidence/wordcraft/source/${path}`, root)));

    expect(declaredWebRecipe("wordcraft", files).command).toBe("trunk build --release");
    const feature = new Map(files);
    feature.set(
      "apps/wordcraft-web/index.html",
      Buffer.from(
        files
          .get("apps/wordcraft-web/index.html")!
          .toString()
          .replace('rel="rust"', 'rel="rust" data-cargo-features="extra"'),
      ),
    );
    expect(() => declaredWebRecipe("wordcraft", feature)).toThrow("feature selector");
    const hook = new Map(files);
    hook.set(
      "apps/wordcraft-web/Trunk.toml",
      Buffer.from(
        `${files.get("apps/wordcraft-web/Trunk.toml")!.toString()}\n[[hooks]]\nstage = "pre_build"\ncommand = "untrusted"\n`,
      ),
    );
    expect(() => declaredWebRecipe("wordcraft", hook)).toThrow();
    const script = new Map(files);
    script.set(
      "packaging/web/package.sh",
      Buffer.from(
        files
          .get("packaging/web/package.sh")!
          .toString()
          .replace("trunk build --release", "trunk build --release --all-features"),
      ),
    );
    expect(() => declaredWebRecipe("wordcraft", script)).toThrow("Unreviewed tagged web command");
  });

  test("retains attribution/third-party notices without treating them as a permission body", () => {
    const entries = new Map(
      ["ATTRIBUTION.md", "THIRD_PARTY_NOTICES.txt", "ACKNOWLEDGMENTS", "AUTHORS"].map((path) => [
        path,
        Buffer.from("credit only"),
      ]),
    );

    const notices = noticeMembers(entries, "", null);
    expect(notices.paths).toHaveLength(4);
    expect(notices.needsLicenseSupplement).toBe(true);
    expect(notices.gaps).toContain(
      "No standalone LICENSE/COPYING/COPYRIGHT body found; notice-only material needs a matching permission text",
    );
    entries.set("LICENSE-MIT", Buffer.from("permission text candidate"));
    expect(noticeMembers(entries, "", null).needsLicenseSupplement).toBe(false);
  });

  test("collects SPDX licence directories and sidecars without confusing unrelated packages", () => {
    const entries = new Map(
      [
        "LICENSES/MIT.txt",
        "LICENSES/Apache-2.0.txt",
        "crate/src/lib.rs.license",
        "other/LICENSE",
        "README.md",
      ].map((path) => [path, Buffer.from("notice")]),
    );

    const notice = noticeMembers(entries, "crate", null);
    expect(notice.paths).toEqual([
      "LICENSES/Apache-2.0.txt",
      "LICENSES/MIT.txt",
      "crate/src/lib.rs.license",
    ]);
    expect(noticeMembers(entries, "crate", "../../outside").gaps).toContain(
      "Declared license-file not available within pinned source: ../../outside",
    );
  });
});

describe("bounded Git/GNU source archive support", () => {
  test("validates the exact Git commit PAX comment and never accepts arbitrary PAX overrides", () => {
    const sha = "a".repeat(40);

    const bytes = tar([
      { name: "pax_global_header", type: "g", text: `52 comment=${sha}\n` },
      { name: "repo-sha/Cargo.toml", text: "manifest" },
    ]);

    expect(readGitSourceArchive(bytes, "repo-sha", sha).get("Cargo.toml")?.toString()).toBe(
      "manifest",
    );
    expect(() => readGitSourceArchive(bytes, "repo-sha", "b".repeat(40))).toThrow(
      "Unexpected Git archive metadata",
    );
    expect(() => readGitSourceArchive(tar([{ name: "repo-sha/a" }]), "repo-sha", sha)).toThrow(
      "Missing pinned Git archive header",
    );
  });

  test("supports bounded GNU long regular-file names, but rejects traversal, links and orphan metadata", () => {
    const name = `crate-1.0/${"long/".repeat(30)}LICENSE`;

    const bytes = tar([
      { name: "././@LongLink", type: "L", text: `${name}\0` },
      { name: name.slice(0, 100), text: "licence" },
    ]);

    expect(
      readCrateArchive(bytes, "crate-1.0").get(name.slice("crate-1.0/".length))?.toString(),
    ).toBe("licence");
    expect(() =>
      readCrateArchive(
        tar([
          { name: "././@LongLink", type: "L", text: "crate-1.0/../outside\0" },
          { name: "crate-1.0/../outside" },
        ]),
        "crate-1.0",
      ),
    ).toThrow("Unsafe tar path");
    expect(() =>
      readCrateArchive(tar([{ name: "././@LongLink", type: "L", text: `${name}\0` }]), "crate-1.0"),
    ).toThrow("Orphaned GNU");
    expect(() =>
      readCrateArchive(
        tar([
          { name: "././@LongLink", type: "L", text: `${name}\0` },
          { name: name.slice(0, 100), type: "2" },
        ]),
        "crate-1.0",
      ),
    ).toThrow("Unsupported tar entry");
  });
});
