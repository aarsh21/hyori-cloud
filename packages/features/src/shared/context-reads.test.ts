import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../", import.meta.url));

/**
 * React Compiler recognizes `use` only when it's imported straight from "react". Through the owned
 * facade it looks like a pure function, so the compiled build caches its first result: a context read
 * stops updating, while uncompiled tests still pass. `useContext` is recognized by its name.
 */
test("features never read context through a facade's `use`", () => {
  const offenders = readdirSync(SOURCE, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.tsx?$/.test(path) && !path.endsWith(".test.ts"))
    .filter((path) => /\buse\(/.test(readFileSync(`${SOURCE}${path}`, "utf8")));

  expect(offenders).toEqual([]);
});
