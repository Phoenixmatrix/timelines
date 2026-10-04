// Timelines, under a tracker account (/api/tracker/:owner/timelines):
//   GET    /                  every timeline, newest first (?status= to filter;
//                             ?stalled=true for open ones without a push for the
//                             account's idle period, experimental ones left out)
//   POST   /                  fork one from main or another timeline: a bookmark
//                             `timeline/<slug>` in each repository, then the record
//   GET    /:slug             the timeline and its events (?after=&limit= to page)
//   PATCH  /:slug             rename it, or set or clear its experimental flag
//   POST   /:slug/abandon     end it and delete its bookmarks (events stay)
//   GET    /:slug/checkpoints       its checkpoints, newest first, each with its
//                                   CI runs, previews and approval (CORE-76)
//   POST   /:slug/checkpoints       {summary?}: record its bookmarks' commits now,
//                                   and queue the timeline's wiki pages for it (CORE-84)
//   GET    /:slug/checkpoints/:ref  one checkpoint, by id or number
//   POST   /:slug/checkpoints/:ref/revive  rebuild its preview (CORE-79): a
//                                   preview `create` run per repository
//
// A new checkpoint starts a preview `create` run in each of its repositories
// whose ci.yml opts in with `on: preview` (worker/deployments/previews.ts).
//   POST   /:slug/land        queue a landing of its head checkpoint (CORE-77),
//                             or say why it can't land yet
//   GET    /:slug/landing     its newest landing, if any
//
// Any tracker member (person or agent) with write access to the repositories
// may fork; abandoning is checked by the tracker (timelines.ts). Bookmarks are
// written before the record and removed again if it can't be made, so a
// timeline never names a bookmark that wasn't created.

import { Hono, type Context } from "hono";
import type { AppEnv } from "../auth.ts";
import { lsRefs } from "../artifacts.ts";
import { findRepo, roleFor, type RepoRow } from "../db.ts";
import { atLeast } from "../permissions.ts";
import { db } from "../schema.ts";
import {
  TIMELINE_POLICIES,
  isStalled,
  timelineBookmark,
  type BookmarkResult,
  type Timeline,
  type TimelineChange,
  type TimelineDetail,
  type TimelineList,
  type TimelinePolicy,
  type CheckpointList,
  type CheckpointView,
  type PreviewRevival,
  type Landing,
  type LandResult,
} from "../../shared/timelines.ts";
import { previewCheckpoint, reviveCheckpoint } from "../deployments/previews.ts";
import { previewSettings } from "../deployments/settings.ts";
import { authorize } from "../tracker/api.ts";
import type { TrackerReply } from "../tracker/object.ts";
import { TrackerError, fail, text } from "../tracker/store.ts";
import { trackerObject } from "../tracker/stub.ts";
import { timelineSlug, timelineStatus } from "../tracker/timelines.ts";
import { logPush } from "./activity.ts";
import { measure, mayWriteAll, view, writableRepoIds } from "./checkpoints.ts";
import { overlayNow, requestCheckpointPages } from "../knowledge/coordinator.ts";
import { releaseQuiet } from "../ci/trigger.ts";
import { maybeLand, requestLanding, settled, workerDeps } from "./landing.ts";
import { writeRefs, type RefWrite } from "./bookmarks.ts";

/** Repositories one timeline may touch. */
const MAX_REPOS = 20;
const OID = /^[0-9a-f]{40}$/;

type BookmarkRepo = Pick<
  RepoRow,
  | "id"
  | "owner_id"
  | "owner_slug"
  | "name"
  | "default_branch"
  | "artifacts_name"
  | "artifacts_remote"
>;

export const timelines = new Hono<AppEnv>();

timelines.onError((error, c) => {
  if (error instanceof TrackerError)
    return c.json({ error: error.message, code: error.code }, error.status);
  throw error;
});

function unwrap<T>(reply: TrackerReply<T>): T {
  if (!reply.ok) throw new TrackerError(reply.status, reply.code, reply.error);
  return reply.value;
}

async function input(c: Context<AppEnv>, allowed: string[]): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    fail("invalid_input", "Body must be JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input", "Expected an object.");
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail("invalid_input", `Unknown field: ${key}.`);
  return value as Record<string, unknown>;
}

