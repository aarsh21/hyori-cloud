import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import redistribution from "../../tooling/artcraft/redistribution.json" with { type: "json" };
import { checkClosureEvidence, closureNotice, deploymentClosureManifest } from "./closure.ts";
import {
  checkRedistributionEvidence,
  supplementalLegalFiles,
  supplement,
  symphoniaSourceNotice,
} from "./redistribution.ts";
import { contentDeliveryFiles } from "./content-delivery.ts";

/** One exact notice composition for acquisition and the verified runtime handoff. No downloads. */
export async function packageNoticeFiles() {
  const verified = await checkRedistributionEvidence();
  const closure = await checkClosureEvidence();
  const delivery = await contentDeliveryFiles();
  const files = new Map<string, Buffer>();

  function add(path: string, body: Buffer) {
    if (files.has(path)) throw new Error(`Duplicate composed notice: ${path}`);
    files.set(path, body);
  }

  for (const release of official.editors)
    for (const legal of release.legal)
      add(`legal/${legal.path.slice("licenses/".length)}`, verified.get(legal.path)!);

  for (const legal of [...supplementalLegalFiles(), supplement])
    add(`legal/${legal.path.slice("licenses/".length)}`, verified.get(legal.path)!);
  add("legal/redistribution.json", Buffer.from(`${JSON.stringify(redistribution, null, 2)}\n`));
  add("legal/SYMPHONIA-SOURCES.md", Buffer.from(symphoniaSourceNotice()));

  for (const file of closure.manifest.files.filter((file) => file.role === "legal"))
    add(`legal/closure/${file.path.slice("legal/".length)}`, closure.files.get(file.path)!);
  add(
    "legal/closure.json",
    Buffer.from(`${JSON.stringify(deploymentClosureManifest(closure.manifest), null, 2)}\n`),
  );
  add("legal/DEPENDENCY-NOTICES.md", Buffer.from(closureNotice(closure.manifest)));

  for (const [path, body] of delivery.files) add(path, body);

  return { files, closure: closure.manifest, delivery };
}
