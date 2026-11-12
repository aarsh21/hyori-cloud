import { readFile } from "node:fs/promises";
import { join } from "node:path";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { patchDeckNativeHookup } from "./deck-native-hookup.ts";
import { patchDeckCraft } from "./deckcraft-patch.ts";
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";
import { patchGridNativeHookup } from "./grid-native-hookup.ts";
import { patchNativeChrome } from "./native-chrome-patch.ts";
import { nativeArtifactVersions, patchNativeFrame } from "./native-frame-patch.ts";
import { patchNativeMethods } from "./native-methods-patch.ts";
import { patchNativeMarks } from "./native-v3-marks.ts";
import { patchNativePolish } from "./native-v3-polish.ts";
import { patchPdfNativeHookup } from "./pdf-native-hookup.ts";
import { patchWordNativeHookup } from "./word-native-hookup.ts";

export type NativeApp = keyof typeof nativeArtifactVersions;

export const nativeApps = ["wordcraft", "gridcraft", "pdfcraft", "deckcraft"] as const;

export const nativeSourceCommits: Record<NativeApp, string> = {
  wordcraft: "5cd53f184aab11def13b7fced18727159b9bc96a",
  gridcraft: "30b210b4ef03b30616923465efa70766cefba379",
  pdfcraft: "7d78f3e14474b978be014715e0cc64895d77025a",
  deckcraft: "ee39ff67816d0039143ec7c98ea604cefe0cd2e5",
};

const patches = "tooling/artcraft/patches/native-host-v3";

/** Third-party packages compiled into the host bridge; their licences ship with every artifact. */
const bridgePackages = ["effect"] as const;

async function bundleHostEntry(minify: boolean) {
  const bundle = await Bun.build({
    entrypoints: [`${patches}/host-entry.ts`],
    target: "browser",
    format: "esm",
    minify,
  });

  if (!bundle.success || bundle.outputs.length !== 1)
    throw new Error(`Native host entry bundle failed: ${bundle.logs.join("\n")}`);

  return Buffer.from(await bundle.outputs[0]!.arrayBuffer());
}

