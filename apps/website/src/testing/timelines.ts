// Timelines in a browser-test world ("Testing" in README.md): repositories
// with a main, a timeline forked across them with work on its bookmarks,
// checkpoints and approval requests, all through the Worker's own routes.
// What only other machinery records (CI runs and their jobs, deployments,
// wiki page sets, the push log's change ids) is written as that machinery
// leaves it, with `server.sql`.

import type {
  CheckpointView,
  Landing,
  TimelineDetail,
  TimelinePolicy,
} from "../../shared/timelines.ts";
import { commitId } from "./atlas.ts";
import type { TestServer } from "./server.ts";

export interface WorldRepo {
  id: string;
  space: string;
  name: string;
  /** Main's tip. */
  main: string;
  /** The timeline's work tip, in its owned work source. */
  tip: string;
  /** The timeline's owned work source in this repository (CORE-255). */
  sourceId: string;
  /** The branch of that source holding the work (`refs/heads/work`). */
  sourceRef: string;
}

export interface WorldTimeline {
  slug: string;
  name: string;
  /** The issue its approvals are asked on. */
  issue: string;
  repos: WorldRepo[];
}

export async function mutate(server: TestServer, mutations: unknown[]) {
  return server.call("POST", "/api/tracker/orbit/mutate", {
    ...(await server.trackerContract("orbit")),
    operationId: crypto.randomUUID(),
    mutations,
  });
}

/**
 * A timeline across `names` (repositories of orbit, made here), with a commit
 * on each bookmark past main, and an ENG issue to ask approvals on.
 */
export async function timelineWorld(
  server: TestServer,
  {
    slug = "search",
    name = "Search",
    policy = "approval",
    names = ["engine"],
  }: { slug?: string; name?: string; policy?: TimelinePolicy; names?: string[] } = {},
): Promise<WorldTimeline> {
  const repos: WorldRepo[] = [];
  for (const repoName of names) {
    const { id } = await server.repo("orbit", repoName);
    const main = commitId();
    await server.push(`orbit/${repoName}`, "main", main);
    repos.push({
      id,
      space: "orbit",
      name: repoName,
      main,
      tip: main,
      sourceId: "",
      sourceRef: "",
    });
  }
  await mutate(server, [
    {
      kind: "team.create",
      id: "team",
      data: { key: "ENG", name: "Eng", memberIds: ["acc_marco"] },
    },
    { kind: "issue.create", id: "work", data: { teamId: "team", title: `Ship ${name}` } },
  ]);
  const created = await server.call<TimelineDetail>("POST", "/api/tracker/orbit/timelines", {
    slug,
    name,
    policy,
    repos: names.map((n) => `orbit/${n}`),
  });
  for (const repo of repos) {
    const source = created.timeline.repos.find((r) => r.id === repo.id)?.source;
    if (!source || source.kind !== "timeline-work")
      throw new Error(`The timeline has no work source in orbit/${repo.name}`);
    repo.sourceId = source.sourceId;
    repo.sourceRef = source.ref;
  }
  const timeline = { slug, name, issue: "work", repos };
  for (const repo of repos) await work(server, timeline, repo);
  return timeline;
}

