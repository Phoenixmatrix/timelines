// One provider per search category. Each authorizes in SQL before it ranks or
// limits, so nothing the viewer can't read reaches a row, an order or a cursor.

import { sql } from "kysely";
import type {
  AccountResult,
  ConversationResult,
  RepositoryResult,
  SearchCategory,
  SearchResult,
} from "../../shared/search.ts";
import type { Actor } from "../db.ts";
import { readableRepo, roleFor, selectRepos } from "../db.ts";
import { db } from "../schema.ts";
import { matchOf, matchRank, matches, type MatchColumns, type SearchQuery } from "./query.ts";

export interface SearchContext {
  env: Env;
  actor: Actor;
}

/** The slice of a category's ranked matches to return. */
export interface SearchPage {
  offset: number;
  limit: number;
}

/**
 * A category's lookup. `search` returns up to `page.limit` results from
 * `page.offset` in ranked order, and whether more follow. Sibling categories
 * (issues, packages) implement this and register in PROVIDERS.
 */
export interface SearchProvider<C extends SearchCategory = SearchCategory> {
  category: C;
  search: (
    context: SearchContext,
    query: SearchQuery,
    page: SearchPage,
  ) => Promise<{ results: Extract<SearchResult, { category: C }>[]; more: boolean }>;
}

/** Any one category's provider. */
export type AnySearchProvider = { [C in SearchCategory]: SearchProvider<C> }[SearchCategory];

/** Rows from a query that fetched one past the page, as a page and whether more follow. */
function paged<T>(rows: T[], page: SearchPage) {
  return { rows: rows.slice(0, page.limit), more: rows.length > page.limit };
}

const repositories: SearchProvider<"repositories"> = {
  category: "repositories",
  async search({ env, actor }, query, page) {
    const columns: MatchColumns = {
      identifiers: [sql`o.slug || '/' || r.name`, sql.ref("r.name")],
      names: [sql.ref("r.name"), sql`o.slug || '/' || r.name`],
      searched: [sql`o.slug || '/' || r.name`, sql.ref("r.description")],
    };
    const found = await selectRepos(env.DB, actor.id)
      .select(matchRank(columns, query).as("match_rank"))
      .where(readableRepo(actor))
      .where(matches(columns, query))
      .orderBy("match_rank")
      .orderBy(sql`coalesce(r.pushed_at, r.created_at)`, "desc")
      .orderBy("r.id")
      .limit(page.limit + 1)
      .offset(page.offset)
      .execute();
    const { rows, more } = paged(found, page);
    return {
      more,
      results: rows
        // permissions.ts stays the authority; readableRepo already agrees with it.
        .filter((row) => roleFor(row, actor) !== "none")
        .map((row): RepositoryResult => ({
          category: "repositories",
          id: `repositories:${row.id}`,
          title: `${row.owner_slug}/${row.name}`,
          subtitle: row.description,
          breadcrumb: [row.owner_slug],
          match: matchOf(row.match_rank),
          target: {
            kind: "path",
            path: `/${encodeURIComponent(row.owner_slug)}/${encodeURIComponent(row.name)}`,
          },
          owner: row.owner_slug,
          name: row.name,
          visibility: row.visibility,
        })),
    };
  },
};

/** People and organizations. Every profile is public (GET /api/accounts/:slug), so all are searchable. */
const accounts: SearchProvider<"accounts"> = {
  category: "accounts",
  async search({ env }, query, page) {
    const columns: MatchColumns = {
      identifiers: [sql.ref("a.slug"), sql.ref("a.display_name")],
      names: [sql.ref("a.slug"), sql.ref("a.display_name")],
      searched: [sql.ref("a.slug"), sql.ref("a.display_name")],
    };
    const found = await db(env.DB)
      .selectFrom("accounts as a")
      .select(["a.id", "a.kind", "a.slug", "a.display_name"])
      .select(matchRank(columns, query).as("match_rank"))
      .where(matches(columns, query))
      .orderBy("match_rank")
      .orderBy("a.slug")
      .orderBy("a.id")
      .limit(page.limit + 1)
      .offset(page.offset)
      .execute();
    const { rows, more } = paged(found, page);
    return {
      more,
      results: rows.map((row): AccountResult => ({
        category: "accounts",
        id: `accounts:${row.id}`,
        title: row.display_name,
        subtitle: row.slug,
        breadcrumb: [],
        match: matchOf(row.match_rank),
        target: { kind: "path", path: `/${encodeURIComponent(row.slug)}` },
        kind: row.kind,
        slug: row.slug,
      })),
    };
  },
};

/**
 * The viewer's own assistant conversations, by title only (not transcripts),
 * queried at storage so every title is searched, not just the recent directory.
 */
const conversations: SearchProvider<"conversations"> = {
  category: "conversations",
  async search({ env, actor }, query, page) {
    const columns: MatchColumns = {
      identifiers: [sql.ref("c.title")],
      names: [sql.ref("c.title")],
      searched: [sql.ref("c.title")],
    };
    const found = await db(env.DB)
      .selectFrom("assistant_chats as c")
      .select(["c.id", "c.title", "c.updated_at"])
      .select(matchRank(columns, query).as("match_rank"))
      .where("c.user_id", "=", actor.id)
      .where(matches(columns, query))
      .orderBy("match_rank")
      .orderBy("c.updated_at", "desc")
      .orderBy("c.id")
      .limit(page.limit + 1)
      .offset(page.offset)
      .execute();
    const { rows, more } = paged(found, page);
    return {
      more,
      results: rows.map((row): ConversationResult => ({
        category: "conversations",
        id: `conversations:${row.id}`,
        title: row.title,
        subtitle: "",
        breadcrumb: ["Assistant"],
        match: matchOf(row.match_rank),
        target: { kind: "chat", chatId: row.id },
        updatedAt: row.updated_at,
      })),
    };
  },
};

/** Every category, in the order groups are returned by default. */
export const PROVIDERS: readonly AnySearchProvider[] = [repositories, accounts, conversations];
