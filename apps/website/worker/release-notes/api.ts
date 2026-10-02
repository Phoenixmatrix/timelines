import { Hono } from "hono";
import type { CommitSummary } from "../../shared/api.ts";
import type { LinkedIssue, RangeCommit, ReleaseRangeResponse } from "../../shared/release-notes.ts";
import { loadRepo } from "../api/repos.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor, RepoRow } from "../db.ts";
import { RepoReader } from "../objects.ts";
import { accessible, trackerObject } from "../tracker/api.ts";
import { issueKeys } from "./keys.ts";
import { walkRange } from "./range.ts";

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
  const issues: LinkedIssue[] = [];
  for (const owner of await accessible(env.DB, actor)) {
    const stub = trackerObject(env, owner.id);
    const subscribed = await stub.subscribedWorkspaces(repo.id);
    if (!subscribed.ok || !subscribed.value.length) continue;
    // The tracker looks up at most 500 keys per call.
    for (let start = 0; start < keys.length; start += 500) {
      const found = await stub.issuesByKey(keys.slice(start, start + 500));
      if (!found.ok) throw new Error(`Tracker lookup failed: ${found.error}`);
      for (const issue of found.value) issues.push({ ...issue, trackerOwner: owner.slug });
    }
  }
  return issues.sort(
    (a, b) =>
      keys.indexOf(a.key) - keys.indexOf(b.key) || a.trackerOwner.localeCompare(b.trackerOwner),
  );
}

/**
 * The commits of one release and the issues they mention. `to` names a tag
 * (or any ref) and includes its own commit; without it, the range is the
 * default branch's unreleased work. It starts after `from`, or after the
 * nearest tagged commit in first-parent history.
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
    }));
    const keys = [...new Set(commits.flatMap((commit) => commit.issueKeys))];
    const body: ReleaseRangeResponse = {
      to: { ref: toRef, oid: toOid },
      from: walk.base
        ? { tag: fromParam || tagged.get(walk.base) || walk.base, oid: walk.base }
        : null,
      commits,
      truncated: walk.truncated,
      issues: await linkedIssues(c.env, c.get("actor"), row, keys),
    };
    return c.json(body);
  } finally {
    await objects.close();
  }
});
