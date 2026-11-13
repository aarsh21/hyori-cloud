import { sha256 } from "./evidence-bytes.ts";

export const nativeArtifactVersions = {
  wordcraft: "0.14.0-hyori-host.6",
  gridcraft: "0.15.0-hyori-host.5",
  pdfcraft: "0.17.0-hyori-host.5",
  deckcraft: "0.14.1-hyori-host.8",
} as const;

interface NativeFrameInputs {
  imports: Buffer;
  adapter: Buffer;
  frame: Buffer;
  clock: Buffer;
  hostJavaScript: Buffer;
}

/** Adds shared web source only. Per-app owners register modules and wire real eframe callbacks. */
export function patchNativeFrame(
  source: ReadonlyMap<string, Buffer>,
  app: keyof typeof nativeArtifactVersions,
  inputs: NativeFrameInputs,
) {
  const files = new Map(source);
  const root = `apps/${app}-web/src`;
  const path = `${root}/native_host.rs`;
  const nativeModule = app === "pdfcraft" ? "editing" : "app";

  if (
    !source
      .get(`crates/ui-egui/src/${nativeModule}/native_host.rs`)
      ?.includes(Buffer.from("pub struct NativeHostJob"))
  )
    throw new Error("Shared frame requires explicit native methods and intent/job types first");

  const exports = [
    "NativeHostFailure",
    "NativeHostIdentity",
    "NativeHostSnapshot",
    "NativeHostSaveReason",
    "NativeHostIntent",
    "NativeHostIntentFn",
  ].join(", ");

  // PDF's web crate reaches wasm-bindgen only through eframe; adding a direct dependency would
  // change its manifest and lock.
  const bindgen = app === "pdfcraft" ? "use eframe::wasm_bindgen;\n" : "";
  const header = `${bindgen}pub use eframe::egui;\npub use ${app}_ui_egui::{${exports}};\npub const NATIVE_ARTIFACT_VERSION: &str = "${nativeArtifactVersions[app]}";\n`;

  const added = new Map([
    [
      path,
      Buffer.concat([
        Buffer.from(header),
        inputs.imports,
        Buffer.from("\n"),
        inputs.adapter,
        Buffer.from("\n"),
        inputs.frame,
      ]),
    ],
    [`${root}/native_host/clock.rs`, inputs.clock],
    [`apps/${app}-web/hyori-native-host.js`, inputs.hostJavaScript],
  ]);

  for (const [path, body] of added) {
    if (source.has(path))
      throw new Error(`Refusing to replace shared native frame source: ${path}`);

    if (body.length === 0) throw new Error(`Missing authored native frame source: ${path}`);
    files.set(path, body);
  }

  const changes = [...added].map(([path, body]) => ({ path, before: null, after: sha256(body) }));

  return { files, changes, stage: "shared-native-frame-source-only-not-compiled" as const };
}
