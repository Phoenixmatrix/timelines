// Where packages come from. Two hooks every format passes through:
//
//   authorizePublish  before anything is written: may this caller publish this
//                     package? Packages remember their sources (repositories
//                     granted to publish them). Once a package has sources, only
//                     their CI jobs and people with write on them may publish;
//                     a CI job publishing a package with no sources claims it
//                     for its repository. Explicit Space admins can publish.
//   recordPublish     after: one row in `publishes` per version, file, tag or
//                     asset, with repository, commit, branch, run and actor.
//                     That stream is each package's history and what the
//                     console queries.
//
// Only a repository's default branch moves `latest`. A CI job building any
// other branch still publishes its versions, with their branch, but they never
// become `latest`, whether by tag or as the newest publish (`movesLatest`,
// `offDefaultVersions`). People publishing by hand keep moving it.
//
// Catalog formats reach both through catalog.ts; OCI, releases and generic,
// which keep their own tables, call them where they publish.

import { atLeast } from "../../worker/permissions.ts";
import { roleFor, selectRepos } from "../../worker/db.ts";
import { currentPerson } from "./auth/authenticate.ts";
import { db as gitmatrixDb } from "../../worker/schema.ts";
import { actorLabel, principalOf, type Actor } from "./auth/actor.ts";
import { currentServices } from "./context.ts";
import { nowIso, type DB } from "./db.ts";
import { RegistryError } from "./errors.ts";
import { ulid } from "./ids.ts";
import { getRepoById, type Repository } from "./repos.ts";

export interface PackageRef {
  id: string;
  name: string;
  repoId: string;
}

const branchName = (ref: string) => ref.replace(/^refs\/heads\//, "");

/**
 * Whether what this caller publishes may become `latest`: everything but a CI
 * job building a branch other than its repository's default.
 */
export function movesLatest(actor: Actor): boolean {
  const job = actor.kind === "job" ? actor.job : undefined;
  // Registry tokens minted before jobs knew their default branch: as before.
  if (!job?.defaultBranch) return true;
  return branchName(job.ref) === branchName(job.defaultBranch);
}

/** Refuses to let a CI job off its repository's default branch point `latest` anywhere. */
export function requireMovesLatest(actor: Actor): void {
  if (movesLatest(actor)) return;
  const job = actor.job!;
  throw RegistryError.denied(
    `Only ${job.repo}'s default branch (${job.defaultBranch}) moves latest; this job built ${job.ref}.`,
  );
}

/** Versions of these packages published from a non-default branch: never `latest`. */
export async function offDefaultVersions(db: DB, packageIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < packageIds.length; i += 90) {
    const rows = await db
      .selectFrom("publishes")
      .select("version")
      .distinct()
      .where("package_id", "in", packageIds.slice(i, i + 90))
      .where("off_default_branch", "=", 1)
      .execute();
    for (const row of rows) out.add(row.version);
  }
  return out;
}

async function feedOf(db: DB, repoId: string): Promise<Repository | null> {
  return getRepoById(db, repoId);
}

/** Whether a person has write on at least one of these repositories. */
async function writesAny(d1: D1Database, actor: Actor, repoIds: string[]): Promise<boolean> {
  if (actor.kind !== "user" || !actor.subject || repoIds.length === 0) return false;
  const person = await currentPerson(d1, actor);
  if (!person) return false;
  const results = await selectRepos(d1, person.id).where("r.id", "in", repoIds).execute();
  return results.some((row) => atLeast(roleFor(row, person), "write"));
}

/**
 * Throws `denied` unless the current caller may publish `pkg`. Background
 * maintenance is not a publishing principal. Upstream cache fills are not
 * local package publications.
 */
