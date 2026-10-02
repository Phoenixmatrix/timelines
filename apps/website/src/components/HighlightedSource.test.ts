import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { SemanticSource } from "../../shared/semantic/types.ts";
import { HighlightedSource } from "./HighlightedSource.tsx";

function render(text: string, tokens: SemanticSource["tokens"]): string {
  return renderToStaticMarkup(
    createElement("code", null, createElement(HighlightedSource, { text, tokens })),
  );
}

describe("HighlightedSource", () => {
  it("escapes source markup and rejects untrusted token classes", () => {
    const text = '<script>alert("x")</script><img src=x onerror="alert(1)">&';
    const markup = render(text, [
      {
        from: 0,
        to: text.length,
        className: 'tok-string evil-class constructor __proto__ "><svg/onload=alert(1)>',
      },
    ]);

    expect(markup.replace(/<span(?: class="[^"]*")?>|<\/span>/g, "")).toBe(
      renderToStaticMarkup(createElement("code", null, text)),
    );
    expect(markup).not.toMatch(/<(?:script|img|svg)\b/);
    expect(markup).not.toContain("evil-class");
    expect(markup).not.toContain("constructor");
    expect(markup).not.toContain("__proto__");
    expect(markup).not.toContain("onload");
  });

  it.each([
    { from: -1, to: 2 },
    { from: 1.5, to: 3 },
    { from: 1, to: 3.5 },
    { from: Number.NaN, to: 3 },
    { from: 1, to: Number.POSITIVE_INFINITY },
    { from: 3, to: 3 },
    { from: 4, to: 2 },
    { from: 0, to: 100 },
    { from: 100, to: 101 },
  ])("ignores invalid offsets $from..$to without losing source", (offsets) => {
    const text = "a<&𝛌\r\nz";
    expect(render(text, [{ ...offsets, className: "tok-keyword" }])).toBe(
      renderToStaticMarkup(createElement("code", null, text)),
    );
  });

  it("ignores overlapping and out-of-order tokens while preserving gaps and remaining text", () => {
    const text = "ab𝛌<&\r\nz";
    const markup = render(text, [
      { from: 2, to: 4, className: "tok-string" },
      { from: 3, to: 6, className: "tok-number" },
      { from: 0, to: 2, className: "tok-keyword" },
      { from: 4, to: 5, className: "tok-comment" },
      { from: 7, to: 8, className: "tok-string" },
    ]);

    expect(markup.replace(/<span(?: class="[^"]*")?>|<\/span>/g, "")).toBe(
      renderToStaticMarkup(createElement("code", null, text)),
    );
    expect(markup).not.toContain("text-signal");
    expect(markup).not.toContain("text-data-violet");
  });
});
