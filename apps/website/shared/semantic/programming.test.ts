import { expect, test } from "vite-plus/test";
import { analyzeFile } from "./index.ts";
import { programmingFixtures } from "./fixtures/programming.ts";

for (const fixture of programmingFixtures) {
  test(fixture.name, () => {
    const result = analyzeFile(fixture.path, fixture.before, fixture.after);
    expect(result.status).toBe("analyzed");
    expect(result.diagnostics).toEqual([]);
    expect(result.changes.map(({ kind, name }) => ({ kind, name }))).toEqual(
      expect.arrayContaining(fixture.expected),
    );
    expect(result.changes).toHaveLength(fixture.expected.length);
  });
}

for (const example of [
  {
    path: "code.ts",
    before: "function run(x:number){return target(x);}",
    after: "// comment\nfunction run ( x : number ) { /* body */ return target ( x ) }",
  },
  {
    path: "code.tsx",
    before: "function View(){return <Box count={1}/>;}",
    after: "/* comment */ function View () { return <Box count = { 1 } /> }",
  },
  {
    path: "code.rs",
    before: "fn run(x:i32){ target(x); }",
    after: "// comment\nfn run ( x : i32 ) { /* body */ target ( x ); }",
  },
  {
    path: "code.py",
    before: "def run(x):\n return target(x)\n",
    after: "# comment\ndef run( x ):\n    # body\n    return target( x )\n",
  },
  {
    path: "code.go",
    before: "package example\nfunc run(x int) { target(x) }",
    after: "package example\n// comment\nfunc run( x int ) { /* body */ target( x ); }",
  },
]) {
  test(`${example.path}: formatting and comments produce no changes`, () => {
    const result = analyzeFile(example.path, example.before, example.after);
    expect(result.status).toBe("analyzed");
    expect(result.changes).toEqual([]);
  });
}

for (const example of [
  { path: "broken.ts", source: "function broken( {" },
  { path: "broken.tsx", source: "const broken = <Box" },
  { path: "broken.rs", source: "fn broken( {" },
  { path: "broken.py", source: "def broken(:\n pass\n" },
  { path: "broken.go", source: "package example\nfunc broken( {" },
  { path: "literal.go", source: 'package example\nvar broken = "unterminated' },
]) {
  test(`${example.path}: parser errors suppress semantic claims`, () => {
    const result = analyzeFile(example.path, "", example.source);
    expect(result.status).toBe("parse_error");
    expect(result.changes).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.any(String),
          from: expect.any(Number),
          to: expect.any(Number),
        }),
      ]),
    );
  });
}

test("same method names stay qualified by their containing classes", () => {
  const result = analyzeFile(
    "classes.ts",
    "class A { run() { return 1; } } class B { run() { return 1; } }",
    "class A { run() { return 1; } } class B { run() { return 2; } }",
  );
  expect(
    result.changes
      .filter((change) => change.name === "run")
      .map((change) => ({ kind: change.kind, scope: change.scope })),
  ).toEqual([{ kind: "symbol.changed", scope: "B" }]);
});

test("duplicate calls retain independent argument evidence", () => {
  const result = analyzeFile(
    "calls.ts",
    "function run(){ target(1); target(1); }",
    "function run(){ target(1); target(2); }",
  );
  const argumentsChanged = result.changes.filter((change) => change.kind === "argument.changed");
  expect(
    argumentsChanged.map((change) => ({
      name: change.name,
      before: change.before?.text,
      after: change.after?.text,
    })),
  ).toEqual([{ name: "target argument 1", before: "1", after: "2" }]);
});

test("ambiguous equal-body renames stay additions and removals", () => {
  const result = analyzeFile(
    "rename.ts",
    "function a(){} function b(){}",
    "function c(){} function d(){}",
  );
  expect(result.changes.filter((change) => change.kind === "symbol.renamed")).toEqual([]);
  expect(result.changes.map((change) => change.kind).sort()).toEqual([
    "symbol.added",
    "symbol.added",
    "symbol.removed",
    "symbol.removed",
  ]);
});

test("references and member assignments are not invented declarations", () => {
  const result = analyzeFile(
    "members.py",
    "",
    "def run(value):\n value.field = other\n return value.field\n",
  );
  expect(
    result.changes.filter((change) => change.entity === "symbol").map((change) => change.name),
  ).toEqual(["run"]);
});

test("destructured bindings omit default-value references", () => {
  const result = analyzeFile(
    "bindings.ts",
    "",
    "const { first: renamed = fallback, second } = source;",
  );
  expect(
    result.changes
      .filter((change) => change.entity === "symbol")
      .map((change) => change.name)
      .sort(),
  ).toEqual(["renamed", "second"]);
});

test("export changes are part of the declaration signature", () => {
  const result = analyzeFile("export.ts", "function run() {}", "export function run() {}");
  expect(result.changes.map((change) => ({ kind: change.kind, name: change.name }))).toEqual([
    { kind: "symbol.signature_changed", name: "run" },
  ]);
});

test("decorator arguments affect Python declaration evidence", () => {
  const result = analyzeFile(
    "decorated.py",
    "@cache(1)\ndef run():\n pass\n",
    "@cache(2)\ndef run():\n pass\n",
  );
  expect(result.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "symbol.signature_changed", name: "run" }),
    ]),
  );
});

test("Go method receivers distinguish equal method names", () => {
  const result = analyzeFile(
    "methods.go",
    "package example\nfunc (a A) Run() { target(1) }\nfunc (b B) Run() { target(1) }",
    "package example\nfunc (a A) Run() { target(1) }\nfunc (b B) Run() { target(2) }",
  );
  expect(
    result.changes
      .filter((change) => change.name === "Run")
      .map((change) => ({ kind: change.kind, scope: change.scope })),
  ).toEqual([{ kind: "symbol.changed", scope: "B" }]);
});

test("Go built-in allocation arguments are calls rather than declarations", () => {
  const result = analyzeFile(
    "allocate.go",
    "package example\nfunc run() { make([]int, 1) }",
    "package example\nfunc run() { make([]int, 2) }",
  );
  expect(result.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "call.changed", name: "make" }),
      expect.objectContaining({ kind: "argument.changed", name: "make argument 2" }),
    ]),
  );
});

test("source ranges preserve non-ASCII strings and changed argument excerpts", () => {
  const result = analyzeFile(
    "unicode.ts",
    'function run(){ target("🙂 one"); }',
    'function run(){ target("🙂 two"); }',
  );
  const change = result.changes.find((change) => change.kind === "argument.changed");
  expect(change?.before?.text).toBe('"🙂 one"');
  expect(change?.after?.text).toBe('"🙂 two"');
  expect(change?.after?.start).toEqual({ line: 1, column: 24 });
});

test("Rust statement terminators retain block-value semantics", () => {
  const result = analyzeFile("value.rs", "fn value() { 1 }", "fn value() { 1; }");
  expect(result.changes).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "symbol.changed", name: "value" })]),
  );
});

test("automatic semicolon insertion is not mistaken for formatting", () => {
  const result = analyzeFile(
    "return.ts",
    "function run() { return target(); }",
    "function run() { return\n target(); }",
  );
  expect(result.changes).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "symbol.changed", name: "run" })]),
  );
});
