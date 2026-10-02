import { expect, test } from "vite-plus/test";
import { analyzeFile } from "./index.ts";
import { documentAdapters } from "./documents.ts";
import { documentFixtures } from "./fixtures/documents.ts";

for (const fixture of documentFixtures) {
  test(fixture.name, () => {
    const result = analyzeFile(fixture.path, fixture.before, fixture.after);
    expect(result.status).toBe("analyzed");
    expect(result.diagnostics).toEqual([]);
    const actual = result.changes.map(({ kind, name }) => ({ kind, name }));
    const order = (a: { kind: string; name: string }, b: { kind: string; name: string }) =>
      `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`);
    expect(actual.sort(order)).toEqual([...fixture.expected].sort(order));
  });
}

for (const [path, before, after] of [
  ["config.json", '{"a":1}', '{"a":}'],
  ["config.xml", "<root><child/></root>", "<root><child></root>"],
  ["index.html", "<main></main>", "<main></other>"],
  ["style.css", ".a { color: red }", ".a { color: } }"],
]) {
  test(`${path}: invalid syntax suppresses semantic claims`, () => {
    const result = analyzeFile(path!, before!, after!);
    expect(result.status).toBe("parse_error");
    expect(result.changes).toEqual([]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.startsWith("After:"))).toBe(
      true,
    );
  });
}

test("invalid old syntax cannot fabricate removal events", () => {
  const result = analyzeFile("config.json", '{"a":}', '{"a":1}');
  expect(result.status).toBe("parse_error");
  expect(result.changes).toEqual([]);
});

test("nested names belong to independent scopes", () => {
  const result = analyzeFile(
    "config.json",
    '{"a":{"value":1},"b":{"value":1}}',
    '{"a":{"value":2},"b":{"value":3}}',
  );
  expect(result.changes.map((change) => [change.kind, change.name])).toEqual([
    ["property.changed", "value"],
    ["property.changed", "value"],
  ]);
  expect(result.changes[0]!.scope).not.toBe(result.changes[1]!.scope);
  expect(result.changes[0]!.id).not.toBe(result.changes[1]!.id);
});

test("duplicate XML elements retain their occurrence scope", () => {
  const result = analyzeFile(
    "config.xml",
    '<root><item value="a"/><item value="b"/></root>',
    '<root><item value="a"/><item value="c"/></root>',
  );
  expect(result.changes.map(({ kind, name }) => ({ kind, name }))).toEqual([
    { kind: "attribute.changed", name: "value" },
  ]);
  expect(result.changes[0]!.before!.text).toBe('value="b"');
  expect(result.changes[0]!.after!.text).toBe('value="c"');
});

test("source coordinates use UTF-16 even after astral text", () => {
  const before = '{"emoji":"😀","value":"old"}';
  const after = '{"emoji":"😀","value":"new"}';
  const result = analyzeFile("config.json", before, after);
  expect(result.changes.map(({ kind, name }) => ({ kind, name }))).toEqual([
    { kind: "property.changed", name: "value" },
  ]);
  expect(result.changes[0]!.after!.start).toEqual({ line: 1, column: after.indexOf('"new"') + 1 });
  expect(result.changes[0]!.after!.text).toBe('"new"');
});

test("literal whitespace remains observable inside CSS strings", () => {
  const adapter = documentAdapters.find((candidate) => candidate.language === "css")!;
  const parsed = adapter.parse('.a { content: "one  two"; width: 12px }');
  expect(parsed.diagnostics).toEqual([]);
  const content = parsed.facts.find((fact) => fact.name === "content")!;
  expect(content.value).toContain("one  two");
  expect(parsed.facts.find((fact) => fact.name === "width")!.value).toContain("12");
});

test("HTML whitespace between inline elements is meaningful", () => {
  const result = analyzeFile("index.html", "<p><b>a</b><i>b</i></p>", "<p><b>a</b> <i>b</i></p>");
  expect(result.changes.map(({ kind, name }) => ({ kind, name }))).toEqual([
    { kind: "text.added", name: "text" },
  ]);
});

test("XML space preservation includes whitespace-only text", () => {
  const result = analyzeFile(
    "config.xml",
    '<root xml:space="preserve">\n</root>',
    '<root xml:space="preserve">\n  </root>',
  );
  expect(result.changes.map(({ kind, name }) => ({ kind, name }))).toEqual([
    { kind: "text.changed", name: "text" },
  ]);
});

test("Markdown hard breaks are not folded into soft wraps", () => {
  const result = analyzeFile("readme.md", "hello\nworld", "hello  \nworld");
  expect(result.changes.map(({ kind, name }) => ({ kind, name }))).toEqual([
    { kind: "text.changed", name: "content" },
  ]);
});

test("Markdown code fences do not fabricate headings or links", () => {
  const result = analyzeFile(
    "readme.md",
    "```\n# not a heading\n[x](/one)\n```",
    "```\n# not a heading\n[x](/two)\n```",
  );
  expect(result.changes.map(({ kind, name }) => ({ kind, name }))).toEqual([
    { kind: "text.changed", name: "code" },
  ]);
});

test("CSS descendant and compound selectors stay distinct", () => {
  const result = analyzeFile("style.css", ".a .b {}", ".a.b {}");
  expect(
    result.changes
      .map(({ kind, name }) => ({ kind, name }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
  ).toEqual([
    { kind: "rule.added", name: ".a.b" },
    { kind: "rule.removed", name: ".a .b" },
  ]);
});

test("deleting a JSON file is different from parsing an empty invalid document", () => {
  const deleted = analyzeFile("config.json", '{"a":1}', null);
  expect(deleted.status).toBe("analyzed");
  expect(deleted.changes.map(({ kind, name }) => ({ kind, name }))).toEqual([
    { kind: "property.removed", name: "$" },
    { kind: "property.removed", name: "a" },
  ]);
  expect(analyzeFile("config.json", '{"a":1}', "").status).toBe("parse_error");
});
