// Timelines, under a tracker Space (/api/tracker/:space/timelines):
//   GET    /                  every timeline, newest first (?status= to filter;
//                             ?stalled=true for open ones without a push for the
//                             Space's idle period, experimental ones left out)
//   POST   /                  fork an owned work source per repository, pinned
//                             to main or another timeline's exact snapshot
//   GET    /:slug             the timeline and its events (?after=&limit= to page)
//   GET    /:slug/presence    recently interacting agents (does not renew presence)
//   PATCH  /:slug             rename it, or set or clear its experimental flag
//   POST   /:slug/abandon     archive work, or cancel/drain a reserved creation
//   GET    /:slug/checkpoints       its checkpoints, newest first, each with its
//                                   CI runs, previews and approval (CORE-76)
//   POST   /:slug/checkpoints       {summary?}: pin exact sources and logical bases,
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
// may fork; abandoning is checked by the tracker (timelines.ts). Creation
// reservations and provider ownership precede routing; only fully ready owned
// sources are published on the timeline.

import { Hono, type Context } from "hono";
import type { AppEnv } from "../auth.ts";
import { noteAgentPresence, readAgentPresence } from "../agent-presence.ts";
import type { AgentPresenceTarget } from "../../shared/agent-presence.ts";
import { lsRefs } from "../artifacts.ts";
import { findRepo, roleFor, selectRepos, type RepoRow } from "../db.ts";
import { atLeast } from "../permissions.ts";
import { db } from "../schema.ts";
import {
  TIMELINE_POLICIES,
  isStalled,
  timelineBookmark,
  type BookmarkResult,
  type Timeline,
  type TimelineChange,
  type TimelineCreationCancellation,
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
import { measure, mayWriteAll, view, writableRepoIds } from "./checkpoints.ts";
import { overlayNow, requestCheckpointPages } from "../knowledge/coordinator.ts";
import { releaseQuiet } from "../ci/trigger.ts";
import { maybeLand, requestLanding, settled, workerDeps } from "./landing.ts";
import {
  canonicalSource,
  ensureWorkSource,
  getWorkSource,
  resolveTimelineSource,
} from "./sources.ts";
import type { SourceSnapshot } from "../../shared/code-source.ts";
import type { TimelineRepo } from "../../shared/timelines.ts";
import { migrateLegacyTimeline } from "./migration.ts";
import { captureWorkAuthority, WorkAuthorizationError } from "../ci/admission.ts";
import { currentRepositoryNames } from "./names.ts";

/** Repositories one timeline may touch. */
const MAX_REPOS = 20;
const OID = /^[0-9a-f]{40}$/;

type BookmarkRepo = Pick<
  RepoRow,
  | "id"
  | "space_id"
  | "space_slug"
  | "name"
  | "default_branch"
  | "artifacts_name"
  | "artifacts_remote"
>;

export const timelines = new Hono<AppEnv>();

timelines.onError((error, c) => {
  if (error instanceof TrackerError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof WorkAuthorizationError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error.message === "migration_epoch_mismatch")
    return c.json(
      { error: "The Space migration epoch changed; refresh before retrying.", code: error.message },
      409,
    );
  if (error.message === "space_cutover_fenced")
    return c.json({ error: "Space work is fenced during cutover.", code: error.message }, 503);
  throw error;
});

function unwrap<T>(reply: TrackerReply<T>): T {
  if (!reply.ok) throw new TrackerError(reply.status, reply.code, reply.error);
  return reply.value;
}

function presenceTarget(scopeId: string, resourceId: string): AgentPresenceTarget {
  return { kind: "timeline", scopeId, resourceId, sourceId: "canonical" };
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

timelines.get("/", async (c) => {
  const access = await authorize(c, false);
  const status = c.req.query("status");
  const stalled = c.req.query("stalled");
  if (stalled !== undefined && stalled !== "true" && stalled !== "false")
    fail("invalid_input", "stalled must be true or false.");
  const list = unwrap(
    await trackerObject(c.env, access.space.id).listTimelines(
      access,
      status === undefined ? undefined : timelineStatus(status),
    ),
  );
  const current = await currentRepositoryNames(c.env.DB, access.space.id, list);
  if (stalled !== "true") return c.json<TimelineList>({ timelines: current });
  // Stalling is expected of experimental timelines: isStalled leaves them out.
  const { idleDays } = await previewSettings(c.env.DB, access.space.id);
  const now = Date.now();
  return c.json<TimelineList>({
    timelines: current.filter((timeline) => isStalled(timeline, now, idleDays)),
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
  const tracker = trackerObject(c.env, access.space.id);
  const parent = parentSlug
    ? unwrap(await tracker.timeline(access, parentSlug, 0, 1)).timeline
    : null;
  // Parent snapshots retain their original labels; resolve current URLs by the
  // stable IDs so a rename (or reuse of the old name) cannot change fork identity.
  const inherited =
    data.repos === undefined && parent?.repos.length
      ? await selectRepos(c.env.DB, actor.id)
          .where(
            "r.id",
            "in",
            parent.repos.map((repo) => repo.id),
          )
          .execute()
      : [];
  if (data.repos === undefined && parent && inherited.length !== parent.repos.length)
    fail("not_found", "A parent repository no longer exists.", 404);

  // The repositories, by default the parent's: each in this Space, and writable.
  const requested =
    data.repos === undefined
      ? inherited.map((repo) => ({ repo: `${repo.space_slug}/${repo.name}` }))
      : Array.isArray(data.repos)
        ? data.repos.map((entry) => (typeof entry === "string" ? { repo: entry } : entry))
        : fail("invalid_input", "repos must be a list of space/name.");
  if (!requested.length)
    fail("invalid_input", "Name the repositories the timeline touches (repos: [space/name]).");
  if (requested.length > MAX_REPOS)
    fail("invalid_input", `A timeline touches at most ${MAX_REPOS} repositories.`);
  const repos = new Map<string, { row: RepoRow; commit: string | null }>();
  for (const entry of requested) {
    if (!entry || typeof entry !== "object") fail("invalid_input", "repos must be space/name.");
    const { repo: fullName, commit, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length) fail("invalid_input", "A repository is { repo, commit }.");
    const [owner, name, extra] = text(fullName, "repo").split("/");
    if (!owner || !name || extra !== undefined)
      fail("invalid_input", "A repository is space/name.");
    const row =
      data.repos === undefined
        ? inherited.find((repo) => repo.space_slug === owner && repo.name === name)
        : await findRepo(c.env.DB, actor, owner, name);
    const role = row ? roleFor(row, actor) : "none";
    if (!row || !atLeast(role, "read")) fail("not_found", `No repository ${owner}/${name}.`, 404);
    if (!atLeast(role, "write"))
      fail("forbidden", `Forking a timeline needs write access to ${owner}/${name}.`, 403);
    if (row.space_id !== access.space.id)
      fail(
        "invalid_input",
        `${owner}/${name} belongs to another Space; a timeline touches only its own Space's repositories.`,
      );
    const at = commit === undefined ? null : text(commit, "commit", 40);
    if (at !== null && !OID.test(at))
      fail("invalid_input", "A fork commit is a full 40-character commit id.");
    repos.set(row.id, { row, commit: at });
  }

  const timelineId = unwrap(
    await tracker.reserveTimeline(access, slug, parentSlug, JSON.stringify(data)),
  );
  const commits: Record<string, string> = {};
  const entries: TimelineRepo[] = [];
  const created: BookmarkResult[] = [];
  for (const { row, commit } of repos.values()) {
    const inParent = parent?.repos.find((entry) => entry.id === row.id);
    const origin = inParent
      ? await resolveTimelineSource(c.env, row, inParent)
      : { repo: row, source: canonicalSource(row) };
    const refs = await lsRefs(c.env, origin.repo.artifacts_name, origin.repo.artifacts_remote);
    const tip = commit ?? refs.find((ref) => ref.name === origin.source.ref)?.oid;
    if (!tip) fail("no_commits", `${row.space_slug}/${row.name} has no commit to fork.`, 409);
    using artifacts = await c.env.ARTIFACTS.get(origin.repo.artifacts_name);
    const pinned = await artifacts.readCommit(tip);
    if (!pinned) fail("not_found", `No commit ${tip} in the requested source.`, 404);
    const base: SourceSnapshot = { ...origin.source, commit: tip, tree: pinned.treeHash };
    const authority = await captureWorkAuthority(c.env, row.id, actor);
    const owned = await ensureWorkSource(c.env, access, row, {
      timelineId,
      timelineSlug: slug,
      base,
      authority,
    });
    commits[row.id] = owned.logicalBase.commit;
    entries.push({
      id: row.id,
      space: row.space_slug,
      name: row.name,
      bookmark: "work",
      source: owned.source,
      logicalBase: owned.logicalBase,
      dependencies: inParent ? [...(inParent.dependencies ?? [])] : [],
    });
    created.push({ repoId: row.id, ref: owned.source.ref, ok: true });
  }
  const timeline = unwrap(
    await tracker.createTimeline(access, {
      id: timelineId,
      slug,
      name,
      policy: data.policy,
      experimental: data.experimental,
      parent: parentSlug,
      repos: entries,
      commits,
    }),
  );
  noteAgentPresence(c, presenceTarget(access.space.id, timeline.id));
  const [current] = await currentRepositoryNames(c.env.DB, access.space.id, [timeline]);
  return c.json<TimelineChange>({ timeline: current!, bookmarks: created }, 201);
});

timelines.get("/:slug", async (c) => {
  const access = await authorize(c, false);
  const after = c.req.query("after") ?? "0";
  const limit = c.req.query("limit") ?? "200";
  if (!/^\d+$/.test(after) || !/^\d+$/.test(limit))
    fail("invalid_input", "after and limit must be integers.");
  const detail = unwrap(
    await trackerObject(c.env, access.space.id).timeline(
      access,
      c.req.param("slug"),
      Number(after),
      Number(limit),
    ),
  );
  noteAgentPresence(c, presenceTarget(access.space.id, detail.timeline.id));
  const [current] = await currentRepositoryNames(c.env.DB, access.space.id, [detail.timeline]);
  return c.json<TimelineDetail>({ ...detail, timeline: current! });
});

timelines.get("/:slug/presence", async (c) => {
  const access = await authorize(c, false);
  const { timeline } = unwrap(
    await trackerObject(c.env, access.space.id).timeline(access, c.req.param("slug"), 0, 1),
  );
  return c.json(await readAgentPresence(c.env.DB, presenceTarget(access.space.id, timeline.id)));
});

timelines.patch("/:slug", async (c) => {
  const access = await authorize(c, false);
  const { expectedVersion, ...data } = await input(c, ["name", "experimental", "expectedVersion"]);
  const timeline = unwrap(
    await trackerObject(c.env, access.space.id).updateTimeline(
      access,
      c.req.param("slug"),
      data,
      expectedVersion,
    ),
  );
  noteAgentPresence(c, presenceTarget(access.space.id, timeline.id));
  const [current] = await currentRepositoryNames(c.env.DB, access.space.id, [timeline]);
  return c.json<Timeline>(current!);
});

timelines.post("/:slug/migrate", async (c) => {
  const access = await authorize(c, true);
  const detail = unwrap(
    await trackerObject(c.env, access.space.id).timeline(access, c.req.param("slug"), 0, 1),
  );
  const writable = await writableRepoIds(c.env.DB, c.get("actor")!, access.space.id);
  if (detail.timeline.repos.some((repo) => !writable.includes(repo.id)))
    fail("forbidden", "Migration needs write access to every repository.", 403);
  const result = await migrateLegacyTimeline(c.env, access, c.get("actor")!, detail.timeline.id);
  noteAgentPresence(c, presenceTarget(access.space.id, detail.timeline.id));
  const [current] = await currentRepositoryNames(c.env.DB, access.space.id, [result]);
  return c.json(current!);
});

timelines.post("/:slug/migration/resolve", async (c) => {
  const access = await authorize(c, true);
  const tracker = trackerObject(c.env, access.space.id);
  const detail = unwrap(await tracker.timeline(access, c.req.param("slug"), 0, 1));
  const writable = await writableRepoIds(c.env.DB, c.get("actor")!, access.space.id);
  if (detail.timeline.repos.some((repo) => !writable.includes(repo.id)))
    fail("forbidden", "Resolution needs write access to every repository.", 403);
  const data = await input(c, ["expectedVersion", "action", "note"]);
  if (
    !Number.isSafeInteger(data.expectedVersion) ||
    (data.action !== "cancel-unadvanced" && data.action !== "accept-partial-and-abandon")
  )
    fail("invalid_input", "Name the landing version and explicit resolution action.");
  const landing = unwrap(await tracker.landing(access, detail.timeline.slug));
  if (!landing) fail("not_found", "No legacy landing to resolve.", 404);
  const runs = landing.repos
    .flatMap((repo) => [repo.mergeRun?.id, repo.gateRun?.id])
    .filter((id): id is string => !!id);
  if (runs.length) {
    const live = await db(c.env.DB)
      .selectFrom("ci_runs")
      .select("id")
      .where("id", "in", runs)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    if (live)
      fail(
        "landing_unresolved",
        "Cancel or finish live landing CI before resolving migration.",
        409,
      );
  }
  const result = unwrap(
    await tracker.resolveLegacyLanding(
      access,
      detail.timeline.id,
      data.expectedVersion as number,
      data.action,
      text(data.note, "note"),
    ),
  );
  noteAgentPresence(c, presenceTarget(access.space.id, detail.timeline.id));
  const [current] = await currentRepositoryNames(c.env.DB, access.space.id, [result]);
  return c.json(current!);
});

timelines.post("/:slug/abandon", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  const tracker = trackerObject(c.env, access.space.id);
  const cancellation = unwrap(await tracker.cancelReservedCreation(access, c.req.param("slug")));
  if (cancellation) return c.json<TimelineCreationCancellation>({ ...cancellation, bookmarks: [] });
  const timeline = unwrap(await tracker.mayAbandonTimeline(access, c.req.param("slug")));
  const ids = timeline.repos.map((repo) => repo.id);
  const rows = await selectRepos(c.env.DB, actor.id).where("r.id", "in", ids).execute();
  // Each source's last commit goes into the event before its read-only archive.
  const tips = new Map<string, { row: BookmarkRepo; ref: string; tip: string | null }>();
  for (const repo of timeline.repos) {
    const row = rows.find((r) => r.id === repo.id);
    if (!row) continue;
    const physical = await resolveTimelineSource(c.env, row, repo);
    const ref = physical.source.ref;
    const refs = await lsRefs(c.env, physical.repo.artifacts_name, physical.repo.artifacts_remote);
    tips.set(repo.id, {
      row: physical.repo,
      ref,
      tip: refs.find((r) => r.name === ref)?.oid ?? null,
    });
  }
  const lastCommits = Object.fromEntries(ids.map((id) => [id, tips.get(id)?.tip ?? null]));
  const result = unwrap(await tracker.abandonTimeline(access, timeline.slug, lastCommits));
  const bookmarks: BookmarkResult[] = [];
  for (const entry of timeline.repos) {
    if (!entry.source || entry.source.kind !== "timeline-work") continue;
    const owned = await getWorkSource(c.env, entry.id, entry.source.sourceId);
    if (owned?.state === "ready") {
      const archived = unwrap(
        await tracker.transitionWorkSource(owned.source_id, owned.version, "archived"),
      );
      await db(c.env.DB)
        .updateTable("timeline_work_sources")
        .set({
          state: archived.state,
          version: archived.version,
          archived_at: archived.archived_at,
          updated_at: archived.updated_at,
        })
        .where("source_id", "=", archived.source_id)
        .where("version", "<=", archived.version)
        .execute();
    }
    bookmarks.push({ repoId: entry.id, ref: entry.source.ref, ok: true });
  }
  noteAgentPresence(c, presenceTarget(access.space.id, timeline.id));
  const [current] = await currentRepositoryNames(c.env.DB, access.space.id, [result.timeline]);
  return c.json<TimelineChange>({ timeline: current!, bookmarks });
});

timelines.get("/:slug/checkpoints", async (c) => {
  const access = await authorize(c, false);
  const tracker = trackerObject(c.env, access.space.id);
  const slug = c.req.param("slug");
  const [states, detail] = await Promise.all([
    tracker.checkpoints(access, slug),
    tracker.timeline(access, slug, 0, 1),
  ]);
  const timeline = unwrap(detail).timeline;
  const checkpoints = await Promise.all(
    unwrap(states).map((state) => view(c.env, state, timeline)),
  );
  noteAgentPresence(c, presenceTarget(access.space.id, timeline.id));
  const current = await currentRepositoryNames(
    c.env.DB,
    access.space.id,
    checkpoints.map((checkpoint) => checkpoint.checkpoint),
  );
  return c.json<CheckpointList>({
    checkpoints: checkpoints.map((checkpoint, index) => ({
      ...checkpoint,
      checkpoint: current[index]!,
    })),
  });
});

timelines.get("/:slug/checkpoints/:ref", async (c) => {
  const access = await authorize(c, false);
  const tracker = trackerObject(c.env, access.space.id);
  const slug = c.req.param("slug");
  const ref = c.req.param("ref");
  if (ref.length > 100) fail("invalid_input", "A checkpoint is its id or number.");
  const [state, detail] = await Promise.all([
    tracker.checkpoint(access, slug, ref),
    tracker.timeline(access, slug, 0, 1),
  ]);
  const timeline = unwrap(detail).timeline;
  const checkpoint = await view(c.env, unwrap(state), timeline);
  noteAgentPresence(c, presenceTarget(access.space.id, timeline.id));
  const [current] = await currentRepositoryNames(c.env.DB, access.space.id, [
    checkpoint.checkpoint,
  ]);
  return c.json<CheckpointView>({ ...checkpoint, checkpoint: current! });
});

timelines.post("/:slug/checkpoints", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  const data = await input(c, ["summary", "syncMain"]);
  if (data.syncMain !== undefined && typeof data.syncMain !== "boolean")
    fail("invalid_input", "syncMain must be a boolean.");
  const tracker = trackerObject(c.env, access.space.id);
  const timeline = unwrap(await tracker.timeline(access, c.req.param("slug"), 0, 1)).timeline;
  if (timeline.status === "landed" || timeline.status === "abandoned")
    fail("timeline_ended", `${timeline.slug} is ${timeline.status}.`, 409);
  const repos = await measure(c.env, actor, timeline, data.syncMain === true);
  const state = unwrap(
    await tracker.createCheckpoint(access, timeline.slug, { summary: data.summary, repos }),
  );
  // The preview contract: each repository that opts in builds this checkpoint.
  const waitUntil = (work: Promise<unknown>) => c.executionCtx.waitUntil(work);
  const firstRepo = state.checkpoint.repos[0];
  if (!firstRepo) fail("invalid_input", "A checkpoint must contain a repository.");
  const authority = await captureWorkAuthority(c.env, firstRepo.id, actor);
  waitUntil(previewCheckpoint(c.env, state.checkpoint, timeline, actor, waitUntil, authority));
  // The timeline's wiki pages (CORE-84), queued after the answer too.
  waitUntil(requestCheckpointPages(c.env, state.checkpoint, timeline.slug, actor.id, authority));
  // Its full CI and knowledge overlays now, not after the quiet period (CORE-238).
  for (const repo of state.checkpoint.repos) {
    const bookmark = timelineBookmark(timeline.slug);
    // An owned work source runs its CI on its own `work` branch.
    const work = repo.source?.kind === "timeline-work" ? repo.source : null;
    waitUntil(
      releaseQuiet(
        c.env,
        repo.id,
        work ? work.ref.replace(/^refs\/heads\//, "") : bookmark,
        repo.commit,
        work?.sourceId,
      ).catch((error) => console.error("CI: releasing the checkpoint's run failed", error)),
    );
    waitUntil(
      overlayNow(c.env, repo.id, [`refs/heads/${bookmark}`], authority).catch((error) =>
        console.error("Knowledge: the checkpoint's overlay failed to start", error),
      ),
    );
  }
  // Green already? An auto timeline lands it (CORE-77).
  if (timeline.policy === "auto")
    waitUntil(
      settled(c.env, (deps) =>
        maybeLand(c.env, deps, access.space.id, timeline.slug, "auto", authority),
      ),
    );
  const checkpoint = await view(c.env, state, timeline);
  noteAgentPresence(c, presenceTarget(access.space.id, timeline.id));
  const [current] = await currentRepositoryNames(c.env.DB, access.space.id, [
    checkpoint.checkpoint,
  ]);
  return c.json<CheckpointView>({ ...checkpoint, checkpoint: current! }, 201);
});

timelines.post("/:slug/checkpoints/:ref/revive", async (c) => {
  const access = await authorize(c, false);
  const actor = c.get("actor")!;
  const tracker = trackerObject(c.env, access.space.id);
  const slug = c.req.param("slug");
  const ref = c.req.param("ref");
  if (ref.length > 100) fail("invalid_input", "A checkpoint is its id or number.");
  const [found, detail] = await Promise.all([
    tracker.checkpoint(access, slug, ref),
    tracker.timeline(access, slug, 0, 1),
  ]);
  const state = unwrap(found);
  const timeline = unwrap(detail).timeline;
  // Starting runs needs write access to every repository, as checkpoints do.
  await mayWriteAll(c.env, actor, state.checkpoint);
  const firstRepo = state.checkpoint.repos[0];
  if (!firstRepo) fail("invalid_input", "A checkpoint must contain a repository.");
  const authority = await captureWorkAuthority(c.env, firstRepo.id, actor);
  const runs = await reviveCheckpoint(
    c.env,
    state.checkpoint,
    timeline,
    actor,
    (work) => c.executionCtx.waitUntil(work),
    authority,
  );
  const checkpoint = await view(c.env, state, timeline);
  noteAgentPresence(c, presenceTarget(access.space.id, timeline.id));
  const [current] = await currentRepositoryNames(c.env.DB, access.space.id, [
    checkpoint.checkpoint,
  ]);
  return c.json<PreviewRevival>(
    { checkpoint: { ...checkpoint, checkpoint: current! }, runs },
    runs.some((run) => "number" in run) ? 201 : 200,
  );
});

timelines.post("/:slug/land", async (c) => {
  const access = await authorize(c, true);
  const actor = c.get("actor")!;
  const tracker = trackerObject(c.env, access.space.id);
  const timeline = unwrap(await tracker.timeline(access, c.req.param("slug"), 0, 1)).timeline;
  // Landing moves main: it needs write access to every repository it lands in.
  const writable = await writableRepoIds(c.env.DB, actor, access.space.id);
  for (const repo of timeline.repos)
    if (!writable.includes(repo.id))
      fail("forbidden", `Landing needs write access to ${repo.space}/${repo.name}.`, 403);
  const result = await requestLanding(
    c.env,
    workerDeps(c.env, (work) => c.executionCtx.waitUntil(work)),
    access,
    timeline.slug,
    "request",
    actor,
  );
  noteAgentPresence(c, presenceTarget(access.space.id, timeline.id));
  const [current] = await currentRepositoryNames(c.env.DB, access.space.id, [result.landing]);
  return c.json<LandResult>({ ...result, landing: current! }, result.queued ? 202 : 200);
});

timelines.get("/:slug/landing", async (c) => {
  const access = await authorize(c, false);
  const tracker = trackerObject(c.env, access.space.id);
  const timeline = unwrap(await tracker.timeline(access, c.req.param("slug"), 0, 1)).timeline;
  const landing = unwrap(await tracker.landing(access, timeline.slug));
  noteAgentPresence(c, presenceTarget(access.space.id, timeline.id));
  const [current] = await currentRepositoryNames(
    c.env.DB,
    access.space.id,
    landing ? [landing] : [],
  );
  return c.json<{ landing: Landing | null }>({ landing: current ?? null });
});
