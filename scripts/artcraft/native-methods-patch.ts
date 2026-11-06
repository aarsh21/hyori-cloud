import { sha256 } from "./evidence-bytes.ts";

type NativeApp = "wordcraft" | "gridcraft" | "pdfcraft" | "deckcraft";

export interface NativeMethodInputs {
  types: Buffer;
  methods: Buffer;
  intents?: Buffer;
  jobs?: Buffer;
}

/** Source-only stage. This adds direct native methods; it does NOT connect a web bridge,
 * change versions/marks or authorize a build. The complete source delta is recomputed later. */
export function patchNativeMethods(
  source: ReadonlyMap<string, Buffer>,
  app: NativeApp,
  input: NativeMethodInputs,
) {
  const files = new Map(source);
  const parent = app === "pdfcraft" ? "editing" : "app";
  const module = `crates/ui-egui/src/${parent}/native_host.rs`;
  const owner = `crates/ui-egui/src/${parent}.rs`;
  const lib = "crates/ui-egui/src/lib.rs";
  let types = "NativeHostFailure, NativeHostIdentity, NativeHostSnapshot, NativeHostSaveReason";

  if (input.jobs && !input.intents)
    throw new Error("Native job source requires the explicit shared intent types");

  if (input.intents)
    types += ", NativeHostIntent, NativeHostIntentFn, NativeHostSerializer, NativeHostContinuation, NativeHostJob";

  if (files.has(module))
    throw new Error(`Refusing to replace an existing native method module: ${module}`);

  if (
    app === "deckcraft" &&
    !files.get("crates/engine/src/lib.rs")?.includes(Buffer.from("pub fn mark_host_saved"))
  )
    throw new Error(
      "Deck native methods require the retained host engine APIs as their explicit source base",
    );

  function replace(path: string, before: string, after: string) {
    const original = files.get(path);

    if (!original) throw new Error(`Native method source missing: ${path}`);
    const text = original.toString();
    const index = text.indexOf(before);

    if (index < 0 || text.indexOf(before, index + before.length) >= 0)
      throw new Error(`Native method source anchor missing/duplicated: ${path}: ${before}`);
    files.set(path, Buffer.from(text.replace(before, after)));
  }

  const anchor = app === "pdfcraft" ? "mod close;" : "mod commands;";
  replace(owner, anchor, `${anchor}\nmod native_host;\npub use native_host::{${types}};`);
  replace(lib, `mod ${parent};`, `mod ${parent};\npub use ${parent}::{${types}};`);
  const bodies = [input.types];

  if (input.intents) bodies.push(input.intents);
  bodies.push(input.methods);

  if (input.jobs) bodies.push(input.jobs);
  files.set(module, Buffer.concat(bodies.flatMap((body, index) => index ? [Buffer.from("\n"), body] : [body])));

  const changes = [...files].flatMap(([path, body]) => {
    const original = source.get(path);

    return original?.equals(body)
      ? []
      : [{ path, before: original ? sha256(original) : null, after: sha256(body) }];
  });

  return { files, changes, stage: "direct-native-methods-only-not-connected" as const };
}
