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
import { landedTimelines, ownerTimelines } from "./timelines.ts";
import { releaseIndex, releaseNotesFor, viewerTrackers } from "./read.ts";
import { issuesFrom } from "./trackers.ts";
import { ensureReleaseNotes } from "./queue.ts";

export const releaseNotes = new Hono<AppEnv>();

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
  return issuesFrom(env, await accessible(env.DB, actor), repo.id, keys);
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
    const commits: RangeCommit[] = walk.commits.map((commit) => ({
      ...summary(commit),
      issueKeys: issueKeys(commit.message),
      landing: walk.landings.get(commit.hash) ?? null,
    }));
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
      timelines: merges.length
        ? [
            ...(
              await landedTimelines(
                c.env.DB,
                row.id,
                refs.headBranch,
                merges,
                ownerTimelines(c.env, row.owner_id),
              )
            ).values(),
          ]
        : [],
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
  await ensureReleaseNotes(c.env, loaded.row.id);
  const trackers = await viewerTrackers(c.env.DB, c.get("actor"));
  return c.json(await releaseIndex(c.env.DB, loaded.row.id, trackers, Boolean(c.env.AI)));
});

/** One release's introduction and entries, as the viewer may see them. */
releaseNotes.get("/release", async (c) => {
  const loaded = await loadRepo(c);
  if (loaded instanceof Response) return loaded;
  c.header("cache-control", "private, no-store");
  await ensureReleaseNotes(c.env, loaded.row.id);
  const name = releaseName(c.req.query("name") ?? "");
  const trackers = await viewerTrackers(c.env.DB, c.get("actor"));
  const body = await releaseNotesFor(c.env.DB, loaded.row.id, name, trackers);
  if (!body) return c.json({ error: "No release notes for that release." }, 404);
  return c.json(body);
});

/** A tracker account's release feed: `?q=` takes the feed query language. */
export const trackerReleaseNotes = new Hono<AppEnv>();
trackerReleaseNotes.get("/", async (c) => {
  c.header("cache-control", "private, no-store");
  try {
    return c.json(
      await releaseFeed(c.env, c.get("actor"), c.req.param("owner") ?? "", c.req.query("q") ?? ""),
    );
  } catch (error) {
    if (error instanceof FeedError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});
