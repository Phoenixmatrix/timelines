import type { Parser, Tree } from "@lezer/common";

export type SemanticLanguage =
  | "typescript"
  | "tsx"
  | "rust"
  | "python"
  | "go"
  | "markdown"
  | "xml"
  | "json"
  | "html"
  | "css";

export type SemanticEntity =
  | "symbol"
  | "parameter"
  | "call"
  | "argument"
  | "import"
  | "section"
  | "link"
  | "element"
  | "attribute"
  | "property"
  | "rule"
  | "declaration"
  | "text";

/** UTF-16 offsets into the original source, matching Lezer and LSP positions. */
export interface SyntaxFact {
  key: string;
  entity: SemanticEntity;
  name: string;
  scope: string;
  nodeType: string;
  from: number;
  to: number;
  /** Syntax-normalized value; string literal contents must be preserved. */
  value: string;
  /** Name-independent syntax fingerprint, used only for unambiguous rename pairing. */
  shape?: string;
  /** Declaration header including parameters, return type and modifiers. */
  signature?: string;
}

export interface ParseDiagnostic {
  message: string;
  from: number;
  to: number;
}

export interface ParsedDocument {
  language: SemanticLanguage;
  tree: Tree;
  facts: SyntaxFact[];
  diagnostics: ParseDiagnostic[];
}

export interface LanguageAdapter {
  language: SemanticLanguage;
  extensions: readonly string[];
  parser: Parser;
  parse(source: string): ParsedDocument;
}

export interface SourcePosition {
  line: number;
  column: number;
}

export interface SemanticSource {
  path: string;
  start: SourcePosition;
  end: SourcePosition;
  text: string;
  truncated: boolean;
  /** Safe CSS token classes, never HTML. Offsets are relative to text. */
  tokens: { from: number; to: number; className: string }[];
}

export type SemanticChangeKind =
  | `${SemanticEntity}.added`
  | `${SemanticEntity}.removed`
  | `${SemanticEntity}.changed`
  | `${SemanticEntity}.renamed`
  | "symbol.signature_changed";

export interface SemanticChange {
  id: string;
  kind: SemanticChangeKind;
  language: SemanticLanguage;
  entity: SemanticEntity;
  name: string;
  previousName: string | null;
  scope: string;
  summary: string;
  /** Syntax facts do not claim type resolution or author intent. */
  evidence: "syntax";
  before: SemanticSource | null;
  after: SemanticSource | null;
}

export interface FileAnalysis {
  path: string;
  language: SemanticLanguage | null;
  status: "analyzed" | "unsupported" | "parse_error" | "too_large" | "binary";
  changes: SemanticChange[];
  diagnostics: ParseDiagnostic[];
}

export interface SemanticCommit {
  oid: string;
  parent: string | null;
  message: string;
  authorName: string;
  authoredAt: string;
}

export interface SemanticFeedEntry extends SemanticChange {
  commit: SemanticCommit;
  links: { commit: string; before: string | null; after: string | null };
}

export interface SemanticFeedResponse {
  version: 1;
  ref: string;
  /** Snapshot head pinned by the cursor, so pushes cannot shift pagination. */
  head: string | null;
  entries: SemanticFeedEntry[];
  nextCursor: string | null;
  coverage: {
    commit: string;
    path: string;
    status: FileAnalysis["status"];
    diagnostics: ParseDiagnostic[];
  }[];
}

export interface SemanticFixture {
  name: string;
  path: string;
  before: string;
  after: string;
  expected: { kind: SemanticChangeKind; name: string }[];
}
