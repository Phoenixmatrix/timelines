// The push log: the history git doesn't keep. After
// every push through the proxy, recordPush() compares the repository's
// branches and tags with the ones it last saw (repo_refs) and records each
// update: the ref, its old and new commit, the person and agent who pushed,
// and when. A created ref has no old commit, a deleted one no new commit.
//
// Then it reads the commits each update made newly reachable and records the
// refs every change (gm's `change-id` commit header) reached, and the tracker
// issues their messages mention (worker/mentions). The Artifacts
// binding's readCommit drops that header, so the commits come from a protocol
// v2 fetch without blobs, bounded in depth and in size.

import type { Actor } from "../db.ts";
import {
  isTransientArtifactsError,
  lsRefs,
  upstreamToken,
  UpstreamStatusError,
} from "../artifacts.ts";
import { retrying } from "../retry.ts";
import { packCommits, type PackCommit } from "../git/pack.ts";
import { DELIM, FLUSH, pkt } from "../git/pktline.ts";
import { indexPushedMentions } from "../mentions/index.ts";
import { readPktLines } from "../mirror/protocol.ts";
import { batch, db, nowIso } from "../schema.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import { resumeMentionBackfill } from "../mentions/backfill.ts";

/** Generations of history read per update: a new branch's history stops here. */
const MAX_DEPTH = 500;
const MAX_PACK_BYTES = 32 * 1024 * 1024;
/** Updates per push whose commits are read; any more are logged without them. */
const MAX_READS = 10;
/** change_refs rows per statement, under D1's 100 bound parameters. */
const ROWS_PER_INSERT = 14;

const decoder = new TextDecoder();

export interface PushRepo {
  id: string;
  source_id?: string;
  artifacts_name: string;
  artifacts_remote: string;
}

export interface LoggedUpdate {
  id: number;
  ref: string;
  old: string | null;
  new: string | null;
  /** The commits it made newly reachable, when they were read. */
  commits?: PackCommit[];
}

export interface NewCommits {
  /** Newest first, as the pack has them. */
  commits: PackCommit[];
  /** History was cut short (the depth or size limit): what's missing is unknown. */
  truncated: boolean;
}

/** The commits reachable from `want` but from none of `haves`. */
export type CommitReader = (want: string, haves: string[]) => Promise<NewCommits>;

/** Only branches and tags are logged, the refs git clients push and mirrors copy. */
function isLogged(name: string): boolean {
  return name.startsWith("refs/heads/") || name.startsWith("refs/tags/");
}

/** Log a push to `repo`: list its refs now and record what changed. */
export async function recordPush(
  env: Env,
  repo: PushRepo,
  actor: Pick<Actor, "id" | "agent" | "credential"> | null,
): Promise<LoggedUpdate[]> {
  const authority = actor?.credential ? await captureWorkAuthority(env, repo.id, actor) : null;
  if (actor?.credential && (!repo.source_id || repo.source_id === "canonical"))
    await resumeMentionBackfill(env, repo.id, actor).catch((error) =>
      console.error("Mentions: backfill admission failed", { repo: repo.id, error }),
    );
  const logged = await recordRefs(
    env.DB,
    repo.id,
    await loggedTips(env, repo),
    actor,
    (want, haves) => fetchNewCommits(env, repo, want, haves),
    repo.source_id ?? "canonical",
  );
  // The issues their messages mention (CORE-22), as this source's (CORE-296).
  if (authority) {
    await indexPushedMentions(env, repo.id, authority, logged, {
      sourceId: repo.source_id ?? "canonical",
    });
  }
  return logged;
}

/** The branches and tags Artifacts holds for `repo` now: what the push log compares. */
export async function loggedTips(env: Env, repo: PushRepo): Promise<Map<string, string>> {
  const tips = new Map<string, string>();
  for (const ref of await lsRefs(env, repo.artifacts_name, repo.artifacts_remote)) {
    if (ref.oid && isLogged(ref.name)) tips.set(ref.name, ref.oid);
  }
  return tips;
}

