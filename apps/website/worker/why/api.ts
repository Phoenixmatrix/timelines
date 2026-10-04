// GET /api/repos/:owner/:name/why: "why did this change?" (CORE-85).
//
//   ?path=src/app.ts&line=12[-20][&rev=main]
//       The Worker blames the lines (why/blame.ts) and resolves each commit's chain.
//   ?commit=<oid>[:<change id>] (repeatable)[&path=&line=&rev=]
//       The caller blamed already: gm does, in the checkout, where it reads
//       change ids from the commits themselves and sees unpushed work. Only
//       the chains are resolved; path and line just echo back.
//
// The web app has no checkout, so the server must be able to blame; gm
// blames locally because its revision may not be on the server (the working
// copy, a local rebase) and because the change id it reads is what makes the
// chain survive rewrites. Both meet at the same resolver (why/chain.ts).

import { Hono, type Context } from "hono";
import type { ChangeRef } from "../../shared/api.ts";
import type { TimelineEvent, TimelineIssue } from "../../shared/timelines.ts";
import type { CodeSource } from "../../shared/code-source.ts";
import {
  WHY_MAX_COMMITS,
  WHY_MAX_LINES,
  mentionedIds,
  type WhyBlame,
  type WhyChain,
  type WhyResponse,
} from "../../shared/why.ts";
import { fail } from "../api/http.ts";
import { loadSourceRepo } from "../api/repos.ts";
import { upstreamToken } from "../artifacts.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor, RepoRow } from "../db.ts";
import { DELIM, FLUSH, pkt } from "../git/pktline.ts";
import { commitSummary } from "../history/read.ts";
import { isCommitId, RepoReader } from "../objects.ts";
import { selectUpdates, toUpdate } from "../ref-log/api.ts";
import { readNewCommits } from "../ref-log/record.ts";
import { sourceLineage } from "../ref-log/lineage.ts";
import { linkedIssues } from "../release-notes/api.ts";
import { db } from "../schema.ts";
import { accessible } from "../tracker/api.ts";
import type { TrackerReply } from "../tracker/object.ts";
import { trackerObject } from "../tracker/stub.ts";
import { BlameError, blameLines } from "./blame.ts";
import { resolveChain, shared, type WhySources, type WhyTracker } from "./chain.ts";

const CHANGE_ID = /^[0-9a-z]{4,64}$/;
/** Bytes of a one-commit fetch read for its header: the commit comes first. */
const HEADER_PACK_BYTES = 4 * 1024 * 1024;
/** Pages of a timeline's events read (500 each). */
const EVENT_PAGES = 4;

export const why = new Hono<AppEnv>();

/** `12` or `12-20` (either order), 1-based. */
export function parseLines(raw: string | undefined): { start: number; end: number } | null {
  const match = /^(\d{1,7})(?:-(\d{1,7}))?$/.exec(raw?.trim() ?? "");
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2] ?? match[1]);
  if (a < 1 || b < 1) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** `oid` or `oid:changeId`. */
export function parseCommit(raw: string): { oid: string; changeId: string | null } | null {
  const [oid = "", change, ...rest] = raw.trim().toLowerCase().split(":");
  if (rest.length || !isCommitId(oid)) return null;
  if (change !== undefined && !CHANGE_ID.test(change)) return null;
  return { oid, changeId: change ?? null };
}

