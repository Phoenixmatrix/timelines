// DEVELOPMENT AND TESTS ONLY: a small multi-folder repository whose Atlas
// can be projected without a Knowledge build or a model (worker/atlas/fixture.ts,
// POST /api/dev/atlas). The live E2E pushes these files for real first, so
// source links from the Atlas open real blobs at the projected commit.
//
// Billing spans two folders that import each other (one capability, two
// areas); search and operations are capabilities of their own; misc has no
// evidence and stays unclassified. The "merged" variant ties operations into
// search, so a later build retires operations' capability (merged, with
// search as its successor).

export interface AtlasFixtureFile {
  path: string;
  /** Other fixture files it imports. */
  imports: string[];
  /** Canonical concepts it mentions. */
  concepts: string[];
  /** Functions it defines. */
  symbols?: string[];
  /** External packages it imports. */
  packages?: string[];
}

export type AtlasFixtureVariant = "base" | "merged";

const all = (paths: string[], concept: string): AtlasFixtureFile[] =>
  paths.map((path) => ({
    path,
    imports: paths.filter((other) => other !== path),
    concepts: [concept],
  }));

export function atlasFixtureFiles(variant: AtlasFixtureVariant = "base"): AtlasFixtureFile[] {
  const ledger = [
    "billing/ledger/ledger.ts",
    "billing/ledger/entry.ts",
    "billing/ledger/balance.ts",
    "billing/ledger/audit.ts",
  ];
  const invoices = [
    "billing/invoices/invoice.ts",
    "billing/invoices/render.ts",
    "billing/invoices/send.ts",
    "billing/invoices/tax.ts",
  ];
  const search = [
    "search/index.ts",
    "search/query.ts",
    "search/rank.ts",
    "search/tokens.ts",
    "search/store.ts",
    "search/cache.ts",
  ];
  const ops = ["ops/deploy.ts", "ops/health.ts", "ops/logs.ts"];
  const files: AtlasFixtureFile[] = [
    ...all(ledger, "ledger"),
    ...all(invoices, "invoicing"),
    ...all(search, "search"),
    ...all(ops, variant === "merged" ? "search" : "operations"),
    ...["misc/notes.ts", "misc/scratch.ts", "misc/legacy.ts", "misc/todo.ts"].map((path) => ({
      path,
      imports: [],
      concepts: [],
    })),
  ];
  const byPath = new Map(files.map((f) => [f.path, f]));
  // The two billing folders lean on each other: one capability, two areas.
  byPath.get("billing/invoices/invoice.ts")!.imports.push("billing/ledger/ledger.ts");
  byPath.get("billing/ledger/balance.ts")!.imports.push("billing/invoices/tax.ts");
  for (const f of files) if (f.path.startsWith("billing/")) f.concepts.push("billing");
  byPath.get("billing/ledger/ledger.ts")!.symbols = ["post", "reverse"];
  byPath.get("search/query.ts")!.symbols = ["parseQuery"];
  byPath.get("search/index.ts")!.packages = ["hono"];
  if (variant === "merged")
    // Operations now runs through search everywhere: one capability.
    for (const o of ops) for (const s of search) byPath.get(o)!.imports.push(s);
  return files;
}

/**
 * The source pushed for a fixture file, its imports and functions really
 * there, and the line each function starts on.
 */
export function atlasFixtureSource(file: AtlasFixtureFile): {
  text: string;
  lines: Record<string, number>;
} {
  const out = [`// ${file.path}: Atlas fixture (${file.concepts.join(", ") || "no concept"}).`];
  for (const target of file.imports) out.push(`import "${relative(file.path, target)}";`);
  for (const pkg of file.packages ?? []) out.push(`import "${pkg}";`);
  const lines: Record<string, number> = {};
  for (const name of file.symbols ?? []) {
    out.push("");
    out.push(`export function ${name}() {}`);
    lines[name] = out.length;
  }
  return { text: `${out.join("\n")}\n`, lines };
}

function relative(from: string, to: string): string {
  const a = from.split("/").slice(0, -1);
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return `${up ? "../".repeat(up) : "./"}${b.slice(i).join("/")}`;
}