/**
 * Log ref moves no push recorded, with no known pusher: the Space cutover's
 * reconciliation of writes Artifacts accepted while the database was fenced
 * (space-cutover/ref-barrier.ts). `d1` may be the fenced migration database.
 */
export function recordObservedRefs(
  env: Env,
  d1: D1Database,
  repo: PushRepo,
  tips: Map<string, string>,
): Promise<LoggedUpdate[]> {
  return recordRefs(
    d1,
    repo.id,
    tips,
    null,
    (want, haves) => fetchNewCommits(env, repo, want, haves),
    repo.source_id ?? "canonical",
  );
}

/**
 * The push-log entries a reconciliation logged for `changes` with no known
 * pusher, with the commits each made newly reachable: what replaying their
 * effects needs (space-cutover/ref-barrier.ts), since repo_refs has already
 * moved past them. A change some push logged with its pusher is left out: that
 * push delivered its own effects.
 */
export async function journaledUpdates(
  env: Env,
  repo: PushRepo,
  changes: { ref: string; old: string | null; new: string | null }[],
): Promise<LoggedUpdate[]> {
  const kdb = db(env.DB);
  const sourceId = repo.source_id ?? "canonical";
  const logged: LoggedUpdate[] = [];
  for (const change of changes) {
    const row = await kdb
      .selectFrom("ref_updates")
      .select("id")
      .where("repo_id", "=", repo.id)
      .where("source_id", "=", sourceId)
      .where("ref", "=", change.ref)
      .where((eb) =>
        change.old === null ? eb("old_oid", "is", null) : eb("old_oid", "=", change.old),
      )
      .where((eb) =>
        change.new === null ? eb("new_oid", "is", null) : eb("new_oid", "=", change.new),
      )
      .where("actor_id", "is", null)
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (row && !logged.some((update) => update.id === row.id))
      logged.push({ ...change, id: row.id });
  }
  const others = await kdb
    .selectFrom("repo_refs")
    .select(["ref", "oid"])
    .where("repo_id", "=", repo.id)
    .where("source_id", "=", sourceId)
    .execute();
  for (const update of logged.filter((u) => u.new !== null).slice(0, MAX_READS)) {
    const haves = update.old
      ? [update.old]
      : [...new Set(others.filter((r) => r.ref !== update.ref).map((r) => r.oid))];
    try {
      update.commits = (await fetchNewCommits(env, repo, update.new!, haves)).commits;
    } catch (error) {
      console.error("Push log: couldn't read a replayed update's commits", {
        repo: repo.id,
        ref: update.ref,
        error,
      });
    }
  }
  return logged.sort((a, b) => a.id - b.id);
}

/**
 * Record how `tips` differ from the refs last seen, then read each update's
 * new commits. Each update is logged by the one call that moves repo_refs past
 * it, so racing pushes (and retries) never log the same update twice. Returns
 * the updates this call logged.
 */
