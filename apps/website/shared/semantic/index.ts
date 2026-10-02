import { classHighlighter, highlightTree } from "@lezer/highlight";
import { documentAdapters } from "./documents.ts";
import { programmingAdapters } from "./programming.ts";
import { MAX_SOURCE_BYTES } from "./limits.ts";
import type {
  FileAnalysis,
  ParsedDocument,
  SemanticChangeKind,
  SemanticSource,
  SourcePosition,
  SyntaxFact,
} from "./types.ts";

export const ANALYSIS_VERSION = 1;
const MAX_FACTS = 10_000;
const MAX_EXCERPT = 8_000;
export const languageAdapters = [...programmingAdapters, ...documentAdapters];

function adapterFor(path: string) {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return languageAdapters.find((adapter) => adapter.extensions.includes(extension));
}

/** Deterministic identifier, not a security or content-integrity primitive. */
function identifier(parts: string[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= BigInt(part.charCodeAt(i));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    hash ^= 0xffn;
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function sourceReader(path: string, text: string, document: ParsedDocument) {
  const lines = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines.push(i + 1);
  const tokens: SemanticSource["tokens"] = [];
  highlightTree(document.tree, classHighlighter, (from, to, className) => {
    tokens.push({ from, to, className });
  });
  const position = (offset: number): SourcePosition => {
    let low = 0;
    let high = lines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle]! <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - lines[low]! + 1 };
  };
  return (fact: SyntaxFact): SemanticSource => {
    const end = Math.min(fact.to, fact.from + MAX_EXCERPT);
    let low = 0;
    let high = tokens.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tokens[middle]!.to <= fact.from) low = middle + 1;
      else high = middle;
    }
    const excerptTokens: SemanticSource["tokens"] = [];
    for (let i = low; i < tokens.length && tokens[i]!.from < end; i++) {
      const token = tokens[i]!;
      excerptTokens.push({
        from: Math.max(token.from, fact.from) - fact.from,
        to: Math.min(token.to, end) - fact.from,
        className: token.className,
      });
    }
    return {
      path,
      start: position(fact.from),
      end: position(fact.to),
      text: text.slice(fact.from, end),
      truncated: end < fact.to,
      tokens: excerptTokens,
    };
  };
}

function matchingGroups(facts: SyntaxFact[], key: (fact: SyntaxFact) => string) {
  const result = new Map<string, SyntaxFact[]>();
  for (const fact of facts) {
    const group = key(fact);
    const existing = result.get(group);
    if (existing) existing.push(fact);
    else result.set(group, [fact]);
  }
  return result;
}

