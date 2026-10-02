import type { SemanticFixture } from "../types.ts";

const languages = [
  {
    extension: "ts",
    empty: "",
    declaration: (name: string, parameter = "") => `function ${name}(${parameter}) {}`,
    parameter: "value: number",
    call: (argument: string) => `function build() { return new Box(${argument}); }`,
    callee: "new Box",
  },
  {
    extension: "tsx",
    empty: "",
    declaration: (name: string, parameter = "") => `function ${name}(${parameter}) {}`,
    parameter: "value: number",
    call: (argument: string) => `function build() { return new Box(${argument}); }`,
    callee: "new Box",
  },
  {
    extension: "rs",
    empty: "",
    declaration: (name: string, parameter = "") => `fn ${name}(${parameter}) {}`,
    parameter: "value: i32",
    call: (argument: string) => `fn build() { Box::new(${argument}); }`,
    callee: "Box::new",
  },
  {
    extension: "py",
    empty: "",
    declaration: (name: string, parameter = "") => `def ${name}(${parameter}):\n    pass\n`,
    parameter: "value: int",
    call: (argument: string) => `def build():\n    return Box(${argument})\n`,
    callee: "Box",
  },
  {
    extension: "go",
    empty: "package example\n",
    declaration: (name: string, parameter = "") => `package example\nfunc ${name}(${parameter}) {}`,
    parameter: "value int",
    call: (argument: string) => `package example\nfunc build() { Box(${argument}) }`,
    callee: "Box",
  },
];

export const programmingFixtures: SemanticFixture[] = languages.flatMap(
  (language) =>
    [
      {
        name: `${language.extension}: declaration added`,
        path: `example.${language.extension}`,
        before: language.empty,
        after: language.declaration("added"),
        expected: [{ kind: "symbol.added", name: "added" }],
      },
      {
        name: `${language.extension}: declaration removed`,
        path: `example.${language.extension}`,
        before: language.declaration("removed"),
        after: language.empty,
        expected: [{ kind: "symbol.removed", name: "removed" }],
      },
      {
        name: `${language.extension}: unique declaration rename`,
        path: `example.${language.extension}`,
        before: language.declaration("oldName"),
        after: language.declaration("newName"),
        expected: [{ kind: "symbol.renamed", name: "newName" }],
      },
      {
        name: `${language.extension}: signature parameter added`,
        path: `example.${language.extension}`,
        before: language.declaration("run"),
        after: language.declaration("run", language.parameter),
        expected: [
          { kind: "symbol.signature_changed", name: "run" },
          { kind: "parameter.added", name: "value" },
        ],
      },
      {
        name: `${language.extension}: constructor call added`,
        path: `example.${language.extension}`,
        before: language.declaration("build"),
        after: language.call("1"),
        expected: [
          { kind: "symbol.changed", name: "build" },
          { kind: "call.added", name: language.callee },
          { kind: "argument.added", name: `${language.callee} argument 1` },
        ],
      },
      {
        name: `${language.extension}: constructor call removed`,
        path: `example.${language.extension}`,
        before: language.call("1"),
        after: language.declaration("build"),
        expected: [
          { kind: "symbol.changed", name: "build" },
          { kind: "call.removed", name: language.callee },
          { kind: "argument.removed", name: `${language.callee} argument 1` },
        ],
      },
      {
        name: `${language.extension}: constructor argument changed`,
        path: `example.${language.extension}`,
        before: language.call("1"),
        after: language.call("2"),
        expected: [
          { kind: "symbol.changed", name: "build" },
          { kind: "call.changed", name: language.callee },
          { kind: "argument.changed", name: `${language.callee} argument 1` },
        ],
      },
      {
        name: `${language.extension}: string whitespace is meaningful`,
        path: `example.${language.extension}`,
        before: language.call('"a b"'),
        after: language.call('"a  b"'),
        expected: [
          { kind: "symbol.changed", name: "build" },
          { kind: "call.changed", name: language.callee },
          { kind: "argument.changed", name: `${language.callee} argument 1` },
        ],
      },
    ] satisfies SemanticFixture[],
);

programmingFixtures.push(
  {
    name: "tsx: JSX text remains meaningful",
    path: "view.tsx",
    before: "function View() { return <p>Hello world</p>; }",
    after: "function View() { return <p>Hello  world</p>; }",
    expected: [{ kind: "symbol.changed", name: "View" }],
  },
  {
    name: "typescript: template literal interpolation formatting",
    path: "template.ts",
    before: "function view() { return `hello ${name}`; }",
    after: "function view() { return `hello ${ name /* note */ }`; }",
    expected: [],
  },
  {
    name: "python: format string interpolation formatting",
    path: "template.py",
    before: 'def view():\n return f"hello {name}"\n',
    after: 'def view():\n return f"hello { name }"\n',
    expected: [],
  },
  {
    name: "go: raw strings remain meaningful",
    path: "raw.go",
    before: "package example\nfunc build() { Box(`a b`) }",
    after: "package example\nfunc build() { Box(`a  b`) }",
    expected: [
      { kind: "symbol.changed", name: "build" },
      { kind: "call.changed", name: "Box" },
      { kind: "argument.changed", name: "Box argument 1" },
    ],
  },
  {
    name: "typescript: import added",
    path: "imports.ts",
    before: "",
    after: 'import "package";',
    expected: [{ kind: "import.added", name: '"package"' }],
  },
  {
    name: "tsx: import added",
    path: "imports.tsx",
    before: "",
    after: 'import "package";',
    expected: [{ kind: "import.added", name: '"package"' }],
  },
  {
    name: "rust: use declaration added",
    path: "imports.rs",
    before: "",
    after: "use std::io;",
    expected: [{ kind: "import.added", name: "std::io" }],
  },
  {
    name: "python: import added",
    path: "imports.py",
    before: "",
    after: "import os\n",
    expected: [{ kind: "import.added", name: "os" }],
  },
  {
    name: "go: import added",
    path: "imports.go",
    before: "package example\n",
    after: 'package example\nimport "fmt"\n',
    expected: [{ kind: "import.added", name: '"fmt"' }],
  },
);