export async function recordRefs(
  d1: D1Database,
  repoId: string,
  tips: Map<string, string>,
  actor: Pick<Actor, "id" | "agent"> | null,
  read: CommitReader,
  sourceId = "canonical",
): Promise<LoggedUpdate[]> {
  const kdb = db(d1);
  const known = new Map(
    (
      await kdb
        .selectFrom("repo_refs")
        .select(["ref", "oid"])
        .where("repo_id", "=", repoId)
        .where("source_id", "=", sourceId)
        .execute()
    ).map((r) => [r.ref, r.oid]),
  );
  const changes: Omit<LoggedUpdate, "id">[] = [];
  for (const [ref, oid] of tips) {
    const old = known.get(ref) ?? null;
    if (old !== oid) changes.push({ ref, old, new: oid });
  }
  for (const [ref, oid] of known) if (!tips.has(ref)) changes.push({ ref, old: oid, new: null });
  if (changes.length === 0) return [];

  // Per update: log it if repo_refs still holds the old commit, then move
  // repo_refs on. One batch is one transaction.
  const statements = changes.flatMap((change) => {
    const current = kdb
      .selectFrom("repo_refs")
      .select("oid")
      .where("repo_id", "=", repoId)
      .where("source_id", "=", sourceId)
      .where("ref", "=", change.ref);
    const log = kdb
      .insertInto("ref_updates")
      .columns([
        "repo_id",
        "source_id",
        "ref",
        "old_oid",
        "new_oid",
        "forced",
        "actor_id",
        "agent_id",
      ])
      .expression((eb) =>
        eb
          .selectFrom("repos")
          .select([
            eb.val(repoId).as("repo_id"),
            eb.val(sourceId).as("source_id"),
            eb.val(change.ref).as("ref"),
            eb.val(change.old).as("old_oid"),
            eb.val(change.new).as("new_oid"),
            // Creations and deletions are never forced; moves are known once read.
            eb.val(change.old && change.new ? null : 0).as("forced"),
            eb.val(actor?.id ?? null).as("actor_id"),
            eb.val(actor?.agent?.id ?? null).as("agent_id"),
          ])
          .where("repos.id", "=", repoId)
          .where(
            change.old === null
              ? eb.not(eb.exists(current))
              : eb.exists(current.where("oid", "=", change.old)),
          ),
      )
      .returning("id");
    const move =
      change.old === null
        ? kdb
            .insertInto("repo_refs")
            .values({ repo_id: repoId, source_id: sourceId, ref: change.ref, oid: change.new! })
            .onConflict((oc) => oc.doNothing())
        : change.new === null
          ? kdb
              .deleteFrom("repo_refs")
              .where("repo_id", "=", repoId)
              .where("source_id", "=", sourceId)
              .where("ref", "=", change.ref)
              .where("oid", "=", change.old)
          : kdb
              .updateTable("repo_refs")
              .set({ oid: change.new })
              .where("repo_id", "=", repoId)
              .where("source_id", "=", sourceId)
              .where("ref", "=", change.ref)
              .where("oid", "=", change.old);
    return [log, move];
  });
  const results = await batch(d1, statements);
  const logged: LoggedUpdate[] = [];
  changes.forEach((change, index) => {
    const row = (results[index * 2]?.results as { id: number }[] | undefined)?.[0];
    if (row) logged.push({ ...change, id: row.id });
  });

  const writes: Parameters<typeof batch>[1] = [];
  for (const update of logged.filter((u) => u.new !== null).slice(0, MAX_READS)) {
    // A move counts the commits the old tip didn't have. A new ref counts the
    // ones no other ref had: forking a branch doesn't re-record its history.
    const haves = update.old
      ? [update.old]
      : [...new Set([...known].filter(([ref]) => ref !== update.ref).map(([, oid]) => oid))];
    let found: NewCommits;
    try {
      found = await read(update.new!, haves);
    } catch (error) {
      console.error("Push log: couldn't read the pushed commits", {
        repo: repoId,
        ref: update.ref,
        error,
      });
      continue;
    }
    update.commits = found.commits;
    if (update.old) {
      // Fast-forward when a new commit has the old tip as a parent; with
      // history cut short, it can't be told.
      const fastForward = found.commits.some((c) => c.parents.includes(update.old!));
      const forced = fastForward ? 0 : found.truncated ? null : 1;
      writes.push(kdb.updateTable("ref_updates").set({ forced }).where("id", "=", update.id));
    }
    // One row per change: the newest of its commits, which packs list first.
    const reached = new Map<string, string>();
    for (const commit of found.commits) {
      if (commit.changeId && !reached.has(commit.changeId))
        reached.set(commit.changeId, commit.oid);
    }
    const rows = [...reached].map(([changeId, oid]) => ({
      repo_id: repoId,
      source_id: sourceId,
      change_id: changeId,
      ref: update.ref,
      first_commit_oid: oid,
      first_update_id: update.id,
      last_commit_oid: oid,
    }));
    // Step context reported before this push (CORE-231) is now verified.
    const pushed = found.commits.map((commit) => commit.oid);
    for (let start = 0; start < pushed.length; start += ROWS_PER_INSERT) {
      writes.push(
        kdb
          .updateTable("step_contexts")
          .set({ verified_at: nowIso() })
          .where("repo_id", "=", repoId)
          .where("commit_oid", "in", pushed.slice(start, start + ROWS_PER_INSERT))
          .where("verified_at", "is", null),
      );
    }
    for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
      writes.push(
        kdb
          .insertInto("change_refs")
          .values(rows.slice(start, start + ROWS_PER_INSERT))
          .onConflict((oc) =>
            oc.columns(["repo_id", "source_id", "change_id", "ref"]).doUpdateSet((eb) => ({
              last_commit_oid: eb.ref("excluded.last_commit_oid"),
              last_seen_at: nowIso(),
            })),
          ),
      );
    }
  }
  await batch(d1, writes);
  return logged;
}

