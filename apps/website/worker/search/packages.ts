// Packages for global search, from the registry's own catalog and access
// rules: the registry decides which feeds the viewer may read (visibility,
// owner roles, source-derived grants), and only those feeds' packages are
// matched, ranked, counted or paged.

import { FORMATS, isFormatId } from "@gitmatrix/formats/info";
import { sql } from "kysely";
import { packagePath } from "../../shared/packages.ts";
import type { PackageResult } from "../../shared/search.ts";
import { Services } from "../../registry/core/context.ts";
import { listRepos } from "../../registry/core/repos.ts";
import { db } from "../schema.ts";
import type { SearchProvider } from "./providers.ts";
import { matchOf, matchRank, matches, type MatchColumns } from "./query.ts";

export const packages: SearchProvider<"packages"> = {
  category: "packages",
  async search({ env, request, waitUntil }, query, page) {
    // The registry authenticates the request itself, as /api/packages does.
    const services = new Services(env, request, waitUntil);
    const access = await services.access();
    const feeds = [];
    for (const feed of await listRepos(services.db))
      if (await access.can(feed, "read")) feeds.push(feed);
    if (!feeds.length) return { results: [], more: false };

    // Owner slugs live in Gitmatrix's database; they reach the registry query
    // as one JSON object keyed by owner id.
    const ownerIds = [...new Set(feeds.map((feed) => feed.ownerId))];
    const owners = await db(env.DB)
      .selectFrom("accounts")
      .select(["id", "slug"])
      .where("id", "in", ownerIds)
      .execute();
    const slugs = JSON.stringify(Object.fromEntries(owners.map((o) => [o.id, o.slug])));
    const feedIds = JSON.stringify(feeds.map((feed) => feed.id));

    const owner = sql<string>`coalesce(json_extract(${slugs}, '$."' || r.owner_id || '"'), '')`;
    const qualified = sql<string>`${owner} || '/' || p.name`;
    const columns: MatchColumns = {
      identifiers: [qualified, sql.ref("p.name"), sql.ref("p.normalized_name")],
      names: [sql.ref("p.name"), qualified],
      searched: [qualified, sql.ref("r.format")],
    };
    const found = await services.db
      .selectFrom("packages as p")
      .innerJoin("repositories as r", "r.id", "p.repo_id")
      .select(["p.id", "p.name", "r.format", owner.as("owner")])
      .select(matchRank(columns, query).as("match_rank"))
      .where(sql<boolean>`p.repo_id IN (SELECT value FROM json_each(${feedIds}))`)
      .where(matches(columns, query))
      .orderBy("match_rank")
      .orderBy("p.name")
      .orderBy("r.format")
      .orderBy("owner")
      .orderBy("p.id")
      .limit(page.limit + 1)
      .offset(page.offset)
      .execute();
    return {
      more: found.length > page.limit,
      results: found
        .slice(0, page.limit)
        .filter((row) => row.owner && isFormatId(row.format))
        .map((row): PackageResult => {
          const format = row.format as keyof typeof FORMATS;
          return {
            category: "packages",
            id: `packages:${row.id}`,
            title: row.name,
            subtitle: `${FORMATS[format].label} · ${row.owner}`,
            breadcrumb: [row.owner, FORMATS[format].label],
            match: matchOf(row.match_rank),
            target: { kind: "path", path: packagePath(row.owner, format, row.name) },
            owner: row.owner,
            format,
            name: row.name,
          };
        }),
    };
  },
};
