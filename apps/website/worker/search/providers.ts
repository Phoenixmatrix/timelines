// One provider per search category. Each authorizes in SQL before it ranks or
// limits, so nothing the viewer can't read reaches a row, an order or a cursor.

import { sql } from "kysely";
import {
  SEARCH_LIMITS,
  type AccountResult,
  type ConversationResult,
  type IssueResult,
  type RepositoryResult,
  type SearchCategory,
  type SearchResult,
} from "../../shared/search.ts";
import type { Issue, TrackerOwner } from "../../shared/tracker.ts";
import type { Actor } from "../db.ts";
import { readableRepo, roleFor, selectRepos } from "../db.ts";
import { db } from "../schema.ts";
import { accessible } from "../tracker/api.ts";
import { trackerObject } from "../tracker/stub.ts";
import { packages } from "./packages.ts";
import { matchOf, matchRank, matches, type MatchColumns, type SearchQuery } from "./query.ts";

export interface SearchContext {
  env: Env;
  actor: Actor;
  /** The incoming request, for subsystems that authenticate it themselves (the registry). */
  request: Request;
  waitUntil: (promise: Promise<unknown>) => void;
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
  ) => Promise<{
    results: Extract<SearchResult, { category: C }>[];
    more: boolean;
    /** What part of the category wasn't searched, if any. */
    incomplete?: string;
  }>;
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

/** How many trackers an issue search reads at once. */
const TRACKER_CONCURRENCY = 6;

/** `work` over `items`, at most `limit` at a time, results in input order. */
async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = [];
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await work(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/**
 * Issues in every tracker the viewer belongs to, open and closed. Each tracker
 * ranks its own matches (TrackerStore.searchIssues); this merges them. A
 * tracker that fails, or one past SEARCH_LIMITS.trackers, makes the group
 * `incomplete` rather than silently absent.
 */
const issues: SearchProvider<"issues"> = {
  category: "issues",
  async search({ env, actor }, query, page) {
    const owners = await accessible(env.DB, actor);
    // Your own tracker first, then organizations by slug.
    owners.sort((a, b) => Number(b.id === actor.id) - Number(a.id === actor.id));
    const searched = owners.slice(0, SEARCH_LIMITS.trackers);
    // Each tracker's best `want` are enough to fill this page and know if more follow.
    const want = page.offset + page.limit + 1;
    const answers = await pooled(searched, TRACKER_CONCURRENCY, async (owner) => {
      try {
        const reply = await trackerObject(env, owner.id).searchIssues(query, want);
        if (reply.ok) return { owner, matches: reply.value };
        console.error(`search: tracker ${owner.slug} refused`, reply.error);
      } catch (error) {
        console.error(`search: tracker ${owner.slug} failed`, error);
      }
      return { owner, matches: null };
    });
    const failed = answers.filter((answer) => answer.matches === null).map((a) => a.owner.slug);
    if (searched.length && failed.length === searched.length)
      throw new Error("Every tracker search failed.");

    const merged = answers
      .flatMap(({ owner, matches }) => (matches ?? []).map((match) => ({ owner, ...match })))
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          a.issue.priority - b.issue.priority ||
          b.issue.updatedAt.localeCompare(a.issue.updatedAt) ||
          a.owner.slug.localeCompare(b.owner.slug) ||
          a.issue.id.localeCompare(b.issue.id),
      );
    const rows = merged.slice(page.offset, page.offset + page.limit);
    const notes = [
      failed.length ? `Couldn't search ${failed.join(", ")}.` : "",
      owners.length > searched.length
        ? `Searched ${searched.length} of your ${owners.length} trackers.`
        : "",
    ].filter(Boolean);
    return {
      more: merged.length > page.offset + page.limit,
      incomplete: notes.length ? notes.join(" ") : undefined,
      results: rows.map(({ owner, issue, rank }) => issueResult(owner, issue, rank)),
    };
  },
};

const STATUS_LABEL: Record<Issue["status"], string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  canceled: "Canceled",
};

function issueResult(owner: TrackerOwner, issue: Issue, rank: number): IssueResult {
  return {
    category: "issues",
    id: `issues:${owner.id}:${issue.id}`,
    title: issue.title,
    subtitle: `${issue.key} · ${STATUS_LABEL[issue.status]}`,
    breadcrumb: [owner.slug],
    match: matchOf(rank),
    target: {
      kind: "path",
      path: `/tracker/${encodeURIComponent(owner.slug)}/issues/${encodeURIComponent(issue.id)}`,
    },
    key: issue.key,
    tracker: { slug: owner.slug, displayName: owner.displayName },
    status: issue.status,
    priority: issue.priority,
    updatedAt: issue.updatedAt,
  };
}

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
export const PROVIDERS: readonly AnySearchProvider[] = [
  repositories,
  issues,
  packages,
  accounts,
  conversations,
];