/**
 * A protocol v2 `fetch` of the commits (and trees: Artifacts has no `tree:0`
 * filter) reachable from `want` and not from `haves`, without blobs, at most
 * MAX_DEPTH generations deep. No `thin-pack`, so deltas have their bases.
 */
export function newCommitsRequest(want: string, haves: string[]): string {
  let body =
    pkt("command=fetch\n") +
    pkt("agent=gitmatrix\n") +
    pkt("object-format=sha1\n") +
    DELIM +
    pkt("no-progress\n") +
    pkt("ofs-delta\n") +
    pkt("filter blob:none\n") +
    pkt(`deepen ${MAX_DEPTH}\n`) +
    pkt(`want ${want}\n`);
  for (const oid of haves) body += pkt(`have ${oid}\n`);
  return body + pkt("done\n") + FLUSH;
}

async function fetchNewCommits(
  env: Env,
  repo: PushRepo,
  want: string,
  haves: string[],
): Promise<NewCommits> {
  // A read: retried through transient failures (CORE-331), each try bounded,
  // with room for a pack up to MAX_PACK_BYTES.
  return retrying(
    async () => {
      const token = await upstreamToken(env, repo.artifacts_name, "read");
      const response = await fetch(`${repo.artifacts_remote}/git-upload-pack`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-git-upload-pack-request",
          accept: "application/x-git-upload-pack-result",
          "git-protocol": "version=2",
        },
        body: newCommitsRequest(want, haves),
        signal: AbortSignal.timeout(PACK_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new UpstreamStatusError("fetch", response.status);
      }
      return readNewCommits(response.body, MAX_PACK_BYTES);
    },
    {
      retryable: isTransientArtifactsError,
      label: "Push log: reading new commits",
      context: { artifactsName: repo.artifacts_name },
    },
  );
}

/** How long one read of new commits may take, pack included. */
const PACK_TIMEOUT_MS = 60_000;

/**
 * The commits in a v2 fetch response. `shallow` lines (in `shallow-info`) mean
 * the depth limit cut history; a pack over `maxBytes` is read up to the cut.
 * When every wanted commit is already had, there may be no pack at all.
 */
export async function readNewCommits(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<NewCommits> {
  let section = "";
  let truncated = false;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const line of readPktLines(stream)) {
    if (line.type !== "data") {
      if (section === "packfile" && line.type === "flush") break;
      continue;
    }
    if (section !== "packfile") {
      const text = decoder.decode(line.data).replace(/\n$/, "");
      if (text.startsWith("ERR ")) throw new Error(`Artifacts refused the fetch: ${text.slice(4)}`);
      if (text === "shallow-info" || text === "packfile" || text === "acknowledgments") {
        section = text;
      } else if (section === "shallow-info" && text.startsWith("shallow ")) truncated = true;
      continue;
    }
    const band = line.data[0];
    if (band === 3) throw new Error(`Artifacts: ${decoder.decode(line.data.subarray(1))}`);
    if (band !== 1) continue;
    parts.push(line.data.subarray(1));
    size += line.data.length - 1;
    if (size > maxBytes) {
      truncated = true;
      break;
    }
  }
  // Leaving early (the size cap) releases the reader; let go of the rest.
  if (truncated) await stream.cancel().catch(() => undefined);
  if (size === 0) return { commits: [], truncated };
  const pack = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    pack.set(part, offset);
    offset += part.length;
  }
  return { commits: await packCommits(pack), truncated };
}
