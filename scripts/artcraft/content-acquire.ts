import { acquireArtCraftFromArchives } from "./acquire.ts";

const [, , output, config] = process.argv;

if (!output || !config || process.argv.length !== 4)
  throw new Error(
    "Usage: bun scripts/artcraft/content-acquire.ts NEW_OUTPUT PUBLIC_ARCHIVE_CONFIG",
  );

console.log(await acquireArtCraftFromArchives(output, config));
