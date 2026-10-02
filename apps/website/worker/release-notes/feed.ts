// A tracker account's release feed (CORE-39): everything its teams shipped,
// and everything shipped in its repositories, across repositories and
// releases, filtered by facets. A team's notes are the feed with `team:KEY`.

import {
  parseReleaseQuery,
  parseReleaseWhen,
  UNRELEASED,
  type ParsedReleaseQuery,
  type ReleaseFeed,
  type ReleaseFeedEntry,
  type ReleaseFeedFacet,
} from "../../shared/release-notes.ts";
import { findAccountBySlug, visibleRepos, type Actor } from "../db.ts";
import { db } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";
import { toEntry, viewerTrackers, type EntryRow, type ViewerTrackers } from "./read.ts";

export interface FeedRow extends EntryRow {
  repo_owner: string;
  repo_name: string;
}

export interface FeedContext {
  trackers: ViewerTrackers;
  /** Repositories the viewer can read. */
  visibleRepoIds: Set<string>;
  /** Workspace id → slug, for the account's tracker. */
  workspaces: Map<string, string>;
  query: ParsedReleaseQuery;
  now: number;
  limit: number;
}

const FEED_LIMIT = 200;
const SCAN_LIMIT = 5000;

/** Filter, merge and count rows already scoped to one tracker account. */
export function buildFeed(rows: FeedRow[], context: FeedContext): Omit<ReleaseFeed, "owner"> {
  const query: ParsedReleaseQuery = { ...context.query, unknown: [...context.query.unknown] };
  const bounds: { key: "since" | "until"; at: string; negated: boolean }[] = [];
  const facetFilters = query.filters.filter((filter) => {
    if (filter.key !== "since" && filter.key !== "until") return true;
    const at = parseReleaseWhen(filter.value, context.now);
    if (at) bounds.push({ key: filter.key, at, negated: filter.negated });
    else query.unknown.push(`${filter.negated ? "-" : ""}${filter.key}:${filter.value}`);
    // Dates are applied as bounds below, never as facet matches.
    return false;
  });

  const shipped: ReleaseFeedEntry[] = [];
  for (const row of rows) {
    if (!context.visibleRepoIds.has(row.repo_id)) continue;
    const entry = toEntry(row, context.trackers);
    if (!entry) continue;
    const repo = `${row.repo_owner}/${row.repo_name}`.toLowerCase();
    const slugs = entry.workspaceIds.flatMap((id) => context.workspaces.get(id) ?? []);
    const text = `${entry.title}\n${entry.summary}\n${entry.issue?.key ?? ""}`.toLowerCase();
    const matches = (key: string, value: string): boolean => {
      switch (key) {
        case "team":
          return entry.issue?.team.key.toLowerCase() === value;
        case "repo":
          return repo === value || row.repo_name.toLowerCase() === value;
        case "ws":
          return slugs.some((slug) => slug.toLowerCase() === value);
        case "type":
          return entry.category === value;
        case "label":
          return entry.labels.some((label) => label.toLowerCase() === value);
        case "release":
          return entry.release.toLowerCase() === value;
        default:
          return false;
      }
    };
    if (facetFilters.some((f) => matches(f.key, f.value) === f.negated)) continue;
    if (
      bounds.some(
        (b) => (b.key === "since" ? entry.shippedAt >= b.at : entry.shippedAt < b.at) === b.negated,
      )
    )
      continue;
    if (query.words.some((w) => text.includes(w.text) === w.negated)) continue;

    // Entries in different releases come from different commits: each is its own shipment.
    shipped.push({
      ...entry,
      repos: [{ owner: row.repo_owner, name: row.repo_name, releases: [entry.release] }],
    });
  }

  const all = shipped.sort(
    (a, b) => b.shippedAt.localeCompare(a.shippedAt) || a.title.localeCompare(b.title),
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
  return {
    query,
    entries: all.slice(0, context.limit),
    truncated: all.length > context.limit,
    facets: {
      teams: facet((e) => (e.issue ? [[e.issue.team.key.toLowerCase(), e.issue.team.key]] : [])),
      repos: facet((e) =>
        e.repos.map((r) => [`${r.owner}/${r.name}`.toLowerCase(), `${r.owner}/${r.name}`]),
      ),
      workspaces: facet((e) =>
        e.workspaceIds.flatMap((id) => {
          const slug = context.workspaces.get(id);
          return slug ? [[slug.toLowerCase(), slug] as [string, string]] : [];
        }),
      ),
      categories: facet((e) => [[e.category, e.category]]),
      labels: facet((e) => e.labels.map((l) => [l.toLowerCase(), l] as [string, string])),
      releases: facet((e) =>
        e.repos.flatMap((r) =>
          r.releases.map(
            (name) =>
              [name.toLowerCase(), name === UNRELEASED ? "Unreleased" : name] as [string, string],
          ),
        ),
      ),
    },
  };
}

export class FeedError extends Error {
  readonly status: 401 | 403 | 404;
  constructor(status: 401 | 403 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

/** The feed for a tracker account, as an actor who can read that tracker sees it. */
export async function releaseFeed(
  env: Env,
  actor: Actor | null,
  ownerSlug: string,
  q: string,
): Promise<ReleaseFeed> {
  if (!actor) throw new FeedError(401, "Sign in to read release notes.");
  const owner = await findAccountBySlug(env.DB, ownerSlug);
  if (!owner) throw new FeedError(404, "Tracker account not found.");
  const trackers = await viewerTrackers(env.DB, actor);
  if (!trackers.has(owner.id))
    throw new FeedError(403, "Release notes for a tracker require account membership.");

  const query = parseReleaseQuery(q);
  const d = db(env.DB);
  // Narrow in SQL by the cheap facets; the rest are applied with access rules.
  let select = d
    .selectFrom("release_note_entries as e")
    .innerJoin("repos as r", "r.id", "e.repo_id")
    .innerJoin("accounts as a", "a.id", "r.owner_id")
    .selectAll("e")
    .select(["a.slug as repo_owner", "r.name as repo_name"])
    .where((eb) =>
      eb.or([eb("e.tracker_owner_id", "=", owner.id), eb("r.owner_id", "=", owner.id)]),
    );
  for (const filter of query.filters) {
    if (filter.negated) continue;
    if (filter.key === "type")
      select = select.where("e.category", "=", filter.value as EntryRow["category"]);
    if (filter.key === "team") select = select.where("e.team_key", "=", filter.value.toUpperCase());
  }
  const [rows, repos, workspaces] = await Promise.all([
    select.orderBy("e.shipped_at", "desc").limit(SCAN_LIMIT).execute(),
    visibleRepos(env.DB, actor),
    trackerObject(env, owner.id).workspaceSlugs(),
  ]);
  return {
    owner: { slug: owner.slug, displayName: owner.display_name },
    ...buildFeed(rows, {
      trackers,
      visibleRepoIds: new Set(repos.map((repo) => repo.id)),
      workspaces: new Map(workspaces.ok ? workspaces.value.map((w) => [w.id, w.slug]) : []),
      query,
      now: Date.now(),
      limit: FEED_LIMIT,
    }),
  };
}