/** Push a new commit to the timeline's work in `repo`: its owned source, never canonical. */
export async function work(server: TestServer, _timeline: WorldTimeline, repo: WorldRepo) {
  repo.tip = commitId();
  await server.push(
    `orbit/${repo.name}`,
    repo.sourceRef.replace(/^refs\/heads\//, ""),
    repo.tip,
    repo.sourceId,
  );
  return repo.tip;
}

/** The change ids the push log saw reach the timeline's work in `repo`, oldest first. */
export async function changes(
  server: TestServer,
  _timeline: WorldTimeline,
  repo: WorldRepo,
  ids: string[],
) {
  const ref = repo.sourceRef;
  const [update] = await server.sql<{ id: number }>(
    `INSERT INTO ref_updates (repo_id, source_id, ref, old_oid, new_oid, actor_id)
     VALUES (?, ?, ?, ?, ?, 'acc_marco') RETURNING id`,
    repo.id,
    repo.sourceId,
    ref,
    repo.main,
    repo.tip,
  );
  for (const [i, id] of ids.entries())
    await server.sql(
      `INSERT INTO change_refs (repo_id, source_id, change_id, ref, first_commit_oid,
         first_update_id, last_commit_oid, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      repo.id,
      repo.sourceId,
      id,
      ref,
      repo.tip,
      update!.id,
      repo.tip,
      new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    );
}

/** Make a checkpoint of the bookmarks as they are. */
export function checkpoint(server: TestServer, timeline: WorldTimeline, summary = "") {
  return server.call<CheckpointView>(
    "POST",
    `/api/tracker/orbit/timelines/${timeline.slug}/checkpoints`,
    { summary },
  );
}

/** Ask the issue's accountable person to approve a checkpoint. */
export async function askApproval(
  server: TestServer,
  timeline: WorldTimeline,
  checkpointId: string,
  id = "approve",
) {
  await mutate(server, [
    {
      kind: "request.open",
      id,
      data: {
        issueId: timeline.issue,
        kind: "approval",
        prompt: "Search is ready: **land it**?",
        checkpoint: checkpointId,
      },
    },
  ]);
  return id;
}

/**
 * A CI run, as a push (or a preview, or a landing) leaves it. A run of the
 * timeline's work names its source (`sourceId`); a landing's runs are canonical.
 */
export async function ciRun(
  server: TestServer,
  run: {
    repo: WorldRepo;
    number: number;
    commit: string;
    ref: string;
    sourceId?: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    preview?: "create" | "teardown";
  },
) {
  const id = crypto.randomUUID().replaceAll("-", "");
  await server.sql(
    `INSERT INTO ci_runs (id, repo_id, source_id, number, commit_oid, ref, trigger, status,
       preview_action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    run.repo.id,
    run.sourceId ?? "canonical",
    run.number,
    run.commit,
    run.ref,
    run.preview ? "manual" : "push",
    run.status,
    run.preview ?? null,
  );
  return id;
}

/** A preview, as a CI job records it with the deployments API. */
export async function deployment(
  server: TestServer,
  view: CheckpointView,
  repo: WorldRepo,
  preview: {
    status: "active" | "sleeping" | "expired" | "failed";
    url?: string | null;
    revived?: boolean;
    rebuiltFrom?: number | null;
    expiresAt?: string | null;
    tornDownAt?: string | null;
  },
) {
  const [row] = await server.sql<{ id: number }>(
    `INSERT INTO deployments (repo_id, source_id, environment, timeline_slug, timeline_id,
       checkpoint_id, commit_oid, url, status, revived, rebuilt_from, expires_at, torn_down_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    repo.id,
    repo.sourceId,
    `timeline/${view.timeline.slug}`,
    view.timeline.slug,
    view.timeline.id,
    view.checkpoint.id,
    repo.tip,
    preview.url ?? null,
    preview.status,
    preview.revived ? 1 : 0,
    preview.rebuiltFrom ?? null,
    preview.expiresAt ?? null,
    preview.tornDownAt ?? null,
  );
  return row!.id;
}

/** The timeline's wiki pages for a checkpoint in `repo`, as the page writer leaves them. */
export async function pageSet(
  server: TestServer,
  view: CheckpointView,
  repo: WorldRepo,
  set: {
    status: "queued" | "writing" | "succeeded" | "failed";
    error?: string;
    pages?: {
      slug: string;
      title: string;
      change: "added" | "changed";
      outcome: "written" | "kept";
      body?: string;
    }[];
  },
) {
  const ref = `refs/heads/timeline/${view.timeline.slug}`;
  const key = view.checkpoint.id;
  await server.sql(
    `INSERT INTO kg_page_sets (repo_id, source_id, ref, set_key, checkpoint_id,
       checkpoint_number, commit_oid, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    repo.id,
    repo.sourceId,
    ref,
    key,
    key,
    view.checkpoint.number,
    repo.tip,
    // Pages are only written while their set is writing; then it finishes.
    set.pages?.length ? "writing" : set.status,
    set.error ?? null,
  );
  for (const [position, page] of (set.pages ?? []).entries())
    await server.sql(
      `INSERT INTO kg_page_set_pages (repo_id, source_id, ref, set_key, slug, title, section,
         position, kind, change, outcome, body, inputs_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'Components', ?, 'component', ?, ?, ?, 'hash')`,
      repo.id,
      repo.sourceId,
      ref,
      key,
      page.slug,
      page.title,
      position,
      page.change,
      page.outcome,
      page.body ?? "",
    );
  if (set.pages?.length && set.status !== "writing")
    await server.sql(
      `UPDATE kg_page_sets SET status = ? WHERE repo_id = ? AND source_id = ? AND ref = ?
         AND set_key = ?`,
      set.status,
      repo.id,
      repo.sourceId,
      ref,
      key,
    );
}

/** The timeline's newest landing, as the tracker has it. */
export async function landing(server: TestServer, timeline: WorldTimeline) {
  return (
    await server.call<{ landing: Landing | null }>(
      "GET",
      `/api/tracker/orbit/timelines/${timeline.slug}/landing`,
    )
  ).landing;
}

/**
 * A landing's merge run ended: `conflict` as the merge job reports one (exit
 * 42), else plainly failed or succeeded. Then look again, as the end of a CI
 * run does: asking to land a landing under way moves it on and returns it.
 */
export async function mergeRunEnded(
  server: TestServer,
  timeline: WorldTimeline,
  outcome: "conflict" | "failed",
) {
  const before = await landing(server, timeline);
  for (const repo of before?.repos ?? []) {
    if (!repo.mergeRun) continue;
    await server.sql(`UPDATE ci_runs SET status = 'failed' WHERE id = ?`, repo.mergeRun.id);
    await server.sql(`DELETE FROM ci_jobs WHERE run_id = ?`, repo.mergeRun.id);
    await server.sql(
      `INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, exit_code)
       VALUES (?, ?, ?, 'land', '{}', 'failed', 'local', ?)`,
      crypto.randomUUID(),
      repo.mergeRun.id,
      repo.id,
      outcome === "conflict" ? 42 : 1,
    );
  }
  await server.call("POST", `/api/tracker/orbit/timelines/${timeline.slug}/land`, {});
  return landing(server, timeline);
}
