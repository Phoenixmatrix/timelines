// Packages for global search, from the registry's own catalog and access
// rules: the registry decides which feeds the viewer may read (visibility,
// Space package roles), and only those feeds' packages are
// matched, ranked, counted or paged.

import { FORMATS, isFormatId } from "@gitmatrix/formats/info";
import { sql } from "kysely";
import { packagePath } from "../../shared/packages.ts";
import type { PackageResult } from "../../shared/search.ts";
import type { SpaceSummary } from "../../shared/spaces.ts";
import { Services } from "../../registry/core/context.ts";
import { listRepos } from "../../registry/core/repos.ts";
import { findSpaceById } from "../spaces/access.ts";
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

    // Resolve canonical Space identities separately from the registry's feed ACL.
    const spaces = new Map<string, SpaceSummary>();
    for (const spaceId of new Set(feeds.map((feed) => feed.spaceId))) {
      const space = await findSpaceById(env.DB, spaceId);
      if (space) spaces.set(spaceId, space);
    }
    const slugs = JSON.stringify(
      Object.fromEntries([...spaces].map(([id, space]) => [id, space.slug])),
    );
    const feedIds = JSON.stringify(
      feeds.filter((feed) => spaces.has(feed.spaceId)).map((feed) => feed.id),
    );

    const spaceSlug = sql<string>`json_extract(${slugs}, '$."' || r.space_id || '"')`;
    const qualified = sql<string>`${spaceSlug} || '/' || p.name`;
    const columns: MatchColumns = {
      identifiers: [qualified, sql.ref("p.name"), sql.ref("p.normalized_name")],
      names: [sql.ref("p.name"), qualified],
      searched: [qualified, sql.ref("r.format")],
    };
    const found = await services.db
      .selectFrom("packages as p")
      .innerJoin("repositories as r", "r.id", "p.repo_id")
      .select(["p.id", "p.name", "r.format", "r.space_id", spaceSlug.as("space_slug")])
      .select(matchRank(columns, query).as("match_rank"))
      .where(sql<boolean>`p.repo_id IN (SELECT value FROM json_each(${feedIds}))`)
      .where(matches(columns, query))
      .orderBy("match_rank")
      .orderBy("p.name")
      .orderBy("r.format")
      .orderBy("space_slug")
      .orderBy("p.id")
      .limit(page.limit + 1)
      .offset(page.offset)
      .execute();
    return {
      more: found.length > page.limit,
      results: found
        .slice(0, page.limit)
        .filter((row) => isFormatId(row.format))
        .map((row): PackageResult => {
          const format = row.format as keyof typeof FORMATS;
          return {
            category: "packages",
            id: `packages:${row.id}`,
            title: row.name,
            subtitle: `${FORMATS[format].label} · ${row.space_slug}`,
            breadcrumb: [row.space_slug, FORMATS[format].label],
            match: matchOf(row.match_rank),
            target: { kind: "path", path: packagePath(row.space_slug, format, row.name) },
            space: spaces.get(row.space_id)!,
            format,
            name: row.name,
          };
        }),
    };
  },
};