function cleanPath(raw: string | undefined): string | null {
  const segments = (raw ?? "").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function unwrap<T>(reply: TrackerReply<T>, fallback: T): T {
  return reply.ok ? reply.value : fallback;
}

/** The owner's tracker, when the actor may read it. */
async function ownerTracker(
  env: Env,
  actor: Actor | null,
  row: RepoRow,
): Promise<WhyTracker | null> {
  if (!actor) return null;
  const owners = await accessible(env.DB, actor);
  if (!owners.some((owner) => owner.id === row.owner_id)) return null;
  const stub = trackerObject(env, row.owner_id);
  return {
    owner: row.owner_slug,
    timelines: async () => unwrap(await stub.listTimelines(), []),
    timeline: async (slug) => {
      const events: TimelineEvent[] = [];
      let issues: TimelineIssue[] = [];
      let after = 0;
      for (let page = 0; page < EVENT_PAGES; page++) {
        const reply = await stub.timeline(slug, after, 500);
        if (!reply.ok) return page ? { events, issues } : null;
        events.push(...reply.value.events);
        issues = reply.value.issues ?? [];
        if (reply.value.next === null) break;
        after = reply.value.next;
      }
      return { events, issues };
    },
    checkpoints: async (slug) => unwrap(await stub.checkpoints(slug), []),
    landing: async (commit) => {
      const landing = unwrap(await stub.landingForCommit(row.id, commit), null);
      if (!landing) return null;
      const checkpoint = await stub.checkpoint(landing.slug, landing.checkpointId);
      return checkpoint.ok ? { landing, checkpoint: checkpoint.value } : null;
    },
  };
}

/** A commit's `change-id` header: a one-commit protocol v2 fetch, without blobs. */
async function headerChangeId(env: Env, row: RepoRow, oid: string): Promise<string | null> {
  const token = await upstreamToken(env, row.artifacts_name, "read");
  const response = await fetch(`${row.artifacts_remote}/git-upload-pack`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      "git-protocol": "version=2",
    },
    body:
      pkt("command=fetch\n") +
      pkt("agent=gitmatrix\n") +
      pkt("object-format=sha1\n") +
      DELIM +
      pkt("no-progress\n") +
      pkt("ofs-delta\n") +
      pkt("filter blob:none\n") +
      pkt("deepen 1\n") +
      pkt(`want ${oid}\n`) +
      pkt("done\n") +
      FLUSH,
  });
  if (!response.ok || !response.body) return null;
  const { commits } = await readNewCommits(response.body, HEADER_PACK_BYTES);
  return commits.find((commit) => commit.oid === oid)?.changeId ?? null;
}

/** The Worker's sources: D1's push log, the repository, and the owner's tracker. */
export async function workerSources(
  c: Context<AppEnv>,
  row: RepoRow & { source_id?: string },
  objects: RepoReader,
  source?: CodeSource,
  expired = false,
): Promise<WhySources> {
  const kdb = db(c.env.DB);
  const actor = c.get("actor");
  return shared({
    source,
    repoId: row.id,
    defaultBranch: row.default_branch,
    commit: async (oid) => {
      if (expired) return null;
      const commit = await objects.commit(oid).catch(() => null);
      return commit && commitSummary(commit);
    },
    changeFromPushLog: async (oid) => {
      const found = await kdb
        .selectFrom("change_refs")
        .select("change_id")
        .where("repo_id", "=", row.id)
        .where("source_id", "=", row.source_id ?? "canonical")
        .where((eb) => eb.or([eb("first_commit_oid", "=", oid), eb("last_commit_oid", "=", oid)]))
        .limit(1)
        .executeTakeFirst();
      return found?.change_id ?? null;
    },
    changeFromHeader: (oid) =>
      headerChangeId(c.env, row, oid).catch((error) => {
        console.warn("why: couldn't read the change-id header", { repo: row.id, oid, error });
        return null;
      }),
    changeRefs: async (changeId): Promise<ChangeRef[]> => {
      const rows = await selectUpdates(kdb)
        .innerJoin("change_refs as m", "m.first_update_id", "u.id")
        .select([
          "m.change_id",
          "m.ref as reached_ref",
          "m.first_commit_oid",
          "m.first_seen_at",
          "m.last_commit_oid",
          "m.last_seen_at",
        ])
        .where("m.repo_id", "=", row.id)
        .where("m.source_id", "=", row.source_id ?? "canonical")
        .where("m.change_id", "=", changeId)
        .orderBy("m.first_seen_at")
        .orderBy("u.id")
        .execute();
      return rows.map((r) => ({
        changeId: r.change_id,
        ref: r.reached_ref,
        firstCommit: r.first_commit_oid,
        firstSeenAt: r.first_seen_at,
        firstUpdate: toUpdate(r),
        lastCommit: r.last_commit_oid,
        lastSeenAt: r.last_seen_at,
      }));
    },
    tracker: await ownerTracker(c.env, actor, row),
    issues: (keys) => linkedIssues(c.env, actor, row, keys),
  });
}

