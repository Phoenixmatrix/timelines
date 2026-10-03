// Global search (GET /api/search): the contract between the Worker's search
// providers and the palette. Lookup is plain, permission-aware matching over
// names and titles: no inference, embeddings or AI Search.

/**
 * What can be found. Each category has one server-side provider
 * (worker/search/); a new kind of result adds a category here and a provider
 * there.
 */
export type SearchCategory = "repositories" | "accounts" | "conversations";

export const SEARCH_CATEGORIES: readonly SearchCategory[] = [
  "repositories",
  "accounts",
  "conversations",
];

/** The bounds every query obeys; requests outside them are rejected with 400. */
export const SEARCH_LIMITS = {
  /** Longest query, in characters, after trimming. */
  queryLength: 100,
  /** Most whitespace-separated words; every word must match. */
  words: 6,
  /** Results per category when `limit` isn't given. */
  defaultLimit: 5,
  /** Most results per category in one response. */
  maxLimit: 20,
  /**
   * How deep continuation goes in one category. Past it a group reports
   * `truncated` instead of a cursor: narrow the query.
   */
  maxOffset: 100,
  /** A category that takes longer than this reports `unavailable`. */
  timeoutMs: 5_000,
} as const;

/**
 * How a result matched, strongest first. Results within a category are
 * ordered by this, then by the category's own tie-breaks (recency, name, ID).
 * - `exact`: an identifier equals the query (`owner/name`, a slug, a title);
 * - `prefix`: a name or title starts with it;
 * - `word`: a word inside a name or title starts with it;
 * - `contains`: every word appears somewhere, e.g. in a description.
 */
export type SearchMatch = "exact" | "prefix" | "word" | "contains";

/** Where a result leads: an in-app path, or a conversation to resume. */
export type SearchTarget = { kind: "path"; path: string } | { kind: "chat"; chatId: string };

interface ResultBase {
  /** Stable across queries: `<category>:<canonical id>`. */
  id: string;
  title: string;
  /** A secondary line: a description, a display name. */
  subtitle: string;
  /** Where it lives, outermost first, e.g. ["orbit"] for orbit/engine. */
  breadcrumb: string[];
  match: SearchMatch;
  target: SearchTarget;
}

export interface RepositoryResult extends ResultBase {
  category: "repositories";
  owner: string;
  name: string;
  visibility: "public" | "private";
}

export interface AccountResult extends ResultBase {
  category: "accounts";
  kind: "user" | "org";
  slug: string;
}

export interface ConversationResult extends ResultBase {
  category: "conversations";
  target: { kind: "chat"; chatId: string };
  updatedAt: string;
}

export type SearchResult = RepositoryResult | AccountResult | ConversationResult;

/**
 * One category's answer. A category that failed or timed out is `unavailable`,
 * which is not the same as no matches, and doesn't affect the others.
 */
export type SearchGroup =
  | {
      category: SearchCategory;
      status: "ok";
      results: SearchResult[];
      /** Pass back as `cursor` (with the same `q` and `category`) for the next page. */
      cursor: string | null;
      /** More matches exist past the deepest page: narrow the query to reach them. */
      truncated: boolean;
    }
  | { category: SearchCategory; status: "unavailable"; error: string };

/** GET /api/search?q=&categories=&limit=, or ?q=&category=&cursor= for the next page. */
export interface SearchResponse {
  /** The query as it was matched: trimmed, with whitespace collapsed. */
  query: string;
  /** In the order requested (by default, SEARCH_CATEGORIES order). */
  groups: SearchGroup[];
}
