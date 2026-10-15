import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { JANITOR_FILES } from "./maintenance.ts";

/** Relative modules a file loads at runtime (`import type` is erased). */
async function runtimeImports(name: string): Promise<string[]> {
  const source = await readFile(join(import.meta.dirname, name), "utf8");
  return [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"\.\/([^"]+)"/gm)].map(
    (match) => match[1]!,
  );
}

await test("the hourly janitor's copied files import only each other", async () => {
  for (const name of JANITOR_FILES)
    for (const imported of await runtimeImports(name))
      assert.ok(
        (JANITOR_FILES as readonly string[]).includes(imported),
        `${name} imports ./${imported}, which the janitor does not copy`,
      );
});
