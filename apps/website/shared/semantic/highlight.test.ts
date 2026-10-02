import { describe, expect, it, vi } from "vite-plus/test";
import { highlightLines } from "./highlight.ts";
import { languageAdapters } from "./index.ts";
import { MAX_SOURCE_BYTES } from "./limits.ts";
import type { SemanticLanguage } from "./types.ts";

const samples: Record<SemanticLanguage, { text: string; token: string }> = {
  typescript: { text: "const value: number = 1;", token: "const" },
  tsx: { text: "const view = <div />;", token: "const" },
  rust: { text: "fn main() {}", token: "fn" },
  python: { text: "def main(): pass", token: "def" },
  go: { text: "package main", token: "package" },
  markdown: { text: "# Heading", token: "Heading" },
  xml: { text: '<root value="hello" />', token: '"hello"' },
  json: { text: '{"value":"hello"}', token: '"hello"' },
  html: { text: '<div title="hello"></div>', token: '"hello"' },
  css: { text: "a { color: red; }", token: "color" },
};

describe("file syntax highlighting", () => {
  for (const adapter of languageAdapters) {
    for (const extension of adapter.extensions) {
      it(`highlights ${extension} with the ${adapter.language} grammar`, () => {
        const sample = samples[adapter.language];
        const result = highlightLines(
          `directory.with.dots/FILE${extension.toUpperCase()}`,
          sample.text,
        );
        expect(result?.language).toBe(adapter.language);
        expect(
          result?.lines[0]?.some((token) =>
            sample.text.slice(token.from, token.to).includes(sample.token),
          ),
        ).toBe(true);
      });
    }
  }

  it("falls back for unknown filenames, dotted directories and binary text", () => {
    for (const path of ["README", "file.unknown", "dir.ts/README", "dir.ts\\README", "dir.ts/"]) {
      expect(highlightLines(path, "const value = 1;")).toBeNull();
    }
    expect(highlightLines("file.ts", "const value = '\0';")).toBeNull();
  });

  it("accepts the exact UTF-8 limit and rejects the first byte beyond it", () => {
    const text = "true".padEnd(MAX_SOURCE_BYTES, " ");
    expect(highlightLines("file.json", text)?.lines[0]).toEqual([
      { from: 0, to: 4, className: "tok-bool" },
    ]);
    expect(highlightLines("file.json", `${text} `)).toBeNull();

    const multibyte = `"${"界".repeat(Math.floor((MAX_SOURCE_BYTES - 2) / 3))}"`.padEnd(
      Math.floor((MAX_SOURCE_BYTES - 2) / 3) + 2 + ((MAX_SOURCE_BYTES - 2) % 3),
      " ",
    );
    expect(new TextEncoder().encode(multibyte).length).toBe(MAX_SOURCE_BYTES);
    expect(highlightLines("file.json", multibyte)?.lines[0]).toEqual([
      { from: 0, to: multibyte.trimEnd().length, className: "tok-string" },
    ]);
    expect(highlightLines("file.json", `${multibyte} `)).toBeNull();
  });

  it("clips multiline comments and strings at original UTF-16 line boundaries", () => {
    const text = "/* 😀\r\n\n界 */\nconst value = `α\n😀`;\n";
    const result = highlightLines("file.ts", text)!;
    expect(result.lines[0]).toEqual([{ from: 0, to: 6, className: "tok-comment" }]);
    expect(result.lines[1]).toEqual([]);
    expect(result.lines[2]).toEqual([{ from: 0, to: 4, className: "tok-comment" }]);
    expect(result.lines[3]).toContainEqual({ from: 14, to: 16, className: "tok-string2" });
    expect(result.lines[4]).toContainEqual({ from: 0, to: 3, className: "tok-string2" });

    const originalLines = text.replace(/\n$/, "").split("\n");
    expect(result.lines).toHaveLength(originalLines.length);
    for (const [index, tokens] of result.lines.entries()) {
      const original = originalLines[index]!;
      let cursor = 0;
      for (const token of tokens) {
        expect(token.from).toBeGreaterThanOrEqual(cursor);
        expect(token.to).toBeGreaterThan(token.from);
        expect(token.to).toBeLessThanOrEqual(original.length);
        cursor = token.to;
      }
    }
  });

  it("preserves empty lines while removing only the final LF row", () => {
    for (const [text, count] of [
      ["", 1],
      ["\n", 1],
      ["\n\n", 2],
      ["\r\n", 1],
      ["\r\n\r\n", 2],
    ] as const) {
      expect(highlightLines("file.ts", text)?.lines).toEqual(
        Array.from({ length: count }, () => []),
      );
    }
  });

  it("highlights malformed syntax from the recovery tree", () => {
    expect(highlightLines("file.ts", "const =")?.lines[0]).toContainEqual({
      from: 0,
      to: 5,
      className: "tok-keyword",
    });
  });

  it("falls back if a parser throws", () => {
    const adapter = languageAdapters.find((candidate) => candidate.language === "typescript")!;
    const parse = vi.spyOn(adapter.parser, "parse").mockImplementation(() => {
      throw new Error("Parser unavailable");
    });
    try {
      expect(highlightLines("file.ts", "const value = 1;")).toBeNull();
    } finally {
      parse.mockRestore();
    }
  });
});
