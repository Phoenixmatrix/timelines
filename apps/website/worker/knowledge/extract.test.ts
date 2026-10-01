import { describe, expect, test } from "vite-plus/test";
import { extract, languageOf, resolveImport, skipReason } from "./extract.ts";

describe("extract", () => {
  test("finds TypeScript imports and exported symbols", () => {
    const source = [
      'import { Hono } from "hono";',
      'import type { AppEnv } from "../auth.ts";',
      'export { x } from "./x.ts";',
      "export async function proxy() {}",
      "function helper() {}",
      "export const gitHttp = new Hono();",
      "export interface Options {}",
      "type Local = string;",
    ].join("\n");
    const result = extract("worker/git/http.ts", source);
    expect(result.imports).toEqual(["hono", "../auth.ts", "./x.ts"]);
    expect(result.symbols.map((s) => [s.name, s.kind, s.exported])).toEqual([
      ["proxy", "function", true],
      ["helper", "function", false],
      ["gitHttp", "const", true],
      ["Options", "interface", true],
      ["Local", "type", false],
    ]);
  });

  test("finds Rust modules, uses and items", () => {
    const source =
      "mod ids;\npub mod revset;\nuse crate::output::Result;\npub fn open() {}\nstruct Inner;\npub enum Kind {}";
    const result = extract("apps/cli/src/repo/mod.rs", source);
    expect(result.imports).toEqual(["ids", "revset", "crate::output::Result"]);
    expect(result.symbols.map((s) => s.name)).toEqual(["open", "Inner", "Kind"]);
  });

  test("finds SQL tables", () => {
    const result = extract(
      "migrations/0001.sql",
      "CREATE TABLE accounts (\n  id TEXT\n);\nCREATE INDEX a_idx ON accounts (id);",
    );
    expect(result.symbols.map((s) => [s.name, s.kind])).toEqual([
      ["accounts", "table"],
      ["a_idx", "index"],
    ]);
  });
});

describe("resolveImport", () => {
  const files = new Set([
    "apps/website/worker/auth.ts",
    "apps/website/worker/git/pktline.ts",
    "apps/website/src/lib/index.ts",
    "apps/cli/src/output.rs",
    "apps/cli/src/repo/ids.rs",
    "apps/cli/src/repo/mod.rs",
  ]);

  test("resolves relative TypeScript imports with or without extensions", () => {
    expect(
      resolveImport("apps/website/worker/git/http.ts", "../auth.ts", "typescript", files),
    ).toEqual({
      type: "file",
      path: "apps/website/worker/auth.ts",
    });
    expect(
      resolveImport("apps/website/worker/git/http.ts", "./pktline", "typescript", files),
    ).toEqual({
      type: "file",
      path: "apps/website/worker/git/pktline.ts",
    });
    expect(resolveImport("apps/website/src/main.ts", "./lib", "typescript", files)).toEqual({
      type: "file",
      path: "apps/website/src/lib/index.ts",
    });
  });

  test("names packages, keeping npm scopes", () => {
    expect(resolveImport("a.ts", "@base-ui/react/menu", "typescript", files)).toEqual({
      type: "package",
      ecosystem: "npm",
      name: "@base-ui/react",
    });
    expect(resolveImport("a.ts", "cloudflare:workers", "typescript", files)).toEqual({
      type: "package",
      ecosystem: "platform",
      name: "cloudflare:workers",
    });
  });

  test("resolves Rust modules and crate paths", () => {
    expect(resolveImport("apps/cli/src/repo/mod.rs", "ids", "rust", files)).toEqual({
      type: "file",
      path: "apps/cli/src/repo/ids.rs",
    });
    expect(
      resolveImport("apps/cli/src/repo/mod.rs", "crate::output::Result", "rust", files),
    ).toEqual({
      type: "file",
      path: "apps/cli/src/output.rs",
    });
    expect(resolveImport("apps/cli/src/main.rs", "git2::Oid", "rust", files)).toEqual({
      type: "package",
      ecosystem: "crates",
      name: "git2",
    });
  });
});

test("skips files that aren't worth analyzing", () => {
  expect(skipReason("pnpm-lock.yaml", 100)).toBe("lockfile");
  expect(skipReason("src/fonts/a.woff2", 100)).toBe("binary");
  expect(skipReason("apps/website/worker-configuration.d.ts", 100)).toBe("generated");
  expect(skipReason("src/app.ts", 300_000)).toBe("too large");
  expect(skipReason("src/app.ts", 3000)).toBeNull();
  expect(languageOf("Cargo.toml")).toBe("toml");
});
