// An issue's linked work (CORE-250; shapes in shared/chronicle.ts): what its
// work produced, each item with the page the web app opens for it.
//
// Commits come from the issue's agent work contexts (step_contexts by issue
// key), its release-note entries, and the checkpoints and landing merges of
// the timelines it was worked in. CI runs, deployments and published
// packages are found by those commits; landings add their own runs.
//
// Only repositories in the tracker's Space are searched, and of those only
// what the viewer can read is returned: an unreadable repository's items are
// left out without a trace. Every list is bounded (WORK_LIMIT).
//
// Mentions (CORE-22) are separate: commits whose message names the issue, as
// the push-time index resolved them to this tracker's issue (worker/mentions),
// in any repository the viewer can read, each with its own CI runs and
// packages. They never feed the explicit lists.

import {
  WORK_LIMIT,
  type LinkedWork,
  type WorkCommit,
  type WorkCommitSource,
  type WorkDeployment,
  type WorkMention,
  type WorkPackage,
  type WorkRepo,
  type WorkRun,
  type WorkStep,
  type WorkTimeline,
} from "../../shared/chronicle.ts";
import { packagePath } from "../../shared/packages.ts";
import type { FormatId } from "../../shared/packages.ts";
import { releaseLabel, type ReleaseCategory } from "../../shared/release-notes.ts";
import type { StepContextBody } from "../../shared/steps.ts";
import type { AuditActor } from "../../shared/tracker.ts";
import { readableRepo, roleFor, selectRepos, type Actor } from "../db.ts";
import { sql, type Selectable } from "kysely";
import { db, type Database } from "../schema.ts";
import type { IssueWork } from "./store.ts";
import { canReadSpacePackages } from "../../registry/core/acl.ts";

/** Commits looked up for runs, deployments and packages, newest first. */
const COMMITS = 60;

const enc = encodeURIComponent;
const repoHref = (repo: WorkRepo, ...rest: string[]) =>
  `/${repo.space}/${repo.name}${rest.length ? `/${rest.join("/")}` : ""}`;
/**
 * The commit panel (CORE-22): the repository's page with `?commit=<full sha>`,
 * in the work source that has the commit when it isn't main's (CORE-296).
 */
const commitHref = (repo: WorkRepo, oid: string, source = "canonical") =>
  `${repoHref(repo)}?${source === "canonical" ? "" : `source=${enc(source)}&`}commit=${oid}`;

