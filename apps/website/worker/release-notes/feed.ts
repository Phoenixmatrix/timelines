// A Space's code-update feed, filtered by facets.

import {
  landedTimelineSlug,
  parseReleaseQuery,
  parseReleaseWhen,
  DAILY_RELEASE_PREFIX,
  releaseLabel,
  type ParsedReleaseQuery,
  type ReleaseFeed,
  type ReleaseFeedEntry,
  type ReleaseFeedFacet,
} from "../../shared/release-notes.ts";
import { visibleRepos, type Actor } from "../db.ts";
import { findSpaceBySlug } from "../spaces/access.ts";
import { accessFor } from "../tracker/access.ts";
import { db } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";
import { toEntry, viewerTrackers, type EntryRow, type ViewerTrackers } from "./read.ts";
import { ensureReleaseNotes } from "./queue.ts";

export interface FeedRow extends EntryRow {
  repo_space: string;
  repo_name: string;
}

export interface FeedContext {
  trackers: ViewerTrackers;
  /** Repositories the viewer can read. */
  visibleRepoIds: Set<string>;
  /** Project id → slug, for the Space's tracker. */
  projects: Map<string, string>;
  /** Team key → name, for the Space's tracker: a facet reads "Core", not "CORE" (CORE-395). */
  teams: Map<string, string>;
  query: ParsedReleaseQuery;
  /** Independent landed-timeline scope, ANDed with the explicit query. */
  timeline?: string;
  now: number;
  limit: number;
}

const FEED_LIMIT = 200;
const SCAN_LIMIT = 5000;

