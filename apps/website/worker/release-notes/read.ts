// Reading stored release notes for one viewer. Repository access is checked by
// the caller; here, entries about issues from trackers the viewer can't read
// are left out, and so is any introduction those issues shaped.

import type {
  ReleaseNoteChange,
  ReleaseNoteEntry,
  ReleaseNotesIndex,
  ReleaseNotesRelease,
  ReleaseNotesState,
  ReleaseSummary,
} from "../../shared/release-notes.ts";
import { UNRELEASED } from "../../shared/release-notes.ts";
import type { Actor } from "../db.ts";
import { db, type Database } from "../schema.ts";
import { accessible } from "../tracker/api.ts";
import type { Selectable } from "kysely";

/** Tracker accounts the viewer can read, by id, with their slugs. */
export type ViewerTrackers = Map<string, string>;

export async function viewerTrackers(d1: D1Database, actor: Actor | null): Promise<ViewerTrackers> {
  if (!actor) return new Map();
  return new Map((await accessible(d1, actor)).map((owner) => [owner.id, owner.slug]));
}

export type EntryRow = Selectable<Database["release_note_entries"]>;

/** An entry as the viewer may see it, or null when its issue's tracker is closed to them. */
export function toEntry(row: EntryRow, trackers: ViewerTrackers): ReleaseNoteEntry | null {
  let issue: ReleaseNoteEntry["issue"] = null;
  if (row.kind === "issue") {
    const trackerOwner = row.tracker_owner_id ? trackers.get(row.tracker_owner_id) : undefined;
    if (!trackerOwner) return null;
    issue = {
      trackerOwner,
      id: row.issue_id!,
      key: row.issue_key!,
      type: row.issue_type ?? "task",
      team: { id: row.team_id!, key: row.team_key! },
    };
  }
  return {
    id: row.id,
    release: row.release,
    kind: row.kind,
    category: row.category,
    title: row.title,
    summary: row.summary,
    issue,
    labels: JSON.parse(row.labels) as string[],
    workspaceIds: JSON.parse(row.workspace_ids) as string[],
    commits: JSON.parse(row.commits) as string[],
    changes: JSON.parse(row.changes) as ReleaseNoteChange[],
    shippedAt: row.shipped_at,
    model: row.model,
    updatedAt: row.updated_at,
  };
}

const CATEGORY_ORDER = { feature: 0, fix: 1, improvement: 2, internal: 3 } as const;

/** Releases newest first, unreleased work on top. */
function byRecency(a: { release: string; released_at: string }, b: typeof a) {
  if (a.release === UNRELEASED) return -1;
  if (b.release === UNRELEASED) return 1;
  return b.released_at.localeCompare(a.released_at) || b.release.localeCompare(a.release);
}

export async function releaseIndex(
  d1: D1Database,
  repoId: string,
  trackers: ViewerTrackers,
  aiEnabled: boolean,
): Promise<ReleaseNotesIndex> {
  const d = db(d1);
  const [state, releases, entries] = await Promise.all([
    d
      .selectFrom("release_note_state")
      .select(["status", "generated_at", "dirty"])
      .where("repo_id", "=", repoId)
      .executeTakeFirst(),
    d.selectFrom("release_notes").selectAll().where("repo_id", "=", repoId).execute(),
    d
      .selectFrom("release_note_entries")
      .select(["release", "kind", "tracker_owner_id"])
      .where("repo_id", "=", repoId)
      .execute(),
  ]);
  const counts = new Map<string, number>();
  for (const entry of entries)
    if (entry.kind === "commit" || trackers.has(entry.tracker_owner_id ?? ""))
      counts.set(entry.release, (counts.get(entry.release) ?? 0) + 1);
  let stateName: ReleaseNotesState = "idle";
  if (!aiEnabled) stateName = "disabled";
  else if (state?.status === "generating" || state?.dirty) stateName = "generating";
  else if (state?.status === "failed") stateName = "failed";
  else if (state?.status === "ready") stateName = "ready";
  return {
    status: { state: stateName, generatedAt: state?.generated_at ?? null },
    releases: releases.sort(byRecency).map((row): ReleaseSummary => ({
      name: row.release,
      toOid: row.to_oid,
      fromTag: row.from_tag,
      releasedAt: row.released_at,
      updatedAt: row.updated_at,
      entries: counts.get(row.release) ?? 0,
    })),
  };
}

export async function releaseNotesFor(
  d1: D1Database,
  repoId: string,
  name: string,
  trackers: ViewerTrackers,
): Promise<ReleaseNotesRelease | null> {
  const d = db(d1);
  const row = await d
    .selectFrom("release_notes")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("release", "=", name)
    .executeTakeFirst();
  if (!row) return null;
  const rows = await d
    .selectFrom("release_note_entries")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("release", "=", name)
    .execute();
  const entries = rows
    .flatMap((entry) => toEntry(entry, trackers) ?? [])
    .sort(
      (a, b) =>
        CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
        b.shippedAt.localeCompare(a.shippedAt) ||
        a.title.localeCompare(b.title),
    );
  const shapedBy = JSON.parse(row.intro_trackers) as string[];
  const intro = shapedBy.every((id) => trackers.has(id)) ? row.intro : null;
  return {
    release: {
      name: row.release,
      toOid: row.to_oid,
      fromTag: row.from_tag,
      fromOid: row.from_oid,
      truncated: Boolean(row.truncated),
      releasedAt: row.released_at,
      updatedAt: row.updated_at,
      entries: entries.length,
      intro,
      introModel: intro ? row.intro_model : null,
    },
    entries,
  };
}
