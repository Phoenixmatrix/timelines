// Where a symbol is defined in a file's text, found by reading the code the
// page shows (so line anchors match the ref being viewed, not the commit the
// knowledge graph described).

export interface Definition {
  name: string;
  /** 1-based line number, or null when the name isn't in this version of the file. */
  line: number | null;
  /** function, class, interface, type, enum, const, method, … or "symbol". */
  kind: string;
}

const KEYWORD_KIND: Record<string, string> = {
  function: "function",
  "function*": "function",
  def: "function",
  fn: "function",
  func: "function",
  class: "class",
  interface: "interface",
  type: "type",
  enum: "enum",
  const: "const",
  let: "variable",
  var: "variable",
  struct: "struct",
  trait: "trait",
  mod: "module",
  module: "module",
  namespace: "namespace",
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find each symbol's defining line and kind in `lines`. */
export function findDefinitions(lines: string[], names: string[]): Definition[] {
  return names.map((full) => {
    // "Store.apply" style names are defined as "apply" inside Store.
    const name = full.split(/[.#:]/).pop() ?? full;
    const word = escape(name);
    const declaration = new RegExp(
      `(?:^|[^\\w$])(function\\*?|def|fn|func|class|interface|type|enum|const|let|var|struct|trait|mod|module|namespace)\\s+${word}(?![\\w$])`,
    );
    const member = new RegExp(
      `^\\s*(?:(?:export|public|private|protected|static|async|readonly|override|get|set|pub)\\s+)*${word}\\s*[(<]`,
    );
    const mention = new RegExp(`(?:^|[^\\w$])${word}(?![\\w$])`);
    for (const [pattern, kindOf] of [
      [declaration, (m: RegExpExecArray) => KEYWORD_KIND[m[1] ?? ""] ?? "symbol"],
      [member, () => "method"],
      [mention, () => "symbol"],
    ] as const) {
      for (let i = 0; i < lines.length; i++) {
        const match = pattern.exec(lines[i] ?? "");
        if (match) return { name: full, line: i + 1, kind: kindOf(match) };
      }
    }
    return { name: full, line: null, kind: "symbol" };
  });
}