/** Display names for person and agent ids. */
async function names(d1: D1Database, ids: string[]): Promise<WhyResponse["people"]> {
  const people: WhyResponse["people"] = {};
  if (!ids.length) return people;
  const kdb = db(d1);
  for (let start = 0; start < ids.length; start += 90) {
    const slice = ids.slice(start, start + 90);
    const [accounts, agents] = await Promise.all([
      kdb
        .selectFrom("accounts")
        .select(["id", "display_name", "slug"])
        .where("id", "in", slice)
        .execute(),
      kdb.selectFrom("agents").select(["id", "name"]).where("id", "in", slice).execute(),
    ]);
    for (const a of accounts) people[a.id] = { name: a.display_name || a.slug, kind: "person" };
    for (const a of agents) people[a.id] = { name: a.name, kind: "agent" };
  }
  return people;
}

/** Group blamed lines by commit, in the order of the first line each explains. */
export function byCommit(lines: { line: number; commit: string }[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const { line, commit } of lines) groups.set(commit, [...(groups.get(commit) ?? []), line]);
  return groups;
}

why.get("/why", async (c) => {
  const loaded = await loadSourceRepo(c, "read", true);
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const path = cleanPath(c.req.query("path"));
  if (path === null) return fail(c, 400, "Invalid path.");
  const named = c.req.queries("commit") ?? [];
  const lines = parseLines(c.req.query("line"));
  if (!named.length) {
    if (loaded.expired)
      return c.json(
        {
          error: "This code source has expired; retained provenance is available by commit.",
          code: "source_expired",
        },
        410,
      );
    if (!path) return fail(c, 400, "Name a file with path, or commits with commit.");
    if (!lines) return fail(c, 400, "Name a line (line=12) or a range (line=12-20).");
    if (lines.end - lines.start + 1 > WHY_MAX_LINES)
      return fail(c, 400, `Ask about at most ${WHY_MAX_LINES} lines at once.`);
  }
  if (named.length > WHY_MAX_COMMITS)
    return fail(c, 400, `Ask about at most ${WHY_MAX_COMMITS} commits at once.`);
  const commits = named.map(parseCommit);
  if (commits.some((commit) => !commit))
    return fail(c, 400, "commit is a commit id, optionally with :<change id>.");

  const objects = new RepoReader(
    c.env,
    row.artifacts_name,
    row.artifacts_remote,
    c.get("timing"),
    (work) => c.executionCtx.waitUntil(work),
    loaded.source.kind === "timeline-work" ? loaded.source.ref : undefined,
  );
  try {
    const sources = await workerSources(c, row, objects, loaded.source, loaded.expired);
    let blame: WhyBlame | null = null;
    let wanted: { oid: string; changeId: string | null; lines: number[] }[];
    if (commits.length) {
      wanted = commits.map((commit) => ({ ...commit!, lines: [] }));
    } else {
      const rev = c.req.query("rev") || (await objects.refs()).headBranch || row.default_branch;
      const head = await objects.resolve(rev);
      if (!head) return fail(c, 404, `No branch, tag or commit named ${rev}.`);
      const result = await blameLines(objects, head, path, lines!.start, lines!.end);
      blame = {
        source: "server",
        path,
        rev,
        head,
        start: lines!.start,
        end: Math.max(...result.lines.map((l) => l.line)),
        lines: result.lines,
        truncated: result.truncated,
      };
      wanted = [...byCommit(result.lines)].map(([oid, lines]) => ({ oid, changeId: null, lines }));
    }
    const chains: WhyChain[] = [];
    for (const request of wanted) {
      const chain = await resolveChain(sources, request);
      let origin =
        loaded.source.kind === "timeline-work"
          ? { sourceId: loaded.source.sourceId, commit: request.oid }
          : null;
      if (!origin) {
        const receipts = await db(c.env.DB)
          .selectFrom("source_integration_receipts")
          .select(["source_id", "source_commit"])
          .where("repo_id", "=", row.id)
          .where("canonical_commit", "=", request.oid)
          .where("status", "=", "complete")
          .where("noop", "=", 0)
          .execute();
        if (receipts.length === 1)
          origin = { sourceId: receipts[0]!.source_id, commit: receipts[0]!.source_commit };
        if (receipts.length) chain.landing = null;
      }
      if (origin) {
        const lineage = await sourceLineage(
          c.env,
          loaded.canonical,
          origin.sourceId,
          origin.commit,
        );
        if (lineage) chain.lineage = lineage;
        if (lineage?.integration && sources.tracker) {
          const queued = await sources.tracker.landing(lineage.integration.canonical.commit);
          const pinned = queued?.checkpoint.checkpoint.repos.find(
            (repo) => repo.id === row.id && repo.source?.sourceId === lineage.source.sourceId,
          );
          const landingRepo = queued?.landing.repos.find((repo) => repo.id === row.id);
          if (
            queued &&
            pinned &&
            landingRepo &&
            queued.landing.state === "landed" &&
            pinned.commit === lineage.integration.source.commit &&
            landingRepo.merge === lineage.integration.canonical.commit
          ) {
            const checkpoint = queued.checkpoint;
            const approval = checkpoint.approval && {
              requestId: checkpoint.approval.requestId,
              state: checkpoint.approval.state,
              by: checkpoint.approval.by,
              at: checkpoint.approval.at,
              note: checkpoint.approval.note,
            };
            if (!chain.checkpoints.some((item) => item.id === checkpoint.checkpoint.id))
              chain.checkpoints.push({
                id: checkpoint.checkpoint.id,
                timeline: queued.landing.slug,
                number: checkpoint.checkpoint.number,
                commit: lineage.integration.source.commit,
                summary: checkpoint.checkpoint.summary,
                createdAt: checkpoint.checkpoint.createdAt,
                actorId: checkpoint.checkpoint.actorId,
                current: checkpoint.current,
                approval,
              });
            if (approval)
              chain.approval = {
                ...approval,
                checkpointId: checkpoint.checkpoint.id,
                timeline: queued.landing.slug,
                number: checkpoint.checkpoint.number,
              };
            chain.landing = {
              ref: lineage.integration.canonical.ref,
              commit: lineage.integration.canonical.commit,
              at: queued.landing.updatedAt,
              update: null,
              via: "compact",
              timeline: queued.landing.slug,
              queue: {
                id: queued.landing.id,
                checkpointId: queued.landing.checkpointId,
                checkpointNumber: queued.landing.checkpointNumber,
                trigger: queued.landing.trigger,
                requestedBy: queued.landing.requestedBy,
                mergeRun: landingRepo.mergeRun,
                gateRun: landingRepo.gateRun,
              },
            };
          }
        }
      }
      chains.push(chain);
    }
    return c.json<WhyResponse>({
      source: loaded.source,
      repo: { owner: row.owner_slug, name: row.name, defaultBranch: row.default_branch },
      tracker: { owner: row.owner_slug, readable: sources.tracker !== null },
      blame,
      chains,
      people: await names(c.env.DB, [...new Set(chains.flatMap(mentionedIds))]),
    });
  } catch (error) {
    if (error instanceof BlameError) return fail(c, error.status, error.message);
    throw error;
  } finally {
    await objects.close();
  }
});