function shorten(text: string, max = 280): string {
  const plain = text.trim().replace(/\s+/g, " ");
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function chunks<T>(items: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function linkedWork(
  env: Env,
  actor: Actor,
  space: { id: string; slug: string },
  work: IssueWork,
): Promise<LinkedWork> {
  const k = db(env.DB);
  const { issue } = work;
  let truncated = false;

  // Associations are discovery only; even corrupt cross-Space subscriptions
  // or timeline references cannot widen the authoritative repository scope.
  const scope = await selectRepos(env.DB, actor.id).where("r.space_id", "=", space.id).execute();
  const readable = new Map<string, WorkRepo>();
  for (const row of scope)
    if (roleFor(row, actor) !== "none")
      readable.set(row.id, { id: row.id, space: row.space_slug, name: row.name });
  const repoIds = [...readable.keys()];

  const commits = new Map<string, WorkCommit>();
  const addCommit = (
    repoId: string,
    oid: string,
    source: WorkCommitSource,
    extra: Partial<Pick<WorkCommit, "changeId" | "summary" | "at">> = {},
  ) => {
    const repo = readable.get(repoId);
    if (!repo || !/^[0-9a-f]{40}$/.test(oid)) return;
    const key = `${repoId}:${oid}`;
    const known = commits.get(key) ?? {
      repo,
      oid,
      changeId: null,
      summary: null,
      at: null,
      sources: [],
      href: commitHref(repo, oid),
    };
    if (!known.sources.includes(source)) known.sources.push(source);
    known.changeId ??= extra.changeId ?? null;
    known.summary ??= extra.summary ?? null;
    if (extra.at && (!known.at || extra.at > known.at)) known.at = extra.at;
    commits.set(key, known);
  };

  // Agent work contexts (CORE-231), newest first.
  const stepRows = repoIds.length
    ? await k
        .selectFrom("step_contexts")
        .selectAll()
        .where("issue_key", "=", issue.key)
        .where("repo_id", "in", repoIds)
        .orderBy("committed_at", "desc")
        .limit(WORK_LIMIT + 1)
        .execute()
    : [];
  if (stepRows.length > WORK_LIMIT) truncated = true;
  const people = [...new Set(stepRows.flatMap((r) => [r.author_id, r.accountable_id]))];
  const [agentRows, accountRows] = people.length
    ? await Promise.all([
        k.selectFrom("agents").select(["id", "name"]).where("id", "in", people).execute(),
        k
          .selectFrom("accounts")
          .select(["id", "slug", "display_name"])
          .where("id", "in", people)
          .execute(),
      ])
    : [[], []];
  const agentName = new Map(agentRows.map((a) => [a.id, a.name]));
  const account = new Map(accountRows.map((a) => [a.id, a]));
  const steps: WorkStep[] = stepRows.slice(0, WORK_LIMIT).map((row) => {
    const repo = readable.get(row.repo_id)!;
    const person = account.get(row.accountable_id);
    const accountable = person
      ? { id: person.id, slug: person.slug, displayName: person.display_name }
      : null;
    const author: AuditActor = agentName.has(row.author_id)
      ? {
          id: row.author_id,
          kind: "agent",
          name: agentName.get(row.author_id)!,
          accountable,
        }
      : {
          id: row.author_id,
          kind: account.has(row.author_id) ? "person" : "unknown",
          name: account.get(row.author_id)?.display_name ?? null,
          accountable: null,
        };
    let context: Partial<StepContextBody> = {};
    try {
      context = JSON.parse(row.context) as Partial<StepContextBody>;
    } catch {
      context = {};
    }
    addCommit(row.repo_id, row.commit_oid, "step", {
      changeId: row.change_id,
      summary: row.summary || null,
      at: row.committed_at,
    });
    return {
      repo,
      changeId: row.change_id,
      commitOid: row.commit_oid,
      summary: row.summary,
      author,
      committedAt: row.committed_at,
      verified: row.verified_at !== null,
      timeline: row.timeline,
      why: row.deleted_at ? "" : shorten(context.why ?? ""),
      model: row.deleted_at ? null : (context.model ?? null),
      href: commitHref(repo, row.commit_oid),
    };
  });

  // Release-note entries written for the issue.
  const entryRows = repoIds.length
    ? await k
        .selectFrom("release_note_entries")
        .select(["repo_id", "release", "title", "category", "commits", "shipped_at"])
        .where("tracker_space_id", "=", space.id)
        .where("issue_key", "=", issue.key)
        .where("repo_id", "in", repoIds)
        .orderBy("shipped_at", "desc")
        .limit(WORK_LIMIT + 1)
        .execute()
    : [];
  if (entryRows.length > WORK_LIMIT) truncated = true;
  const releaseNotes = entryRows.slice(0, WORK_LIMIT).map((row) => {
    const repo = readable.get(row.repo_id)!;
    let oids: string[] = [];
    try {
      oids = JSON.parse(row.commits) as string[];
    } catch {
      oids = [];
    }
    for (const oid of oids.slice(0, 20))
      addCommit(row.repo_id, oid, "release-note", { at: row.shipped_at });
    return {
      repo,
      release: row.release,
      label: releaseLabel(row.release),
      title: row.title,
      category: row.category as ReleaseCategory,
      shippedAt: row.shipped_at,
      href: repoHref(repo, "releases", enc(row.release)),
    };
  });

  // The timelines it was worked in: their checkpoints and landings.
  const timelines: WorkTimeline[] = [];
  const landingRuns: { repoId: string; number: number }[] = [];
  const checkpointIds: string[] = [];
  for (const { timeline, checkpoints, landings } of work.timelines) {
    const href = `/tracker/${enc(space.slug)}/timelines?tl=${enc(timeline.slug)}`;
    timelines.push({
      id: timeline.id,
      slug: timeline.slug,
      name: timeline.name,
      status: timeline.status,
      policy: timeline.policy,
      href,
      checkpoints: [...checkpoints].reverse().map((state) => {
        const { checkpoint } = state;
        checkpointIds.push(checkpoint.id);
        for (const repo of checkpoint.repos)
          addCommit(repo.id, repo.commit, "checkpoint", { at: checkpoint.createdAt });
        return {
          id: checkpoint.id,
          number: checkpoint.number,
          createdAt: checkpoint.createdAt,
          summary: shorten(checkpoint.summary),
          approval: state.approval?.state ?? null,
          commits: checkpoint.repos.flatMap((repo) => {
            const known = readable.get(repo.id);
            return known ? [{ repo: known, oid: repo.commit }] : [];
          }),
          href,
        };
      }),
      landings: landings.map((landing) => ({
        id: landing.id,
        checkpointNumber: landing.checkpointNumber,
        state: landing.state,
        createdAt: landing.createdAt,
        updatedAt: landing.updatedAt,
        runs: landing.repos.flatMap((repo) => {
          const known = readable.get(repo.id);
          if (!known) return [];
          if (repo.merge) addCommit(repo.id, repo.merge, "landing", { at: landing.updatedAt });
          return [repo.mergeRun, repo.gateRun].flatMap((run) => {
            if (!run) return [];
            landingRuns.push({ repoId: repo.id, number: run.number });
            return [
              { repo: known, number: run.number, href: repoHref(known, "ci", String(run.number)) },
            ];
          });
        }),
        href,
      })),
    });
  }

  const commitList = [...commits.values()].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  if (commitList.length > COMMITS) truncated = true;
  const looked = commitList.slice(0, COMMITS);
  const byRepo = new Map<string, string[]>();
  for (const commit of looked)
    byRepo.set(commit.repo.id, [...(byRepo.get(commit.repo.id) ?? []), commit.oid]);

  // CI runs of those commits, and the landings' own runs.
  const runRows = await runsOf(k, byRepo);
  for (const { repoId, number } of landingRuns)
    if (!runRows.some((r) => r.repo_id === repoId && r.number === number)) {
      const row = await k
        .selectFrom("ci_runs")
        .selectAll()
        .where("repo_id", "=", repoId)
        .where("number", "=", number)
        .executeTakeFirst();
      if (row) runRows.push(row);
    }
  const runs: WorkRun[] = runRows
    .filter((row) => readable.has(row.repo_id))
    .map((row) => workRun(row, readable.get(row.repo_id)!))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (runs.length > WORK_LIMIT) truncated = true;

  // Deployments of those commits, or of the timelines' checkpoints.
  const deploymentRows: Selectable<Database["deployments"]>[] = [];
  for (const [repoId, oids] of byRepo)
    for (const part of chunks(oids))
      deploymentRows.push(
        ...(await k
          .selectFrom("deployments")
          .selectAll()
          .where("repo_id", "=", repoId)
          .where("commit_oid", "in", part)
          .orderBy("id", "desc")
          .limit(WORK_LIMIT + 1)
          .execute()),
      );
  for (const part of chunks(checkpointIds))
    deploymentRows.push(
      ...(await k
        .selectFrom("deployments")
        .selectAll()
        .where("checkpoint_id", "in", part)
        .orderBy("id", "desc")
        .limit(WORK_LIMIT + 1)
        .execute()),
    );
  const seenDeployments = new Set<number>();
  const deployments: WorkDeployment[] = deploymentRows
    .filter((row) => readable.has(row.repo_id) && !seenDeployments.has(row.id))
    .map((row) => {
      seenDeployments.add(row.id);
      const repo = readable.get(row.repo_id)!;
      const live = row.url && (row.status === "active" || row.status === "sleeping");
      const run = row.run_id ? runRows.find((r) => r.id === row.run_id) : undefined;
      return {
        repo,
        repoId: row.repo_id,
        sourceId: row.source_id,
        id: row.id,
        environment: row.environment,
        status: row.status,
        commit: row.commit_oid,
        url: row.url,
        provider:
          row.provider && row.provider_service && row.provider_version_id
            ? {
                name: row.provider,
                service: row.provider_service,
                versionId: row.provider_version_id,
              }
            : null,
        artifact:
          row.artifact_name && row.artifact_version
            ? {
                name: row.artifact_name,
                version: row.artifact_version,
                digest: row.artifact_digest,
              }
            : null,
        percentage: row.percentage,
        createdAt: row.created_at,
        href: live
          ? row.url!
          : run
            ? repoHref(repo, "ci", String(run.number))
            : repoHref(repo, "ci"),
      } satisfies WorkDeployment;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (deployments.length > WORK_LIMIT) truncated = true;

  // Packages published from those commits.
  const packages = await packagesOf(env, actor, byRepo, readable);
  if (packages.length > WORK_LIMIT) truncated = true;

  // Commits that mention it (CORE-22), apart from the evidence above.
  const mentionRows = await k
    .selectFrom("commit_issue_mentions as m")
    .innerJoin("repos as r", "r.id", "m.repo_id")
    .innerJoin("spaces as s", "s.id", "r.space_id")
    .select([
      "m.repo_id",
      "m.commit_oid",
      "m.change_id",
      "m.title",
      "m.committed_at",
      "m.first_ref",
      "m.pushed_at",
      "m.source_id",
      "r.name",
      "s.slug as space_slug",
    ])
    .where("m.tracker_space_id", "=", space.id)
    .where("r.space_id", "=", space.id)
    .where("m.issue_id", "=", issue.id)
    .where("m.resolution", "=", "linked")
    .where("r.deleted_at", "is", null)
    .where(readableRepo(actor))
    .orderBy(sql`coalesce(m.committed_at, m.pushed_at)`, "desc")
    .orderBy("m.commit_oid")
    .limit(WORK_LIMIT + 1)
    .execute();
  if (mentionRows.length > WORK_LIMIT) truncated = true;
  const mentioned = new Map<string, WorkRepo>();
  const mentionedOids = new Map<string, string[]>();
  for (const row of mentionRows.slice(0, WORK_LIMIT)) {
    mentioned.set(row.repo_id, { id: row.repo_id, space: row.space_slug, name: row.name });
    mentionedOids.set(row.repo_id, [...(mentionedOids.get(row.repo_id) ?? []), row.commit_oid]);
  }
  const [mentionRuns, mentionPackages] = mentionRows.length
    ? await Promise.all([
        runsOf(k, mentionedOids),
        packagesOf(env, actor, mentionedOids, mentioned),
      ])
    : [[], []];
  const mentions: WorkMention[] = mentionRows.slice(0, WORK_LIMIT).map((row) => {
    const repo = mentioned.get(row.repo_id)!;
    return {
      repo,
      oid: row.commit_oid,
      changeId: row.change_id,
      title: row.title,
      committedAt: row.committed_at,
      ref: row.first_ref,
      pushedAt: row.pushed_at,
      href: commitHref(repo, row.commit_oid, row.source_id),
      runs: mentionRuns
        .filter((r) => r.repo_id === row.repo_id && r.commit_oid === row.commit_oid)
        .map((r) => workRun(r, repo))
        .slice(0, 10),
      packages: mentionPackages
        .filter((p) => p.repo.id === row.repo_id && p.commit === row.commit_oid)
        .slice(0, 10),
    };
  });

  return {
    issue,
    commits: looked.slice(0, WORK_LIMIT),
    steps,
    runs: runs.slice(0, WORK_LIMIT),
    deployments: deployments.slice(0, WORK_LIMIT),
    packages: packages.slice(0, WORK_LIMIT),
    timelines,
    releaseNotes,
    mentions,
    truncated: truncated || looked.length > WORK_LIMIT,
  };
}

/** The top-level CI runs of `byRepo`'s commits (repository id to commit ids). */
async function runsOf(
  k: ReturnType<typeof db>,
  byRepo: Map<string, string[]>,
): Promise<Selectable<Database["ci_runs"]>[]> {
  const rows: Selectable<Database["ci_runs"]>[] = [];
  for (const [repoId, oids] of byRepo)
    for (const part of chunks(oids))
      rows.push(
        ...(await k
          .selectFrom("ci_runs")
          .selectAll()
          .where("repo_id", "=", repoId)
          .where("commit_oid", "in", part)
          .where("step", "=", 0)
          .orderBy("number", "desc")
          .limit(WORK_LIMIT + 1)
          .execute()),
      );
  return rows;
}

function workRun(row: Selectable<Database["ci_runs"]>, repo: WorkRepo): WorkRun {
  return {
    repo,
    number: row.number,
    status: row.status,
    commit: row.commit_oid,
    ref: row.ref,
    title: row.title,
    kind: row.landing_id ? "landing" : row.preview_action ? "preview" : row.trigger,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    href: repoHref(repo, "ci", String(row.number)),
  };
}

/** Packages published from `byRepo`'s commits, newest first, in `readable` repositories. */
async function packagesOf(
  env: Env,
  actor: Actor,
  byRepo: Map<string, string[]>,
  readable: Map<string, WorkRepo>,
): Promise<WorkPackage[]> {
  const publishRows: {
    format: string;
    name: string;
    version: string;
    space_id: string;
    visibility: "public" | "internal" | "private";
    commit_oid: string;
    git_repo_id: string;
    at: string;
  }[] = [];
  for (const [repoId, oids] of byRepo)
    for (const part of chunks(oids, 80)) {
      const { results } = await env.REGISTRY_DB.prepare(
        `SELECT u.format, p.name, u.version, r.space_id, r.visibility, u.commit_oid, u.git_repo_id, u.at
         FROM publishes u
         JOIN packages p ON p.id = u.package_id
         JOIN repositories r ON r.id = u.feed_id
         WHERE u.git_repo_id = ? AND u.commit_oid IN (SELECT value FROM json_each(?))
           AND u.status != 'deleted'
         ORDER BY u.at DESC LIMIT ?`,
      )
        .bind(repoId, JSON.stringify(part), WORK_LIMIT + 1)
        .all<(typeof publishRows)[number]>();
      publishRows.push(...results);
    }
  const feedSpaces = [...new Set(publishRows.map((row) => row.space_id))];
  const spaceSlugs = feedSpaces.length
    ? new Map(
        (
          await db(env.DB)
            .selectFrom("spaces")
            .select(["id", "slug"])
            .where("id", "in", feedSpaces)
            .execute()
        ).map((a) => [a.id, a.slug]),
      )
    : new Map<string, string>();
  const packages: WorkPackage[] = [];
  for (const row of publishRows) {
    const slug = spaceSlugs.get(row.space_id);
    const repo = readable.get(row.git_repo_id);
    if (!slug || !repo) continue;
    if (!(await canReadSpacePackages(env.DB, actor, row.space_id, row.visibility))) continue;
    packages.push({
      format: row.format,
      name: row.name,
      version: row.version,
      space: slug,
      commit: row.commit_oid,
      repo,
      at: row.at,
      href: packagePath(slug, row.format as FormatId, row.name),
    });
  }
  return packages.sort((a, b) => b.at.localeCompare(a.at));
}
