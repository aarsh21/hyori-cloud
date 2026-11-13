import { sha256 } from "./evidence-bytes.ts";

/** Keep the PDF renderer/planner intact; replace only its browser print sink. */
export function patchPdfNativePrint(
  source: ReadonlyMap<string, Buffer>,
  rust: Buffer,
  javascript: Buffer,
) {
  const path = "crates/ui-egui/src/workflows/web_print.rs";
  const original = source.get(path);

  if (
    !original ||
    sha256(original) !== "82cc646485a812718398596e73ad5f262dc1399d529fc5319de37d48191f2226"
  )
    throw new Error("PDF print source missing or changed");
  const text = original.toString();
  const start = text.indexOf('#[cfg(target_arch = "wasm32")]\nthread_local!');
  const end = text.indexOf("#[cfg(test)]\nmod tests {", start);
  const module = "crates/ui-egui/hyori-pdf-print.js";

  if (start < 0 || end < start || source.has(module))
    throw new Error("PDF print source drift or duplicate application");
  const files = new Map(source);

  files.set(path, Buffer.from(`${text.slice(0, start)}${rust}\n${text.slice(end)}`));
  files.set(module, javascript);

  return {
    files,
    changes: [path, module].map((path) => ({
      path,
      before: source.has(path) ? sha256(source.get(path)!) : null,
      after: sha256(files.get(path)!),
    })),
  };
}