/** Write one ref per repository; whatever went wrong comes back as a failed result. */
async function writeEach(
  env: Env,
  writes: { repo: BookmarkRepo; write: RefWrite }[],
): Promise<BookmarkResult[]> {
  return Promise.all(
    writes.map(async ({ repo, write }) => {
      try {
        const [result] = await writeRefs(env, repo, [write]);
        return { repoId: repo.id, ...result! };
      } catch (error) {
        console.error("Timelines: writing a bookmark failed", { repo: repo.id, error });
        return {
          repoId: repo.id,
          ref: write.ref,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

timelines.get("/", async (c) => {
  const access = await authorize(c, false);
  const status = c.req.query("status");
  const stalled = c.req.query("stalled");
  if (stalled !== undefined && stalled !== "true" && stalled !== "false")
    fail("invalid_input", "stalled must be true or false.");
  const list = unwrap(
    await trackerObject(c.env, access.owner.id).listTimelines(
      status === undefined ? undefined : timelineStatus(status),
    ),
  );
  if (stalled !== "true") return c.json<TimelineList>({ timelines: list });
  // Stalling is expected of experimental timelines: isStalled leaves them out.
  const { idleDays } = await previewSettings(c.env.DB, access.owner.id);
  const now = Date.now();
  return c.json<TimelineList>({
    timelines: list.filter((timeline) => isStalled(timeline, now, idleDays)),
    idleDays,
  });
});

timelines.post("/", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  const data = await input(c, ["slug", "name", "policy", "experimental", "parent", "repos"]);
  const slug = timelineSlug(data.slug);
  // Checked again with the record; checked here so a bad field writes no bookmark.
  const name = data.name === undefined ? undefined : text(data.name, "name");
  if (data.policy !== undefined && !TIMELINE_POLICIES.includes(data.policy as TimelinePolicy))
    fail("invalid_input", "policy must be auto or approval.");
  if (data.experimental !== undefined && typeof data.experimental !== "boolean")
    fail("invalid_input", "experimental must be true or false.");
  const parentSlug =
    data.parent === undefined || data.parent === "main" ? null : timelineSlug(data.parent);
  const tracker = trackerObject(c.env, access.owner.id);
  const parent = unwrap(await tracker.prepareTimeline(slug, parentSlug));

  // The repositories, by default the parent's: each the account's own, and writable.
  const requested =
    data.repos === undefined
      ? (parent?.repos.map((repo) => ({ repo: `${repo.owner}/${repo.name}` })) ?? [])
      : Array.isArray(data.repos)
        ? data.repos.map((entry) => (typeof entry === "string" ? { repo: entry } : entry))
        : fail("invalid_input", "repos must be a list of owner/name.");
  if (!requested.length)
    fail("invalid_input", "Name the repositories the timeline touches (repos: [owner/name]).");
  if (requested.length > MAX_REPOS)
    fail("invalid_input", `A timeline touches at most ${MAX_REPOS} repositories.`);
  const repos = new Map<string, { row: BookmarkRepo; commit: string | null }>();
  for (const entry of requested) {
    if (!entry || typeof entry !== "object") fail("invalid_input", "repos must be owner/name.");
    const { repo: fullName, commit, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length) fail("invalid_input", "A repository is { repo, commit }.");
    const [owner, name, extra] = text(fullName, "repo").split("/");
    if (!owner || !name || extra !== undefined)
      fail("invalid_input", "A repository is owner/name.");
    const row = await findRepo(c.env.DB, actor, owner, name);
    const role = row ? roleFor(row, actor) : "none";
    if (!row || !atLeast(role, "read")) fail("not_found", `No repository ${owner}/${name}.`, 404);
    if (!atLeast(role, "write"))
      fail("forbidden", `Forking a timeline needs write access to ${owner}/${name}.`, 403);
    if (row.owner_id !== access.owner.id)
      fail(
        "invalid_input",
        `${owner}/${name} belongs to another account; a timeline touches its own account's repositories.`,
      );
    const at = commit === undefined ? null : text(commit, "commit", 40);
    if (at !== null && !OID.test(at))
      fail("invalid_input", "A fork commit is a full 40-character commit id.");
    repos.set(row.id, { row, commit: at });
  }

  // Where each fork starts: the given commit, the parent's bookmark, or the default branch.
  const bookmark = `refs/heads/${timelineBookmark(slug)}`;
  const commits: Record<string, string> = {};
  for (const { row, commit } of repos.values()) {
    const refs = await lsRefs(c.env, row.artifacts_name, row.artifacts_remote);
    if (refs.some((ref) => ref.name === bookmark))
      fail("already_exists", `${row.owner_slug}/${row.name} already has ${bookmark}.`, 409);
    if (commit) {
      using artifacts = await c.env.ARTIFACTS.get(row.artifacts_name);
      if (!(await artifacts.readCommit(commit)))
        fail("not_found", `${row.owner_slug}/${row.name} has no commit ${commit}.`, 404);
      commits[row.id] = commit;
      continue;
    }
    const inParent = parent?.repos.find((repo) => repo.id === row.id);
    const from = `refs/heads/${inParent ? inParent.bookmark : row.default_branch}`;
    const tip = refs.find((ref) => ref.name === from)?.oid;
    if (!tip) fail("no_commits", `${row.owner_slug}/${row.name} has no ${from} to fork from.`, 409);
    commits[row.id] = tip;
  }

  const rows = [...repos.values()].map(({ row }) => row);
  const created = await writeEach(
    c.env,
    rows.map((row) => ({ repo: row, write: { ref: bookmark, old: null, new: commits[row.id]! } })),
  );
  const undo = () =>
    writeEach(
      c.env,
      rows
        .filter((row) => created.find((r) => r.repoId === row.id)?.ok)
        .map((row) => ({ repo: row, write: { ref: bookmark, old: commits[row.id]!, new: null } })),
    );
  if (created.some((result) => !result.ok)) {
    await undo();
    const failed = created.filter((result) => !result.ok);
    return c.json(
      {
        error: `Couldn't create ${bookmark}: ${failed.map((r) => r.reason).join("; ")}`,
        code: "bookmark_failed",
        bookmarks: created,
      },
      409,
    );
  }
  const recorded = await tracker.createTimeline(access, {
    slug,
    name,
    policy: data.policy,
    experimental: data.experimental,
    parent: parentSlug,
    repos: rows.map((row) => ({ id: row.id, owner: row.owner_slug, name: row.name })),
    commits,
  });
  if (!recorded.ok) await undo();
  const timeline = unwrap(recorded);
  // The push log records the new bookmarks as the forker's.
  for (const row of rows) c.executionCtx.waitUntil(logPush(c.env, row, actor));
  return c.json<TimelineChange>({ timeline, bookmarks: created }, 201);
});

timelines.get("/:slug", async (c) => {
  const access = await authorize(c, false);
  const after = c.req.query("after") ?? "0";
  const limit = c.req.query("limit") ?? "200";
  if (!/^\d+$/.test(after) || !/^\d+$/.test(limit))
    fail("invalid_input", "after and limit must be integers.");
  return c.json<TimelineDetail>(
    unwrap(
      await trackerObject(c.env, access.owner.id).timeline(
        c.req.param("slug"),
        Number(after),
        Number(limit),
      ),
    ),
  );
});

timelines.patch("/:slug", async (c) => {
  const access = await authorize(c, false);
  const { expectedVersion, ...data } = await input(c, ["name", "experimental", "expectedVersion"]);
  return c.json<Timeline>(
    unwrap(
      await trackerObject(c.env, access.owner.id).updateTimeline(
        c.req.param("slug"),
        data,
        expectedVersion,
        access,
      ),
    ),
  );
});

timelines.post("/:slug/abandon", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  const tracker = trackerObject(c.env, access.owner.id);
  const timeline = unwrap(await tracker.mayAbandonTimeline(access, c.req.param("slug")));
  const ids = timeline.repos.map((repo) => repo.id);
  const rows = await db(c.env.DB)
    .selectFrom("repos as r")
    .innerJoin("accounts as o", "o.id", "r.owner_id")
    .select([
      "r.id",
      "r.owner_id",
      "o.slug as owner_slug",
      "r.name",
      "r.default_branch",
      "r.artifacts_name",
      "r.artifacts_remote",
    ])
    .where("r.id", "in", ids)
    .where("r.deleted_at", "is", null)
    .execute();
  // Each bookmark's last commit goes into the abandon event before it's deleted.
  const tips = new Map<string, { row: BookmarkRepo; ref: string; tip: string | null }>();
  for (const repo of timeline.repos) {
    const row = rows.find((r) => r.id === repo.id);
    if (!row) continue;
    const ref = `refs/heads/${repo.bookmark}`;
    const refs = await lsRefs(c.env, row.artifacts_name, row.artifacts_remote);
    tips.set(repo.id, { row, ref, tip: refs.find((r) => r.name === ref)?.oid ?? null });
  }
  const lastCommits = Object.fromEntries(ids.map((id) => [id, tips.get(id)?.tip ?? null]));
  const result = unwrap(await tracker.abandonTimeline(access, timeline.slug, lastCommits));
  const live = [...tips.values()].filter((t) => t.tip);
  const bookmarks = await writeEach(
    c.env,
    live.map(({ row, ref, tip }) => ({ repo: row, write: { ref, old: tip, new: null } })),
  );
  for (const { row } of live) c.executionCtx.waitUntil(logPush(c.env, row, actor));
  return c.json<TimelineChange>({ timeline: result.timeline, bookmarks });
});

timelines.get("/:slug/checkpoints", async (c) => {
  const access = await authorize(c, false);
  const tracker = trackerObject(c.env, access.owner.id);
  const slug = c.req.param("slug");
  const [states, detail] = await Promise.all([
    tracker.checkpoints(slug),
    tracker.timeline(slug, 0, 1),
  ]);
  const timeline = unwrap(detail).timeline;
  return c.json<CheckpointList>({
    checkpoints: await Promise.all(unwrap(states).map((state) => view(c.env, state, timeline))),
  });
});

timelines.get("/:slug/checkpoints/:ref", async (c) => {
  const access = await authorize(c, false);
  const tracker = trackerObject(c.env, access.owner.id);
  const slug = c.req.param("slug");
  const ref = c.req.param("ref");
  if (ref.length > 100) fail("invalid_input", "A checkpoint is its id or number.");
  const [state, detail] = await Promise.all([
    tracker.checkpoint(slug, ref),
    tracker.timeline(slug, 0, 1),
  ]);
  return c.json<CheckpointView>(await view(c.env, unwrap(state), unwrap(detail).timeline));
});

timelines.post("/:slug/checkpoints", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  const data = await input(c, ["summary"]);
  const tracker = trackerObject(c.env, access.owner.id);
  const timeline = unwrap(await tracker.timeline(c.req.param("slug"), 0, 1)).timeline;
  if (timeline.status === "landed" || timeline.status === "abandoned")
    fail("timeline_ended", `${timeline.slug} is ${timeline.status}.`, 409);
  const repos = await measure(c.env, actor, timeline);
  const state = unwrap(
    await tracker.createCheckpoint(access, timeline.slug, { summary: data.summary, repos }),
  );
  // The preview contract: each repository that opts in builds this checkpoint.
  const waitUntil = (work: Promise<unknown>) => c.executionCtx.waitUntil(work);
  waitUntil(previewCheckpoint(c.env, state.checkpoint, timeline, actor, waitUntil));
  // The timeline's wiki pages (CORE-84), queued after the answer too.
  waitUntil(requestCheckpointPages(c.env, state.checkpoint, timeline.slug, actor.id));
  // Its full CI and knowledge overlays now, not after the quiet period (CORE-238).
  for (const repo of state.checkpoint.repos) {
    const bookmark = timelineBookmark(timeline.slug);
    waitUntil(
      releaseQuiet(c.env, repo.id, bookmark, repo.commit).catch((error) =>
        console.error("CI: releasing the checkpoint's run failed", error),
      ),
    );
    waitUntil(
      overlayNow(c.env, repo.id, [`refs/heads/${bookmark}`]).catch((error) =>
        console.error("Knowledge: the checkpoint's overlay failed to start", error),
      ),
    );
  }
  // Green already? An auto timeline lands it (CORE-77).
  if (timeline.policy === "auto")
    waitUntil(
      settled(c.env, (deps) => maybeLand(c.env, deps, access.owner.id, timeline.slug, "auto")),
    );
  return c.json<CheckpointView>(await view(c.env, state, timeline), 201);
});

timelines.post("/:slug/checkpoints/:ref/revive", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  const tracker = trackerObject(c.env, access.owner.id);
  const slug = c.req.param("slug");
  const ref = c.req.param("ref");
  if (ref.length > 100) fail("invalid_input", "A checkpoint is its id or number.");
  const [found, detail] = await Promise.all([
    tracker.checkpoint(slug, ref),
    tracker.timeline(slug, 0, 1),
  ]);
  const state = unwrap(found);
  const timeline = unwrap(detail).timeline;
  // Starting runs needs write access to every repository, as checkpoints do.
  await mayWriteAll(c.env, actor, state.checkpoint);
  const runs = await reviveCheckpoint(c.env, state.checkpoint, timeline, actor, (work) =>
    c.executionCtx.waitUntil(work),
  );
  return c.json<PreviewRevival>(
    { checkpoint: await view(c.env, state, timeline), runs },
    runs.some((run) => "number" in run) ? 201 : 200,
  );
});

timelines.post("/:slug/land", async (c) => {
  const access = await authorize(c, true);
  const actor = c.get("actor")!;
  const tracker = trackerObject(c.env, access.owner.id);
  const timeline = unwrap(await tracker.timeline(c.req.param("slug"), 0, 1)).timeline;
  // Landing moves main: it needs write access to every repository it lands in.
  const writable = await writableRepoIds(c.env.DB, actor, access.owner.id);
  for (const repo of timeline.repos)
    if (!writable.includes(repo.id))
      fail("forbidden", `Landing needs write access to ${repo.owner}/${repo.name}.`, 403);
  const result = await requestLanding(
    c.env,
    workerDeps(c.env, (work) => c.executionCtx.waitUntil(work)),
    access,
    timeline.slug,
    "request",
  );
  return c.json<LandResult>(result, result.queued ? 202 : 200);
});

timelines.get("/:slug/landing", async (c) => {
  const access = await authorize(c, false);
  const landing = unwrap(await trackerObject(c.env, access.owner.id).landing(c.req.param("slug")));
  return c.json<{ landing: Landing | null }>({ landing });
});
