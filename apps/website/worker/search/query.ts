// Parsing and matching shared by every search provider: the validated query,
// continuation cursors, and the SQL that filters and ranks by SearchMatch.

import { sql, type RawBuilder } from "kysely";
import { SEARCH_LIMITS, type SearchCategory, type SearchMatch } from "../../shared/search.ts";

export interface SearchQuery {
  /** Trimmed, whitespace collapsed: what the response echoes. */
  text: string;
  /** Lowercased `text`, compared against lowercased columns. */
  lower: string;
  /** Lowercased words; a row matches only if it contains every one. */
  words: string[];
}

/** The query, or why it can't be run. Empty input never enumerates anything. */
export function parseQuery(raw: string | undefined): SearchQuery | string {
  const text = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "Give a query to search for.";
  if (text.length > SEARCH_LIMITS.queryLength)
    return `Keep the query under ${SEARCH_LIMITS.queryLength} characters.`;
  const lower = text.toLowerCase();
  const words = lower.split(" ");
  if (words.length > SEARCH_LIMITS.words)
    return `Search for at most ${SEARCH_LIMITS.words} words at once.`;
  return { text, lower, words };
}

/** Where a page starts. Cursors are opaque to clients and bound to one query and category. */
interface Cursor {
  v: 4;
  c: SearchCategory;
  q: string;
  o: number;
}

function base64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unbase64url(encoded: string): string {
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function encodeCursor(category: SearchCategory, query: SearchQuery, offset: number): string {
  return base64url(
    JSON.stringify({ v: 4, c: category, q: query.text, o: offset } satisfies Cursor),
  );
}

/** The offset a cursor resumes at, or null when it isn't one this query issued. */
export function decodeCursor(
  encoded: string,
  category: SearchCategory,
  query: SearchQuery,
): number | null {
  let cursor: Partial<Cursor>;
  try {
    cursor = JSON.parse(unbase64url(encoded));
  } catch {
    return null;
  }
  const { v, c, q, o } = cursor;
  if (v !== 4 || c !== category || q !== query.text) return null;
  if (!Number.isInteger(o) || o! <= 0 || o! >= SEARCH_LIMITS.maxOffset) return null;
  return o!;
}

/** A LIKE pattern matching `text` literally, with `\` as the escape character. */
function literal(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Lowercase, with the separators names use (-, _, ., /) read as spaces, after a leading space. */
function wordSpaced(column: RawBuilder<unknown>) {
  return sql`' ' || replace(replace(replace(replace(lower(${column}), '-', ' '), '_', ' '), '.', ' '), '/', ' ')`;
}

function anyOf(conditions: RawBuilder<unknown>[]) {
  return sql`(${sql.join(conditions, sql` OR `)})`;
}

/** The columns a provider matches, by how strongly a match on them counts. */
export interface MatchColumns {
  /** Canonical identifiers: equal to the query is an `exact` match. */
  identifiers: RawBuilder<unknown>[];
  /** Names and titles: starting with the query is `prefix`, a word in them starting with it `word`. */
  names: RawBuilder<unknown>[];
  /** Everything searched; a row is a result only if every query word appears in one of these. */
  searched: RawBuilder<unknown>[];
}

/** True for rows containing every query word in a searched column. */
export function matches(columns: MatchColumns, query: SearchQuery) {
  const haystack = sql.join(
    columns.searched.map((column) => sql`lower(coalesce(${column}, ''))`),
    sql` || ' ' || `,
  );
  return sql<boolean>`(${sql.join(
    query.words.map((word) => sql`(${haystack}) LIKE ${`%${literal(word)}%`} ESCAPE '\\'`),
    sql` AND `,
  )})`;
}

const MATCH_ORDER: readonly SearchMatch[] = ["exact", "prefix", "word", "contains"];

/** The SearchMatch a `matchRank` column holds. */
export function matchOf(rank: number): SearchMatch {
  return MATCH_ORDER[rank] ?? "contains";
}

/** The SearchMatch tier as its index in MATCH_ORDER, for ORDER BY. */
export function matchRank(columns: MatchColumns, query: SearchQuery) {
  const pattern = literal(query.lower);
  const exact = anyOf(columns.identifiers.map((column) => sql`lower(${column}) = ${query.lower}`));
  const prefix = anyOf(
    columns.names.map((column) => sql`lower(${column}) LIKE ${`${pattern}%`} ESCAPE '\\'`),
  );
  const word = anyOf(
    columns.names.map((column) => sql`${wordSpaced(column)} LIKE ${`% ${pattern}%`} ESCAPE '\\'`),
  );
  return sql<number>`CASE WHEN ${exact} THEN 0 WHEN ${prefix} THEN 1 WHEN ${word} THEN 2 ELSE 3 END`;
}
