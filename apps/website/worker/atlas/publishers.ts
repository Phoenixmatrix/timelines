// Which packages a repository publishes (CORE-167): the publisher side of a
// resolved cross-repository dependency.
//
// The source is the registry's own CI publish provenance, not a guess from
// names: `package_sources` lists the repositories granted to publish each
// package (a package's first CI publish names its repository; Space admins
// add more), and `publishes` records every version with its repository,
// commit, branch and run (registry/core/provenance.ts).
//
// Recorded at build time, frozen per snapshot. `recordPublishedPackages` runs
// in the KnowledgeBuild's projection (`atlas-packages`) and stores what the
// registry says *then* in the repository snapshot's `packages` column, so a
// pinned workspace view resolves against the same facts on every page and
// browsing reads no registry provenance. It is bounded (MAX_RECORDED) and
// never fails the projection: a registry error is recorded as such.
//
// Gated at read time. A package lives in a feed with its own access rules, so
// a reader of the repository may not be allowed to know it publishes there.
// `readableFeeds` asks the registry's AccessControl, as the caller, which of
// the recorded feeds they can read now; packages in other feeds are never
// used, so they can't show up as resolution evidence.

import {
  ALL_SCOPES,
  ANONYMOUS,
  type Actor as RegistryActor,
} from "../../registry/core/auth/actor.ts";
import { AccessControl } from "../../registry/core/acl.ts";
import { createDb } from "../../registry/core/db.ts";
import { getRepoById } from "../../registry/core/repos.ts";
import type { Actor } from "../db.ts";

/** Registry formats a knowledge-graph package import can resolve to. */
export const RESOLVABLE_FORMATS = ["npm", "cargo", "pypi", "go"] as const;
export type ResolvableFormat = (typeof RESOLVABLE_FORMATS)[number];

/** Packages recorded per repository snapshot, at most. */
export const MAX_RECORDED = 500;

export interface RecordedPackage {
  format: ResolvableFormat;
  /** The package's registry name, as published. */
  name: string;
  /** The registry's normalized name (what it matches on). */
  normalized: string;
  feedId: string;
  /** The feed's key (its Space's slug). */
  feed: string;
  /** The latest active publish from this repository, when there is one. */
  publish: {
    version: string;
    commit: string | null;
    ref: string | null;
    runNumber: number | null;
    at: string;
  } | null;
}

export type RecordedPackages =
  | { status: "recorded"; packages: RecordedPackage[]; truncated: boolean }
  | { status: "error" };

/**
 * What the registry says `repoId` publishes, for a snapshot being built:
 * packages in local feeds of a resolvable format that name the repository a
 * source. Sorted, so an unchanged registry records identical JSON.
 */
export async function publishedPackages(
  registry: D1Database,
  repoId: string,
): Promise<RecordedPackages> {
  const rows = await registry
    .prepare(
      `SELECT p.name, p.normalized_name, r.id AS feed_id, r.key AS feed, r.format,
              (SELECT json_object('version', u.version, 'commit', u.commit_oid, 'ref', u.ref,
                                  'runNumber', u.run_number, 'at', u.at)
                 FROM publishes u
                WHERE u.package_id = p.id AND u.git_repo_id = s.git_repo_id AND u.status = 'active'
                ORDER BY u.at DESC, u.id DESC LIMIT 1) AS publish
       FROM package_sources s
       JOIN packages p ON p.id = s.package_id
       JOIN repositories r ON r.id = p.repo_id
       WHERE s.git_repo_id = ? AND r.kind = 'local'
         AND r.format IN (SELECT value FROM json_each(?))
       ORDER BY r.format, p.normalized_name, r.id
       LIMIT ?`,
    )
    .bind(repoId, JSON.stringify(RESOLVABLE_FORMATS), MAX_RECORDED + 1)
    .all<{
      name: string;
      normalized_name: string;
      feed_id: string;
      feed: string;
      format: ResolvableFormat;
      publish: string | null;
    }>();
  return {
    status: "recorded",
    truncated: rows.results.length > MAX_RECORDED,
    packages: rows.results.slice(0, MAX_RECORDED).map((r) => ({
      format: r.format,
      name: r.name,
      normalized: r.normalized_name,
      feedId: r.feed_id,
      feed: r.feed,
      publish: r.publish ? (JSON.parse(r.publish) as RecordedPackage["publish"]) : null,
    })),
  };
}

/**
 * Freeze what `repoId` publishes into a building snapshot. Never throws: a
 * registry failure is recorded as `{status: "error"}` (nothing resolves to the
 * repository in that snapshot), so it can't fail the projection.
 */
export async function recordPublishedPackages(
  env: Pick<Env, "DB" | "REGISTRY_DB">,
  repoId: string,
  snapshotId: string,
): Promise<{ packages: number; error?: string }> {
  let recorded: RecordedPackages;
  let error: string | undefined;
  try {
    recorded = await publishedPackages(env.REGISTRY_DB, repoId);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error("Atlas: couldn't read published packages", repoId, e);
    recorded = { status: "error" };
  }
  const json = JSON.stringify(recorded);
  // Counted toward the snapshot's storage like its rows.
  const bytes = new TextEncoder().encode(json).length;
  await env.DB.prepare(
    `UPDATE atlas_snapshots SET packages = ?, bytes = bytes - coalesce(length(CAST(packages AS BLOB)), 0) + ?
     WHERE id = ? AND status = 'building'`,
  )
    .bind(json, bytes, snapshotId)
    .run();
  return {
    packages: recorded.status === "recorded" ? recorded.packages.length : 0,
    ...(error ? { error: error.slice(0, 300) } : {}),
  };
}

/** Whether a snapshot recorded what its repository publishes (anything since CORE-167 does). */
export async function recordsPackages(d1: D1Database, snapshotId: string): Promise<boolean> {
  const row = await d1
    .prepare(`SELECT packages IS NOT NULL AS recorded FROM atlas_snapshots WHERE id = ?`)
    .bind(snapshotId)
    .first<{ recorded: number }>();
  return Boolean(row?.recorded);
}

/** A recorded snapshot's packages; null for snapshots built before they were recorded. */
export function parseRecorded(raw: string | null): RecordedPackages | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as RecordedPackages;
    return value && (value.status === "recorded" || value.status === "error") ? value : null;
  } catch {
    return null;
  }
}

/** The registry's view of a gitmatrix person, for its own access rules. */
function registryActor(actor: Actor | null): RegistryActor {
  if (!actor) return ANONYMOUS;
  return {
    kind: "user",
    subject: actor.id,
    personId: actor.id,
    agentId: actor.agent?.id ?? null,
    credential: actor.credential,
    name: actor.slug,
    email: null,
    // Reading is all this asks; the person's roles decide the rest.
    scopes: new Set(ALL_SCOPES.filter((s) => s === "packages:read")),
    tokenId: null,
    via: "session",
    isSiteAdmin: actor.isSiteAdmin,
  };
}

/**
 * Which of these feeds the caller may read now, by the registry's own rules
 * (visibility, independent Space package grants). Missing feeds are not readable.
 */
export async function readableFeeds(
  env: Pick<Env, "DB" | "REGISTRY_DB">,
  actor: Actor | null,
  feedIds: string[],
): Promise<Set<string>> {
  const readable = new Set<string>();
  if (feedIds.length === 0) return readable;
  const registry = createDb(env.REGISTRY_DB);
  const access = new AccessControl(registry, env.DB, registryActor(actor));
  for (const id of [...new Set(feedIds)].sort()) {
    const feed = await getRepoById(registry, id);
    if (feed && (await access.can(feed, "read"))) readable.add(id);
  }
  return readable;
}
