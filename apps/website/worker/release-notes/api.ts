import { Hono } from "hono";
import type { CommitSummary } from "../../shared/api.ts";
import type { LinkedIssue, RangeCommit, ReleaseRangeResponse } from "../../shared/release-notes.ts";
import { releaseName } from "../../shared/release-notes.ts";
import { loadRepo } from "../api/repos.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor, RepoRow } from "../db.ts";
import { RepoReader } from "../objects.ts";
import { accessible } from "../tracker/api.ts";
import { FeedError, releaseFeed } from "./feed.ts";
import { issueKeys } from "./keys.ts";
import { walkRange } from "./range.ts";
import { landedTimelines, spaceTimelines } from "./timelines.ts";
import { releaseIndex, releaseNotesFor, viewerTrackers } from "./read.ts";
import { issuesFrom } from "./trackers.ts";
import { ensureReleaseNotes } from "./queue.ts";
import { compactReleaseInputs } from "./compact.ts";
import { findSpaceBySlug } from "../spaces/access.ts";
import { readReleaseHighlights } from "./highlights.ts";
import { composeRepoNotes, composeTrackerNotes } from "./compose.ts";

export const releaseNotes = new Hono<AppEnv>();

releaseNotes.use("*", async (c, next) => {
  if (c.req.query("source") && c.req.query("source") !== "canonical")
    return c.json(
      {
        error:
          "Release notes describe canonical history; work progress is available through its source.",
      },
      400,
    );
  await next();
});

function summary(commit: ArtifactsCommitMetadata): CommitSummary {
  return {
    oid: commit.hash,
    message: commit.message,
    authorName: commit.author.name,
    authorEmail: commit.author.email,
    authoredAt: commit.authoredAt,
    parents: commit.parents,
  };
}

/**
 * Resolve issue keys through the trackers this repository is subscribed to,
 * among those the actor can read. Anonymous callers and unsubscribed or
 * inaccessible trackers resolve nothing, so private issues stay concealed.
 */
export async function linkedIssues(
  env: Env,
  actor: Actor | null,
  repo: RepoRow,
  keys: string[],
): Promise<LinkedIssue[]> {
  if (!actor || !keys.length) return [];
  return issuesFrom(env, await accessible(env.DB, actor), repo.id, keys, actor);
}

/**
 * The commits of one release and the issues they mention. `to` names a tag
 * (or any ref) and includes its own commit; without it, the range is the
 * default branch's unreleased work. It starts after `from`, or after the
 * nearest tagged commit in first-parent history. Each merge on the way brings
 * the commits it landed, and the timeline it landed as far as it's known.
 */