async function hostBridgeLegal() {
  // The unminified bundle names every bundled module; refuse an unreviewed dependency.
  const annotated = (await bundleHostEntry(false)).toString();
  const roots = new Map<string, Set<string>>();

  for (const match of annotated.matchAll(/^\/\/ (\S*node_modules\/((?:@[^/]+\/)?[^/.][^/]*))\//gmu))
    roots.set(match[2]!, (roots.get(match[2]!) ?? new Set()).add(match[1]!));

  if ([...roots.keys()].sort().join() !== [...bridgePackages].join())
    throw new Error(
      `Native host bridge bundles unreviewed packages: ${[...roots.keys()].join(", ")}`,
    );

  const files = new Map<string, Buffer>();

  for (const name of bridgePackages) {
    const [root, ...others] = roots.get(name)!;

    if (others.length) throw new Error(`Native host bridge bundles two copies of ${name}`);
    const manifest = await readFile(join(root!, "package.json"));

    if (JSON.parse(manifest.toString()).name !== name)
      throw new Error(`Package root differs: ${name}`);
    files.set(`${name}/LICENSE`, await readFile(join(root!, "LICENSE")));
    files.set(`${name}/package.json`, manifest);
  }

  return files;
}

/** Authored inputs live in this repository; vendor source only comes from the pinned archive. */
export async function nativeAuthoredInputs() {
  const read = (name: string) => readFile(`${patches}/${name}`);

  return {
    hostJavaScript: await bundleHostEntry(true),
    hostLegal: await hostBridgeLegal(),
    types: await read("native-types.rs"),
    intents: await read("native-intent.rs"),
    imports: await read("native-imports.rs"),
    adapter: await read("native-adapter.rs"),
    frame: await read("native-frame.rs"),
    clock: await read("native-clock.rs"),
    css: await readFile("packages/ui/src/styles/globals.css"),
    favicon: await readFile("apps/web/public/favicon.ico"),
    icon: await readFile("apps/web/public/icon-192.png"),
    deckHostRust: await readFile("tooling/artcraft/patches/deckcraft-host-v1/host.rs"),
    deckHostJavaScript: await readFile(
      "tooling/artcraft/patches/deckcraft-host-v2/host-bridge.js.source",
    ),
    app: async (app: NativeApp) => {
      const prefix = { wordcraft: "word", gridcraft: "grid", pdfcraft: "pdf", deckcraft: "deck" }[
        app
      ];

      return {
        methods: await read(`${prefix}-native.rs`),
        jobs: await read(`${prefix}-jobs.rs`),
        frame: await read(`${prefix}-frame.rs`),
      };
    },
  };
}

export type NativeAuthoredInputs = Awaited<ReturnType<typeof nativeAuthoredInputs>>;

export function readPinnedSource(app: NativeApp, archive: Buffer) {
  const pin = official.editors.find((editor) => editor.app === app);

  if (!pin || sha256(archive) !== pin.sourceSha256)
    throw new Error(`${app} tagged source checksum mismatch`);

  return {
    pin,
    original: readGitSourceArchive(archive, `${app}-${pin.version}`, nativeSourceCommits[app]),
  };
}

/**
 * Full native host v3 source: direct methods/intents/jobs, app hookup, shared frame, Hyori chrome
 * palette and marks removal. Never mutates `original`; the returned delta is final-vs-tagged.
 */
export async function composeNativeSource(
  app: NativeApp,
  original: ReadonlyMap<string, Buffer>,
  authored: NativeAuthoredInputs,
  /** Observes each stage's whole tree as it completes, such as to measure upstream drift. */
  onStage?: (stage: string, files: ReadonlyMap<string, Buffer>) => void,
) {
  const own = await authored.app(app);
  const stages: string[] = [];
  let files = new Map(original);

  function completed(stage: string) {
    stages.push(stage);
    onStage?.(stage, files);
  }

  if (app === "deckcraft") {
    // Deck .3 composes over the retained host-engine APIs of .2 (frozen inputs, not re-authored).
    files = patchDeckCraft(files, {
      hostRust: authored.deckHostRust,
      hostJavaScript: authored.deckHostJavaScript,
    }).files;
    completed("deck-host-engine-base");
  }

  files = patchNativeMethods(files, app, {
    types: authored.types,
    intents: authored.intents,
    methods: own.methods,
    jobs: own.jobs,
  }).files;
  completed("direct-native-methods");

  if (app === "wordcraft") files = patchWordNativeHookup(files, own.frame).files;
  else if (app === "gridcraft") files = patchGridNativeHookup(files).files;
  else if (app === "pdfcraft") files = patchPdfNativeHookup(files).files;
  else files = patchDeckNativeHookup(files, own.frame).files;
  completed("app-native-hookup");

  files = patchNativeFrame(files, app, {
    imports: authored.imports,
    adapter: authored.adapter,
    frame: authored.frame,
    clock: authored.clock,
    hostJavaScript: authored.hostJavaScript,
  }).files;
  completed("shared-native-frame");

  const chrome = patchNativeChrome(files, app, authored.css);
  files = chrome.files;
  completed("hyori-chrome-palette");

  files = patchNativeMarks(files, app, { favicon: authored.favicon, icon: authored.icon });
  completed("marks-removed");

  if (app === "wordcraft" || app === "deckcraft") {
    files = patchNativePolish(files, app).files;
    completed("hyori-host-polish");
  }

  if (!files.get("Cargo.lock")?.equals(original.get("Cargo.lock")!))
    throw new Error(`${app} composition changed Cargo.lock`);

  for (const [path, body] of original)
    if (path.endsWith("Cargo.toml") && !files.get(path)?.equals(body))
      throw new Error(`${app} composition changed ${path}`);

  const changes = [...files].flatMap(([path, body]) => {
    const before = original.get(path);

    return before?.equals(body)
      ? []
      : [{ path, before: before ? sha256(before) : null, after: sha256(body) }];
  });

  for (const path of original.keys())
    if (!files.has(path)) throw new Error(`${app} composition removed ${path}`);

  return {
    version: nativeArtifactVersions[app],
    files,
    changes: changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    stages,
    paletteCssSha256: chrome.cssSha256,
    hostJavaScriptSha256: sha256(authored.hostJavaScript),
  };
}
