// The Durable Object conformance gate (CORE-197), as a pure function over
// source text so a test can run it on the real tree and on a fixture. Every
// class cloudflare.config.ts exports must be in DURABLE_CLASSES (with the
// binding the config gives it and the source worker/index.ts exports it
// from), implement purge, retire and storageReport, and no code outside
// worker/durable/ may build its own stub.

export interface ConformanceInput {
  /** cloudflare.config.ts. */
  config: string;
  /** worker/index.ts: `export { X as Name } from "path"`. */
  index: string;
  /** DURABLE_CLASSES, reduced to what the gate checks. */
  classes: Record<string, { binding: string; source: string }>;
  /** Every non-test source file (path relative to apps/website → text). */
  sources: Record<string, string>;
}

/** Calls that reach a namespace directly. */
const DIRECT = /(?:\.getByName|\.idFromName|\.idFromString|\.newUniqueId|\bgetAgentByName)\s*\(/g;
const CONTRACT = ["purge", "retire", "storageReport"];

export function conformanceProblems(input: ConformanceInput): string[] {
  const problems: string[] = [];
  const exported = [...input.config.matchAll(/(\w+):\s*exports\.durableObject\(/g)].map(
    (m) => m[1]!,
  );
  const bindings = new Map(
    [
      ...input.config.matchAll(
        /(\w+):\s*bindings\.durableObject\(\{[^}]*?exportName:\s*"(\w+)"[^}]*\}\)/g,
      ),
    ].map((m) => [m[2]!, m[1]!]),
  );
  const sources = new Map(
    [...input.index.matchAll(/export\s*\{\s*(\w+)(?:\s+as\s+(\w+))?\s*\}\s*from\s*"([^"]+)"/g)].map(
      (m) => [m[2] ?? m[1]!, { local: m[1]!, path: normalize(`worker/${m[3]!}`) }],
    ),
  );

  for (const name of exported) {
    const entry = input.classes[name];
    if (!entry) {
      problems.push(
        `${name}: exported from cloudflare.config.ts but not in DURABLE_CLASSES (worker/durable/classes.ts)`,
      );
      continue;
    }
    const binding = bindings.get(name);
    if (binding && binding !== entry.binding)
      problems.push(
        `${name}: DURABLE_CLASSES says binding ${entry.binding}, the config ${binding}`,
      );
    const source = sources.get(name);
    if (!source) {
      problems.push(`${name}: not exported from worker/index.ts`);
      continue;
    }
    if (source.path !== entry.source)
      problems.push(
        `${name}: DURABLE_CLASSES says ${entry.source}, worker/index.ts ${source.path}`,
      );
    const text = input.sources[source.path];
    if (text === undefined) {
      problems.push(`${name}: source ${source.path} not found`);
      continue;
    }
    const body = classBody(text, source.local);
    if (body === null) {
      problems.push(`${name}: class ${source.local} not found in ${source.path}`);
      continue;
    }
    if (!/\bimplements\s+(?:[\w.]+\s*,\s*)*Purgeable\b/.test(body.header))
      problems.push(`${name}: class ${source.local} must declare \`implements Purgeable\``);
    for (const method of CONTRACT)
      if (!new RegExp(`\\n\\s*(?:override\\s+)?(?:async\\s+)?${method}\\s*\\(`).test(body.text))
        problems.push(`${name}: class ${source.local} has no ${method}() (the purge contract)`);
  }
  for (const name of Object.keys(input.classes))
    if (!exported.includes(name))
      problems.push(`${name}: in DURABLE_CLASSES but not exported from cloudflare.config.ts`);

  for (const [path, text] of Object.entries(input.sources)) {
    if (path.startsWith("worker/durable/")) continue;
    for (const match of text.matchAll(DIRECT)) {
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(
        `${path}:${line}: ${match[0].replace(/\s*\($/, "")} outside worker/durable/; use durableStub (worker/durable/registry.ts)`,
      );
    }
  }
  return problems;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** The class's declaration line and body, by brace matching (good enough for our sources). */
function classBody(text: string, name: string): { header: string; text: string } | null {
  const start = new RegExp(`\\bclass\\s+${name}\\b[^{]*\\{`).exec(text);
  if (!start) return null;
  let depth = 0;
  for (let i = start.index + start[0].length - 1; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0)
      return { header: start[0], text: text.slice(start.index, i + 1) };
  }
  return { header: start[0], text: text.slice(start.index) };
}
