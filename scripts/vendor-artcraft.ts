import { resolve } from "node:path";

import { acquireArtCraft } from "./artcraft/acquire.ts";

const destination = resolve(process.argv[2] ?? "tooling/artcraft/.generated/vendor");
const manifest = await acquireArtCraft(destination);

console.log(`Acquired checksum-verified ArtCraft artifacts: ${manifest}`);

console.log(
  "Not deployment approval: see the manifest's outstanding bridge, notice-audit and browser/fidelity checks.",
);