/** Filter, merge and count rows already scoped to one tracker Space. */
export function buildFeed(rows: FeedRow[], context: FeedContext): Omit<ReleaseFeed, "space"> {
  const scope = context.timeline && context.timeline !== "main" ? context.timeline : null;
  const query: ParsedReleaseQuery = {
    ...context.query,
    filters: oldTagSpelling(rows, context.query.filters),
    unknown: [...context.query.unknown],
  };
  const bounds: { key: "since" | "until"; at: string; negated: boolean }[] = [];
  const facetFilters = query.filters.filter((filter) => {
    if (filter.key !== "since" && filter.key !== "until") return true;
    const at = parseReleaseWhen(filter.value, context.now);
    if (at) bounds.push({ key: filter.key, at, negated: filter.negated });
    else query.unknown.push(`${filter.negated ? "-" : ""}${filter.key}:${filter.value}`);
    // Dates are applied as bounds below, never as facet matches.
    return false;
  });

  const includeTags = query.filters.some(
    (f) => f.key === "kind" || (f.key === "release" && !f.negated),
  );
  const shipped: ReleaseFeedEntry[] = [];
  for (const row of rows) {
    if (!context.visibleRepoIds.has(row.repo_id)) continue;
    const entry = toEntry(row, context.trackers);
    if (!entry) continue;
    if (scope && landedTimelineSlug(entry.timeline) !== scope) continue;
    if (!includeTags && entry.releaseKind !== "daily") continue;
    const repo = `${row.repo_space}/${row.repo_name}`.toLowerCase();
    const slugs = entry.projectIds.flatMap((id) => context.projects.get(id) ?? []);
    const text =
      `${entry.title}\n${entry.summary}\n${entry.issue?.key ?? ""}\n${entry.timeline?.branch ?? ""}`.toLowerCase();
    const matches = (key: string, value: string): boolean => {
      switch (key) {
        case "team":
          return entry.issue?.team.key.toLowerCase() === value;
        case "repo":
          return repo === value || row.repo_name.toLowerCase() === value;
        case "project":
          return slugs.some((slug) => slug.toLowerCase() === value);
        case "type":
          return entry.category === value;
        case "tag":
          return entry.labels.some((label) => label.toLowerCase() === value);
        case "kind":
          return entry.releaseKind === value;
        case "release":
          return entry.release.toLowerCase() === value;
        case "timeline":
          return landedTimelineSlug(entry.timeline) === value;
        default:
          return false;
      }
    };
    if (facetFilters.some((f) => matches(f.key, f.value) === f.negated)) continue;
    if (
      bounds.some(
        (b) =>
          (b.key === "since" ? entry.lastCommitAt >= b.at : entry.lastCommitAt < b.at) ===
          b.negated,
      )
    )
      continue;
    if (query.words.some((w) => text.includes(w.text) === w.negated)) continue;

    // Explicit named snapshots remain distinct; the default feed contains only days.
    shipped.push({
      ...entry,
      repo: { space: row.repo_space, name: row.repo_name },
      repos: [{ space: row.repo_space, name: row.repo_name, releases: [entry.release] }],
    });
  }

  const all = shipped.sort(
    (a, b) => b.lastCommitAt.localeCompare(a.lastCommitAt) || a.title.localeCompare(b.title),
  );
  const facet = (pick: (entry: ReleaseFeedEntry) => [string, string][]): ReleaseFeedFacet[] => {
    const counts = new Map<string, ReleaseFeedFacet>();
    for (const entry of all)
      for (const [value, label] of new Map(pick(entry))) {
        const current = counts.get(value) ?? { value, label, count: 0 };
        current.count++;
        counts.set(value, current);
      }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const tags = facet((e) => e.labels.map((l) => [l.toLowerCase(), l] as [string, string]));
  return {
    query,
    entries: all.slice(0, context.limit),
    truncated: all.length > context.limit,
    facets: {
      teams: facet((e) =>
        e.issue
          ? [
              [
                e.issue.team.key.toLowerCase(),
                context.teams.get(e.issue.team.key) ?? e.issue.team.key,
              ],
            ]
          : [],
      ),
      repos: facet((e) =>
        e.repos.map((r) => [`${r.space}/${r.name}`.toLowerCase(), `${r.space}/${r.name}`]),
      ),
      projects: facet((e) =>
        e.projectIds.flatMap((id) => {
          const slug = context.projects.get(id);
          return slug ? [[slug.toLowerCase(), slug] as [string, string]] : [];
        }),
      ),
      categories: facet((e) => [[e.category, e.category]]),
      tags,
      labels: tags,
      timelines: facet((e) => {
        const slug = landedTimelineSlug(e.timeline);
        return slug ? [[slug, e.timeline!.branch!]] : [];
      }),
      releases: facet((e) =>
        e.repos.flatMap((r) =>
          r.releases.map((name) => [name.toLowerCase(), releaseLabel(name)] as [string, string]),
        ),
      ),
    },
  };
}

/**
 * Before CORE-271 `tag:` meant `release:` here; it now means an issue tag. A
 * `tag:` naming a release these rows have, and no issue tag, keeps its old
 * meaning, so saved queries such as `tag:v1.2` still select that release.
 */
function oldTagSpelling(rows: FeedRow[], filters: ParsedReleaseQuery["filters"]) {
  if (!filters.some((f) => f.key === "tag")) return filters;
  const releases = new Set(rows.map((row) => row.release.toLowerCase()));
  const tags = new Set(
    rows.flatMap((row) => (JSON.parse(row.labels) as string[]).map((l) => l.toLowerCase())),
  );
  return filters.map((filter) =>
    filter.key === "tag" && releases.has(filter.value) && !tags.has(filter.value)
      ? { ...filter, key: "release" as const }
      : filter,
  );
}

export class FeedError extends Error {
  readonly status: 400 | 401 | 403 | 404;
  constructor(status: 400 | 401 | 403 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

/** The feed for a tracker Space, as an actor who can read that tracker sees it. */
export async function releaseFeed(
  env: Env,
  actor: Actor | null,
  spaceSlug: string,
  q: string,
  timeline?: string,
): Promise<ReleaseFeed> {
  if (!actor) throw new FeedError(401, "Sign in to read release notes.");
  const space = await findSpaceBySlug(env.DB, spaceSlug);
  if (!space) throw new FeedError(404, "Tracker Space not found.");
  const trackers = await viewerTrackers(env.DB, actor);
  if (!trackers.has(space.id))
    throw new FeedError(403, "Release notes for a tracker require an explicit Space grant.");
  const access = await accessFor(
    env,
    space,
    actor.id,
    actor.agent?.id ?? null,
    false,
    actor.credential,
  );
  let query: ParsedReleaseQuery;
  try {
    query = parseReleaseQuery(q);
  } catch (error) {
    throw new FeedError(400, error instanceof Error ? error.message : "Invalid release query.");
  }
  const scope = timeline && timeline !== "main" ? timeline : null;
  const d = db(env.DB);
  const repos = await visibleRepos(env.DB, actor);
  const visibleRepoIds = new Set(repos.map((repo) => repo.id));
  const candidates = await d
    .selectFrom("repos")
    .select("id")
    .where("space_id", "=", space.id)
    .execute();
  for (const repo of candidates)
    if (visibleRepoIds.has(repo.id)) await ensureReleaseNotes(env, repo.id, actor);
  // Narrow in SQL by the cheap facets; the rest are applied with access rules.
  let select = d
    .selectFrom("release_note_entries as e")
    .innerJoin("repos as r", "r.id", "e.repo_id")
    .innerJoin("spaces as a", "a.id", "r.space_id")
    .innerJoin("release_note_state as s", "s.repo_id", "e.repo_id")
    .where("s.format_version", "=", 1)
    .where("r.deleted_at", "is", null)
    .innerJoin("release_notes as n", (join) =>
      join.onRef("n.repo_id", "=", "e.repo_id").onRef("n.release", "=", "e.release"),
    )
    .where("n.format_version", "=", 1)
    .selectAll("e")
    .select(["a.slug as repo_space", "r.name as repo_name"])
    .where("r.space_id", "=", space.id);
  // Scope before the scan cap so unrelated landings cannot crowd out this timeline.
  if (scope)
    select = select
      .where("e.timeline_branch", "=", `timeline/${scope}`)
      .where("e.landing_oid", "is not", null)
      .where("e.landing_oid", "!=", "");
  // A positive `tag:` may be the old spelling of a tagged release (oldTagSpelling).
  if (
    !query.filters.some(
      (f) => f.key === "kind" || ((f.key === "release" || f.key === "tag") && !f.negated),
    )
  )
    select = select.where("e.release", "like", `${DAILY_RELEASE_PREFIX}%`);
  for (const filter of query.filters) {
    if (filter.key === "kind" && (filter.value === "daily" || filter.value === "tag")) {
      const daily = (filter.value === "daily") !== filter.negated;
      select = select.where("e.release", daily ? "like" : "not like", `${DAILY_RELEASE_PREFIX}%`);
    }
    if (filter.negated) continue;
    if (filter.key === "type")
      select = select.where("e.category", "=", filter.value as EntryRow["category"]);
    if (filter.key === "team") select = select.where("e.team_key", "=", filter.value.toUpperCase());
  }
  const [rows, projects, teams] = await Promise.all([
    select.orderBy("e.shipped_at", "desc").limit(SCAN_LIMIT).execute(),
    trackerObject(env, space.id).projectSlugs(access),
    trackerObject(env, space.id).teamNames(access),
  ]);
  const feed = buildFeed(rows, {
    trackers,
    visibleRepoIds,
    projects: new Map(projects.ok ? projects.value.map((p) => [p.id, p.slug]) : []),
    teams: new Map(teams.ok ? teams.value.map((t) => [t.key, t.name]) : []),
    query,
    timeline,
    now: Date.now(),
    limit: FEED_LIMIT,
  });
  return {
    space,
    ...feed,
    truncated: feed.truncated || rows.length === SCAN_LIMIT,
  };
}
