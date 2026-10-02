import { describe, expect, it } from "vite-plus/test";
import { analyzeFile } from "./index.ts";
import { MAX_SOURCE_BYTES } from "./limits.ts";

describe("semantic analysis coverage boundaries", () => {
  it("does not invent syntax changes for unsupported or binary content", () => {
    expect(analyzeFile("notes.txt", "before", "after")).toMatchObject({
      status: "unsupported",
      language: null,
      changes: [],
    });
    expect(analyzeFile("data.json", "{}", "\0binary")).toMatchObject({
      status: "binary",
      changes: [],
    });
  });

  it("counts UTF-8 bytes rather than UTF-16 units before parsing large source", () => {
    const source = JSON.stringify({ text: "界".repeat(Math.ceil(MAX_SOURCE_BYTES / 3)) });
    expect(source.length).toBeLessThan(MAX_SOURCE_BYTES);
    expect(analyzeFile("data.json", "{}", source)).toMatchObject({
      status: "too_large",
      changes: [],
    });
  });

  it("keeps absent files distinct from present empty invalid documents", () => {
    const deleted = analyzeFile("data.json", '{"enabled":true}', null);
    expect(deleted.status).toBe("analyzed");
    expect(deleted.changes).toContainEqual(
      expect.objectContaining({ kind: "property.removed", name: "enabled", after: null }),
    );
    expect(analyzeFile("data.json", '{"enabled":true}', "")).toMatchObject({
      status: "parse_error",
      changes: [],
    });
  });

  it("produces deterministic IDs and bounds large syntax excerpts", () => {
    const source = `const config = { text: "${"x".repeat(9_000)}" };`;
    const first = analyzeFile("config.ts", null, source);
    expect(first.status).toBe("analyzed");
    expect(analyzeFile("config.ts", null, source).changes).toEqual(first.changes);
    const symbol = first.changes.find(
      (change) => change.entity === "symbol" && change.name === "config",
    );
    expect(symbol?.after?.truncated).toBe(true);
    expect(symbol?.after?.text.length).toBe(8_000);
    expect(symbol?.after?.tokens.every((token) => token.from >= 0 && token.to <= 8_000)).toBe(true);
  });
});
