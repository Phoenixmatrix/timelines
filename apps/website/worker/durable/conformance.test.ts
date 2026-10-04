// The gate: a Durable Object class that isn't registered, or doesn't
// implement the purge contract, or code that builds its own stub, fails here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { DURABLE_CLASSES } from "./classes.ts";
import { conformanceProblems, type ConformanceInput } from "./conformance.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url).href);

function sourcesUnder(dir: string, into: Record<string, string> = {}) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry === "testing") continue;
    if (statSync(join(ROOT, path)).isDirectory()) sourcesUnder(path, into);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      into[relative(".", path)] = readFileSync(join(ROOT, path), "utf8");
  }
  return into;
}

function realTree(): ConformanceInput {
  return {
    config: readFileSync(join(ROOT, "cloudflare.config.ts"), "utf8"),
    index: readFileSync(join(ROOT, "worker/index.ts"), "utf8"),
    classes: DURABLE_CLASSES,
    sources: { ...sourcesUnder("worker"), ...sourcesUnder("registry"), ...sourcesUnder("shared") },
  };
}

describe("Durable Object conformance", () => {
  test("every class the config exports is registered and purgeable; no hand-built stubs", () => {
    const input = realTree();
    // The gate reads what it should: all seven classes and their sources.
    expect(Object.keys(input.classes).sort()).toEqual([
      "Assistant",
      "CiSandbox",
      "KnowledgeCoordinator",
      "RegistryLogin",
      "RegistryRepo",
      "RegistryUpload",
      "Tracker",
    ]);
    expect(conformanceProblems(input)).toEqual([]);
  });

  test("a non-conforming class and a direct stub fail the gate", () => {
    const input = realTree();
    const fixture: ConformanceInput = {
      ...input,
      config: input.config
        .replace(
          "Tracker: exports.durableObject(",
          'Rogue: exports.durableObject({ storage: "sqlite" }),\n        Tracker: exports.durableObject(',
        )
        .replace(
          "TRACKER: bindings.durableObject(",
          'ROGUE: bindings.durableObject({ worker: "gitmatrix", exportName: "Rogue" }),\n        TRACKER: bindings.durableObject(',
        ),
      index: `${input.index}\nexport { Rogue } from "./rogue.ts";\n`,
      sources: {
        ...input.sources,
        "worker/rogue.ts": [
          'import { DurableObject } from "cloudflare:workers";',
          "export class Rogue extends DurableObject<Env> {",
          "  hello() { return 1; }",
          "}",
          "export function rogue(env: Env) {",
          "  return env.ROGUE.getByName('x');",
          "}",
        ].join("\n"),
      },
    };
    expect(conformanceProblems(fixture)).toEqual([
      "Rogue: exported from cloudflare.config.ts but not in DURABLE_CLASSES (worker/durable/classes.ts)",
      "worker/rogue.ts:6: .getByName outside worker/durable/; use durableStub (worker/durable/registry.ts)",
    ]);
    // Registered, but without the contract.
    const registered = {
      ...fixture,
      classes: { ...fixture.classes, Rogue: { binding: "ROGUE", source: "worker/rogue.ts" } },
    };
    expect(conformanceProblems(registered)).toEqual([
      "Rogue: class Rogue must declare `implements Purgeable`",
      "Rogue: class Rogue has no purge() (the purge contract)",
      "Rogue: class Rogue has no retire() (the purge contract)",
      "Rogue: class Rogue has no storageReport() (the purge contract)",
      "worker/rogue.ts:6: .getByName outside worker/durable/; use durableStub (worker/durable/registry.ts)",
    ]);
    // A wrong binding, and a class registered that the config doesn't export.
    expect(
      conformanceProblems({
        ...input,
        classes: {
          ...input.classes,
          Tracker: { source: "worker/tracker/object.ts", binding: "TRACKERS" },
          Ghost: { binding: "GHOST", source: "worker/ghost.ts" },
        },
      }),
    ).toEqual([
      "Tracker: DURABLE_CLASSES says binding TRACKERS, the config TRACKER",
      "Ghost: in DURABLE_CLASSES but not exported from cloudflare.config.ts",
    ]);
  });
});
