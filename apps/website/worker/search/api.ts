// GET /api/search: the palette's lookup across categories (shared/search.ts).
// Each category runs on its own; one failing or timing out is reported as
// unavailable without erasing the others.

import { Hono } from "hono";
import {
  SEARCH_LIMITS,
  type SearchCategory,
  type SearchGroup,
  type SearchResponse,
  type SearchResult,
} from "../../shared/search.ts";
import type { AppEnv } from "../auth.ts";
import { fail, requireActor } from "../api/http.ts";
import { PROVIDERS, type AnySearchProvider, type SearchContext } from "./providers.ts";
import { decodeCursor, encodeCursor, parseQuery, type SearchQuery } from "./query.ts";

const LABELS: Record<SearchCategory, string> = {
  repositories: "repositories",
  issues: "issues",
  accounts: "people and organizations",
  conversations: "conversations",
};

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms.`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function searchOne(
  provider: AnySearchProvider,
  context: SearchContext,
  query: SearchQuery,
  offset: number,
  limit: number,
): Promise<SearchGroup> {
  const category = provider.category;
  // Never page past maxOffset: the last window ends there.
  const page = { offset, limit: Math.min(limit, SEARCH_LIMITS.maxOffset - offset) };
  try {
    const { results, more, incomplete } = await withTimeout<{
      results: SearchResult[];
      more: boolean;
      incomplete?: string;
    }>(provider.search(context, query, page), SEARCH_LIMITS.timeoutMs);
    const next = offset + page.limit;
    const pageable = more && next < SEARCH_LIMITS.maxOffset;
    return {
      category,
      status: "ok",
      results,
      cursor: pageable ? encodeCursor(category, query, next) : null,
      truncated: more && !pageable,
      incomplete: incomplete ?? null,
    };
  } catch (error) {
    console.error(`search: ${category} failed`, error);
    return {
      category,
      status: "unavailable",
      error: `Couldn't search ${LABELS[category]} right now.`,
    };
  }
}

export function searchApi(providers: readonly AnySearchProvider[] = PROVIDERS) {
  const byCategory = new Map(providers.map((provider) => [provider.category, provider]));
  const api = new Hono<AppEnv>();

  api.get("/", async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const query = parseQuery(c.req.query("q"));
    if (typeof query === "string") return fail(c, 400, query);

    const requested = c.req.query("categories");
    const categories = requested
      ? [...new Set(requested.split(",").map((name) => name.trim()))]
      : [...byCategory.keys()];
    const unknown = categories.filter((name) => !byCategory.has(name as SearchCategory));
    if (unknown.length || !categories.length)
      return fail(
        c,
        400,
        `categories is a comma-separated list of: ${[...byCategory.keys()].join(", ")}.`,
      );

    const limitParam = c.req.query("limit");
    const limit = limitParam === undefined ? SEARCH_LIMITS.defaultLimit : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.maxLimit)
      return fail(c, 400, `limit is a whole number from 1 to ${SEARCH_LIMITS.maxLimit}.`);

    let offset = 0;
    const cursor = c.req.query("cursor");
    if (cursor !== undefined) {
      if (categories.length !== 1)
        return fail(c, 400, "A cursor continues one category: pass it with that category alone.");
      const resumed = decodeCursor(cursor, categories[0] as SearchCategory, query);
      if (resumed === null)
        return fail(c, 400, "That cursor doesn't belong to this query and category.");
      offset = resumed;
    }

    const context: SearchContext = { env: c.env, actor };
    const groups = await Promise.all(
      categories.map((name) =>
        searchOne(byCategory.get(name as SearchCategory)!, context, query, offset, limit),
      ),
    );
    const body: SearchResponse = { query: query.text, groups };
    // Results are the viewer's alone: never stored by a shared cache.
    c.header("cache-control", "private, no-store");
    return c.json(body);
  });

  return api;
}

export const search = searchApi();