/** Pure, source-aligned syntax comparison. No filesystem, network, or author-intent inference. */
export function analyzeFile(
  path: string,
  before: string | null,
  after: string | null,
): FileAnalysis {
  const adapter = adapterFor(path);
  const result: FileAnalysis = {
    path,
    language: adapter?.language ?? null,
    status: adapter ? "analyzed" : "unsupported",
    changes: [],
    diagnostics: [],
  };
  if (!adapter) return result;
  if (before?.includes("\0") || after?.includes("\0")) {
    result.status = "binary";
    return result;
  }
  const encoder = new TextEncoder();
  if (
    (before !== null &&
      (before.length > MAX_SOURCE_BYTES || encoder.encode(before).length > MAX_SOURCE_BYTES)) ||
    (after !== null &&
      (after.length > MAX_SOURCE_BYTES || encoder.encode(after).length > MAX_SOURCE_BYTES))
  ) {
    result.status = "too_large";
    return result;
  }
  if (before === after) return result;
  const oldDocument = adapter.parse(before ?? "");
  const newDocument = adapter.parse(after ?? "");
  result.diagnostics = [
    ...(before === null
      ? []
      : oldDocument.diagnostics.map((d) => ({ ...d, message: `Before: ${d.message}` }))),
    ...(after === null
      ? []
      : newDocument.diagnostics.map((d) => ({ ...d, message: `After: ${d.message}` }))),
  ];
  if (result.diagnostics.length) {
    result.status = "parse_error";
    return result;
  }
  const oldFacts = before === null ? [] : oldDocument.facts;
  const newFacts = after === null ? [] : newDocument.facts;
  if (oldFacts.length + newFacts.length > MAX_FACTS) {
    result.status = "too_large";
    result.diagnostics.push({
      message: "Syntax fact limit exceeded; use the ordinary diff.",
      from: 0,
      to: 0,
    });
    return result;
  }
  const oldSource = sourceReader(path, before ?? "", oldDocument);
  const newSource = sourceReader(path, after ?? "", newDocument);
  const usedOld = new Set<SyntaxFact>();
  const usedNew = new Set<SyntaxFact>();
  const emit = (
    kind: SemanticChangeKind,
    oldFact: SyntaxFact | null,
    newFact: SyntaxFact | null,
  ) => {
    const fact = (newFact ?? oldFact)!;
    const action = kind.slice(kind.indexOf(".") + 1);
    const subject = `${fact.entity} ${fact.name}`;
    const summary =
      action === "renamed"
        ? `Renamed ${fact.entity} ${oldFact!.name} to ${newFact!.name}`
        : action === "signature_changed"
          ? `Changed signature of ${fact.name}`
          : `${action[0]!.toUpperCase()}${action.slice(1)} ${subject}`;
    result.changes.push({
      id: identifier([
        path,
        kind,
        oldFact?.key ?? "",
        newFact?.key ?? "",
        oldFact?.value ?? "",
        newFact?.value ?? "",
      ]),
      kind,
      language: adapter.language,
      entity: fact.entity,
      name: fact.name,
      previousName: action === "renamed" ? oldFact!.name : null,
      scope: fact.scope,
      summary,
      evidence: "syntax",
      before: oldFact ? oldSource(oldFact) : null,
      after: newFact ? newSource(newFact) : null,
    });
  };
  const compare = (oldFact: SyntaxFact, newFact: SyntaxFact) => {
    usedOld.add(oldFact);
    usedNew.add(newFact);
    if (oldFact.signature !== newFact.signature && oldFact.entity === "symbol") {
      emit("symbol.signature_changed", oldFact, newFact);
    } else if (oldFact.value !== newFact.value) {
      emit(`${newFact.entity}.changed`, oldFact, newFact);
    }
  };
  const identity = (fact: SyntaxFact) => `${fact.entity}\0${fact.key}`;
  const oldGroups = matchingGroups(oldFacts, identity);
  const newGroups = matchingGroups(newFacts, identity);
  for (const [key, oldGroup] of oldGroups) {
    const newGroup = newGroups.get(key);
    if (!newGroup) continue;
    // Repeated identical calls/properties are a multiset, not a single map entry.
    for (const oldFact of oldGroup) {
      const match = newGroup.find(
        (fact) =>
          !usedNew.has(fact) &&
          fact.value === oldFact.value &&
          fact.signature === oldFact.signature,
      );
      if (match) compare(oldFact, match);
    }
    const oldRemainder = oldGroup.filter((fact) => !usedOld.has(fact));
    const newRemainder = newGroup.filter((fact) => !usedNew.has(fact));
    for (let i = 0; i < Math.min(oldRemainder.length, newRemainder.length); i++) {
      compare(oldRemainder[i]!, newRemainder[i]!);
    }
  }
  // Only unique, same-scope, same-node-kind, identical-shape declarations are renamed.
  // Ambiguous matches remain truthful additions/removals rather than guessed identity.
  const renameKey = (fact: SyntaxFact) =>
    `${fact.entity}\0${fact.nodeType}\0${fact.scope}\0${fact.shape}`;
  const oldRenames = matchingGroups(
    oldFacts.filter((f) => !usedOld.has(f) && f.entity === "symbol" && f.shape),
    renameKey,
  );
  const newRenames = matchingGroups(
    newFacts.filter((f) => !usedNew.has(f) && f.entity === "symbol" && f.shape),
    renameKey,
  );
  for (const [key, oldGroup] of oldRenames) {
    const newGroup = newRenames.get(key);
    if (oldGroup.length !== 1 || newGroup?.length !== 1) continue;
    const oldFact = oldGroup[0]!;
    const newFact = newGroup[0]!;
    if (oldFact.name === newFact.name) continue;
    usedOld.add(oldFact);
    usedNew.add(newFact);
    emit("symbol.renamed", oldFact, newFact);
  }
  for (const fact of oldFacts) if (!usedOld.has(fact)) emit(`${fact.entity}.removed`, fact, null);
  for (const fact of newFacts) if (!usedNew.has(fact)) emit(`${fact.entity}.added`, null, fact);
  result.changes.sort((a, b) => {
    const aa = (a.after ?? a.before)!;
    const bb = (b.after ?? b.before)!;
    return (
      aa.start.line - bb.start.line ||
      aa.start.column - bb.start.column ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id)
    );
  });
  // Preserve duplicate facts as distinct events even if their syntax and identity match.
  const occurrences = new Map<string, number>();
  for (const change of result.changes) {
    const count = occurrences.get(change.id) ?? 0;
    occurrences.set(change.id, count + 1);
    change.id = `${change.id}-${count}`;
  }
  return result;
}

export type { SemanticChange, SemanticFeedResponse, SemanticLanguage } from "./types.ts";