releaseNotes.get("/range", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  const { row } = loaded;
  const objects = new RepoReader(
    c.env,
    row.artifacts_name,
    row.artifacts_remote,
    c.get("timing"),
    (work) => c.executionCtx.waitUntil(work),
  );
  try {
    const refs = await objects.refs();
    const toParam = c.req.query("to");
    const fromParam = c.req.query("from");
    const toRef = toParam || refs.headBranch || row.default_branch;
    const toOid = await objects.resolve(toRef);
    if (toParam && !toOid) return c.json({ error: `No such ref: ${toParam}.` }, 404);
    let fromOid: string | null = null;
    if (fromParam) {
      fromOid = await objects.resolve(fromParam);
      if (!fromOid) return c.json({ error: `No such ref: ${fromParam}.` }, 404);
    }
    const empty: ReleaseRangeResponse = {
      to: null,
      from: null,
      commits: [],
      timelines: [],
      truncated: false,
      issues: [],
    };
    if (!toOid) return c.json(empty);

    const tagged = new Map<string, string>();
    // Tags sort newest first, so the first name per commit is the newest.
    for (const tag of refs.tags) if (!tagged.has(tag.oid)) tagged.set(tag.oid, tag.shortName);
    const walk = await walkRange(
      objects,
      toOid,
      fromOid ? (oid) => oid === fromOid : (oid) => tagged.has(oid),
      { includeStart: Boolean(toParam) },
    );
    const compact = await compactReleaseInputs(
      c.env.DB,
      row.id,
      walk.commits.map((commit) => commit.hash),
    );
    const commits: RangeCommit[] = walk.commits.flatMap((commit) => {
      const input = compact.get(commit.hash);
      const canonical: RangeCommit = {
        ...summary(commit),
        issueKeys: issueKeys(commit.message),
        landing: walk.landings.get(commit.hash) ?? null,
      };
      return input
        ? [
            canonical,
            ...input.commits.map((metadata) => ({
              ...summary(metadata),
              source: input.source,
              issueKeys: issueKeys(metadata.message),
              landing: commit.hash,
            })),
          ]
        : [canonical];
    });
    const merges = walk.commits.filter(
      (commit) => commit.parents.length > 1 && !walk.landings.has(commit.hash),
    );
    const keys = [...new Set(commits.flatMap((commit) => commit.issueKeys))];
    const body: ReleaseRangeResponse = {
      to: { ref: toRef, oid: toOid },
      from: walk.base
        ? { tag: fromParam || tagged.get(walk.base) || walk.base, oid: walk.base }
        : null,
      commits,
      timelines: [
        ...(
          await landedTimelines(
            c.env.DB,
            row.id,
            refs.headBranch,
            merges,
            spaceTimelines(c.env, row.space_id, c.get("actor")),
          )
        ).values(),
        ...[...compact.values()].map((input) => input.timeline),
      ],
      truncated: walk.truncated,
      issues: await linkedIssues(c.env, c.get("actor"), row, keys),
    };
    return c.json(body);
  } finally {
    await objects.close();
  }
});
/** The releases this repository has notes for, and whether generation is running. */
releaseNotes.get("/", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  c.header("cache-control", "private, no-store");
  await ensureReleaseNotes(c.env, loaded.row.id, c.get("actor"));
  const trackers = await viewerTrackers(c.env.DB, c.get("actor"));
  return c.json(
    await releaseIndex(
      c.env.DB,
      loaded.row.id,
      trackers,
      Boolean(c.env.AI),
      c.req.query("timeline"),
    ),
  );
});

/** One release's introduction and entries, as the viewer may see them. */
releaseNotes.get("/release", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  c.header("cache-control", "private, no-store");
  await ensureReleaseNotes(c.env, loaded.row.id, c.get("actor"));
  const name = releaseName(c.req.query("name") ?? "");
  const trackers = await viewerTrackers(c.env.DB, c.get("actor"));
  const body = await releaseNotesFor(
    c.env.DB,
    loaded.row.id,
    name,
    trackers,
    c.req.query("timeline"),
  );
  if (!body) return c.json({ error: "No release notes for that release." }, 404);
  return c.json(body);
});

/** A tracker Space's release feed: `?q=` is ANDed with `?timeline=` scope. */
export const trackerReleaseNotes = new Hono<AppEnv>();
trackerReleaseNotes.get("/", async (c) => {
  c.header("cache-control", "private, no-store");
  try {
    return c.json(
      await releaseFeed(
        c.env,
        c.get("actor"),
        c.req.param("space") ?? "",
        c.req.query("q") ?? "",
        c.req.query("timeline"),
      ),
    );
  } catch (error) {
    if (error instanceof FeedError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

trackerReleaseNotes.get("/highlights", async (c) => {
  c.header("cache-control", "private, no-store");
  const actor = c.get("actor");
  if (!actor || actor.agent)
    return c.json({ error: "Sign in as a person to read highlights." }, 401);
  const space = await findSpaceBySlug(c.env.DB, c.req.param("space") ?? "");
  if (!space) return c.json({ error: "Tracker Space not found." }, 404);
  try {
    return c.json(
      await readReleaseHighlights(c.env, actor, {
        type: "release-highlights",
        scope: "tracker",
        scopeId: space.id,
        viewerId: actor.id,
        spaceId: space.id,
      }),
    );
  } catch (error) {
    if (error instanceof FeedError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// Custom release notes written on demand (CORE-151).
releaseNotes.route("/", composeRepoNotes);
trackerReleaseNotes.route("/", composeTrackerNotes);