export async function authorizePublish(db: DB, pkg: PackageRef): Promise<void> {
  const services = currentServices();
  const feed = await feedOf(db, pkg.repoId);
  if (!feed) throw RegistryError.notFound("No package feed");
  if (feed.kind !== "local") return;
  if (!services) throw RegistryError.denied("Publishing requires current request authorization");
  const access = await services.access();
  await access.require(feed, "write");
  const actor = access.actor;

  const sources = (
    await db
      .selectFrom("package_sources")
      .select("git_repo_id")
      .where("package_id", "=", pkg.id)
      .execute()
  ).map((r) => r.git_repo_id);
  if (sources.length) {
    const valid = await gitmatrixDb(services.env.DB)
      .selectFrom("repos")
      .select("id")
      .where("id", "in", sources)
      .where("space_id", "=", feed.spaceId)
      .where("deleted_at", "is", null)
      .execute();
    if (valid.length !== sources.length)
      throw RegistryError.denied("Package sources must be live repositories in this Space");
  }
  if (await access.isAdmin()) return;

  if (actor.kind === "job" && actor.job) {
    const job = actor.job;
    if (job.spaceId !== feed.spaceId)
      throw RegistryError.denied("Package source belongs to a different Space");
    if (sources.includes(job.repoId)) return;
    if (sources.length === 0) {
      // First CI publish: the package now remembers this repository.
      await db
        .insertInto("package_sources")
        .values({
          package_id: pkg.id,
          git_repo_id: job.repoId,
          granted_by: principalOf(actor),
          granted_at: nowIso(),
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      return;
    }
    throw RegistryError.denied(
      `${job.repo} is not an authorized source of ${pkg.name}. A Space admin can manage package sources.`,
    );
  }

  if (actor.kind === "user") {
    const role = await access.roleForSpace(feed.spaceId);
    if (role === "admin") return;
    if (
      sources.length === 0 ? role === "write" : await writesAny(services.env.DB, actor, sources)
    ) {
      return;
    }
    throw RegistryError.denied(
      `Publishing ${pkg.name} requires package write and write access to an authorized source.`,
    );
  }
  throw RegistryError.unauthorized();
}

export interface PublishRecord {
  packageId: string;
  repoId: string;
  version: string;
  action?: string;
  digest?: string | null;
  size?: number | null;
}

/** Append one publish to the package's history, with where it came from. */
export async function recordPublish(db: DB, record: PublishRecord): Promise<void> {
  const services = currentServices();
  if (!services) return;
  const feed = await feedOf(db, record.repoId);
  if (!feed || feed.kind !== "local") return;
  const actor = await services.actor();
  const job = actor.job;
  await db
    .insertInto("publishes")
    .values({
      id: ulid(),
      feed_id: feed.id,
      format: feed.format,
      package_id: record.packageId,
      version: record.version,
      digest: record.digest ?? null,
      size: record.size ?? null,
      action: record.action ?? `${feed.format}.publish`,
      git_repo_id: job?.repoId ?? null,
      commit_oid: job?.commit ?? null,
      source_id: job?.sourceId ?? null,
      ref: job?.ref ?? null,
      off_default_branch: movesLatest(actor) ? 0 : 1,
      ci_run_id: job?.runId ?? null,
      ci_job_id: job?.jobId ?? null,
      run_number: job?.runNumber ?? null,
      actor: principalOf(actor) ?? "system",
      actor_label: actorLabel(actor),
      // A job pushing through Docker's token flow is still the job.
      via: actor.kind === "job" ? "job" : actor.via,
      at: nowIso(),
    })
    .execute();
}

/** Attach a stored file's size (and the first file's digest) to its publish. */
export async function addPublishedFile(
  db: DB,
  packageId: string,
  version: string,
  file: { digest: string; size: number },
): Promise<void> {
  const latest = await db
    .selectFrom("publishes")
    .select(["id", "digest", "size"])
    .where("package_id", "=", packageId)
    .where("version", "=", version)
    .orderBy("at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!latest) return;
  await db
    .updateTable("publishes")
    .set({ size: (latest.size ?? 0) + file.size, digest: latest.digest ?? file.digest })
    .where("id", "=", latest.id)
    .execute();
}

/** Yanks, deprecations and deletions show in the history too. */
export async function markPublishes(
  db: DB,
  packageId: string,
  version: string | null,
  status: "active" | "yanked" | "deprecated" | "deleted",
): Promise<void> {
  let query = db.updateTable("publishes").set({ status }).where("package_id", "=", packageId);
  if (version !== null) query = query.where("version", "=", version);
  await query.execute();
}

/**
 * Formats that publish file by file (generic, releases): the first file of a
 * version starts its history row, later ones add to its size.
 */
export async function recordFile(
  db: DB,
  record: Omit<PublishRecord, "digest" | "size">,
  file: { digest: string; size: number },
): Promise<void> {
  const existing = await db
    .selectFrom("publishes")
    .select("id")
    .where("package_id", "=", record.packageId)
    .where("version", "=", record.version)
    .limit(1)
    .executeTakeFirst();
  if (existing) await addPublishedFile(db, record.packageId, record.version, file);
  else await recordPublish(db, { ...record, digest: file.digest, size: file.size });
}

/** Generic paths read as `<package>/<version>/<file…>`. */
export function genericCoordinates(path: string): { name: string; version: string } {
  const parts = path.split("/");
  const name = parts[0] ?? path;
  if (parts.length >= 3) return { name, version: parts[1] as string };
  return { name, version: parts.slice(1).join("/") || name };
}
