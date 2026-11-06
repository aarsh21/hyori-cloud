# Generated native-clock driver evidence

`driver.js` is an **unaltered generated execution artifact**, not handwritten JavaScript tooling. The canonical handwritten source is `scripts/artcraft/native-clock-driver.ts` (SHA-256 `55d434dc8290140ea32e73c1c0c42a9e4585a0c6113558cc850bbb2028a8efcf`).

The authored preparer `scripts/artcraft/native-clock-container.ts` bundled it with pinned Bun 1.4.4:

```ts
Bun.build({
  entrypoints: ["scripts/artcraft/native-clock-driver.ts"],
  target: "bun",
  format: "esm",
});
```

The retained output starts with Bun's generated `// @bun` / source-path header. Its exact SHA-256 is **`adc71077d092cd17d7e60d27a84bcad2569d9f9eeccd83deb43bd02672208e95`**, matching `probe-inputs.json.driverSha256`. This same bundle was mounted read-only as `/driver/driver.js` and executed inside the recorded network-none, unprivileged, read-only-root container. No vendor build script was executed on the host.

`receipt.json` remains byte-identical, SHA-256 **`a45e9f5ccc61cfe4affdc97d33c761b2f2fb14745441f1d082e587a5885d3a43`**. The executed driver, its hash, all original command/results and frozen source witnesses must not be reformatted or rewritten to satisfy handwritten-source lint. The generated bundle's compact spacing is Bun output; `require-readable-spacing` diagnostics there are not defects in the linted TypeScript source.

The repository's generated-artifact convention is described in `tooling/anti-slop/UPSTREAM.md` (Owned TypeScript versus third-party JavaScript) and implemented by the policy owner in `vite.config.ts`. If this artifact needs an additional policy entry, scope it to this **exact generated evidence file** in lint AND format, with this provenance and byte-integrity test; do not exclude all ArtCraft code, native patches or handwritten driver/preparer TypeScript. No anti-slop rule/plugin suppression or broad scope change is introduced here.

This is clock-only compilation evidence with the actual pinned egui type family. The probe used a dummy app type for unused snapshot fields; it is not proof that four native UI adapters/frame hookups compile, nor browser protocol2, storage durability, performance or product-launch acceptance.
