import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { test } from "node:test";
import { JANITOR_FILES, REMOTE_JANITOR_ONLY } from "./maintenance.ts";

interface Reference {
  /** null: a dynamic import of something other than a string literal. */
  specifier: string | null;
  form: "import" | "export" | "side-effect" | "dynamic";
}

// Not preceded by an identifier character or a member access (`x.import`).
const STATIC =
  /(?<![\w$.])(import|export)(\s+type\b)?\s*((?:(?!\b(?:import|export)\b)[^;'"()=])*?)\bfrom\s*(['"])([^'"\n]+)\4/g;
const SIDE_EFFECT = /(?<![\w$.])import\s*(['"])([^'"\n]+)\1/g;
const DYNAMIC = /(?<![\w$.])import\s*\(([^)]*)\)/g;

/**
 * Modules a source loads at runtime. `import type` and `export type … from` are erased;
 * `import { type X } from` is not (Node keeps the empty import).
 */
function moduleReferences(source: string): Reference[] {
  const references: Reference[] = [];
  for (const match of source.matchAll(STATIC))
    if (!match[2]) references.push({ specifier: match[5]!, form: match[1] as "import" | "export" });
  for (const match of source.matchAll(SIDE_EFFECT))
    references.push({ specifier: match[2]!, form: "side-effect" });
  for (const match of source.matchAll(DYNAMIC)) {
    const literal = /^\s*(['"])([^'"\n]+)\1\s*$/.exec(match[1]!);
    references.push({ specifier: literal ? literal[2]! : null, form: "dynamic" });
  }
  return references;
}

/**
 * Walks the runtime imports reachable from `roots` (paths relative to tools/agent) and
 * returns every one the copied janitor could not load: a relative module outside `copied`,
 * a bare package (only `node:` builtins are available), or a dynamic import that is not a
 * string literal. `allowed` lists, per file, specifiers its janitor dispatch never reaches.
 */
function janitorViolations(input: {
  roots: readonly string[];
  copied: readonly string[];
  read: (name: string) => string;
  allowed?: Record<string, readonly string[]>;
}): { violations: string[]; visited: Set<string> } {
  const copied = new Set(input.copied.map((name) => posix.normalize(name)));
  const visited = new Set<string>();
  const violations: string[] = [];
  const pending = input.roots.map((name) => posix.normalize(name));
  while (pending.length) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    for (const { specifier, form } of moduleReferences(input.read(name))) {
      if (specifier === null) {
        violations.push(`${name}: a dynamic import of a non-literal cannot be checked`);
        continue;
      }
      if (specifier.startsWith("node:")) continue;
      if (input.allowed?.[name]?.includes(specifier)) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        violations.push(`${name}: ${form} of the package ${specifier}, which the janitor lacks`);
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(name), specifier));
      if (!copied.has(target)) {
        violations.push(`${name}: ${form} of ${specifier}, which the janitor does not copy`);
        continue;
      }
      pending.push(target);
    }
  }
  return { violations, visited };
}

const read = (name: string) => readFileSync(join(import.meta.dirname, name), "utf8");

await test("the hourly janitor's environment.ts loads only files it copies", () => {
  const { violations, visited } = janitorViolations({
    roots: ["environment.ts"],
    copied: JANITOR_FILES,
    read,
  });
  assert.deepEqual(violations, []);
  assert.ok(visited.has("heavy.ts") && visited.has("reservations.ts"), "the walk is transitive");
});

await test("the remote janitor's entry.ts loads only files it copies on the cleanup path", () => {
  const { violations, visited } = janitorViolations({
    roots: ["entry.ts"],
    copied: [...JANITOR_FILES, ...REMOTE_JANITOR_ONLY],
    read,
    // entry.ts dispatches `--execution cloudflare cleanup --expired` to remote.ts; the
    // local branches that load these are never reached there.
    allowed: { "entry.ts": ["./main.ts", "./main-e2e.ts"] },
  });
  assert.deepEqual(violations, []);
  for (const name of [
    "remote.ts",
    "maintenance.ts",
    "environment.ts",
    "../remote/cloudflare.config.ts",
  ])
    assert.ok(visited.has(name), `the walk reaches ${name}`);
});

await test("every file a janitor copies exists", () => {
  for (const name of [...JANITOR_FILES, ...REMOTE_JANITOR_ONLY])
    assert.doesNotThrow(() => read(name));
});

await test("the scanner detects every module-reference form", () => {
  const references = moduleReferences(`
import {
  a,
  b,
} from "./multi-line.ts";
import single from './single.ts';
import "./side-effect.ts";
import './side-effect-single.ts';
export * from "./star.ts";
export { c } from './named.ts';
const late = await import("./dynamic.ts");
const other = await import('./dynamic-single.ts');
import { type Kept } from "./inline-type.ts";
import type { Erased } from "./type-only.ts";
import type {
  AlsoErased,
} from "./type-only-multi-line.ts";
export type { Gone } from "./export-type.ts";
const meta = import.meta.url;
const computed = await import(name);
`);
  assert.deepEqual(references, [
    { specifier: "./multi-line.ts", form: "import" },
    { specifier: "./single.ts", form: "import" },
    { specifier: "./star.ts", form: "export" },
    { specifier: "./named.ts", form: "export" },
    { specifier: "./inline-type.ts", form: "import" },
    { specifier: "./side-effect.ts", form: "side-effect" },
    { specifier: "./side-effect-single.ts", form: "side-effect" },
    { specifier: "./dynamic.ts", form: "dynamic" },
    { specifier: "./dynamic-single.ts", form: "dynamic" },
    { specifier: null, form: "dynamic" },
  ]);
});

await test("the walk fails modules outside the copied set, bare packages and computed imports", () => {
  const sources: Record<string, string> = {
    "root.ts": `import { a } from "./a.ts";\nimport { readFile } from "node:fs/promises";\nimport "../outside.ts";`,
    "a.ts": `export * from './missing.ts';\nimport pad from "left-pad";\nimport fs from "fs";\nconst x = await import(\`./\${name}.ts\`);\nconst y = await import("./allowed.ts");`,
    "../shared/b.ts": "export const b = 1;",
    "c.ts": `import { b } from "../shared/b.ts";`,
  };
  const { violations, visited } = janitorViolations({
    roots: ["root.ts", "c.ts"],
    copied: ["root.ts", "a.ts", "c.ts", "../shared/b.ts"],
    read: (name) => sources[name]!,
    allowed: { "a.ts": ["./allowed.ts"] },
  });
  assert.deepEqual(violations.toSorted(), [
    "a.ts: a dynamic import of a non-literal cannot be checked",
    "a.ts: export of ./missing.ts, which the janitor does not copy",
    "a.ts: import of the package fs, which the janitor lacks",
    "a.ts: import of the package left-pad, which the janitor lacks",
    "root.ts: side-effect of ../outside.ts, which the janitor does not copy",
  ]);
  assert.ok(visited.has("../shared/b.ts"), "a copied ../ path resolves and is walked");
});
