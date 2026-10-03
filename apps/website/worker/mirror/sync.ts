// One-way mirroring: make another git host's default branch and tags match a
// repository's, after every push. Workers can't run git, so this speaks the
// wire protocol: read the target's refs, fetch exactly the missing objects
// from Artifacts as a pack, and stream that pack into the target's
// receive-pack. Pushes enqueue a sync (queue.ts); a lease keeps one sync per
// repository at a time, and a sync always converges on the latest state.

import { seal, unseal } from "../../registry/core/seal.ts";
import { upstreamToken } from "../artifacts.ts";
import { lsRefsRequest, parseLsRefs } from "../git/pktline.ts";
import { productionOnly } from "../preview.ts";
import { db, nowIso } from "../schema.ts";
import {
  fetchRequest,
  needsPack,
  packFromFetchResponse,
  parsePushReport,
  parseReceivePackAdvertisement,
  planMirror,
  receivePackCommands,
  ZERO_OID,
  type RefUpdate,
} from "./protocol.ts";

const LEASE_MS = 10 * 60_000;
const MAX_HAVES = 256;
const USER_AGENT = "git/2.47.0 (gitmatrix-mirror)";

export class MirrorError extends Error {}

export interface MirrorResult {
  status: "ok" | "skipped" | "busy";
  updates: RefUpdate[];
  message: string;
}

/** HTTPS, or plain HTTP for a local target while developing. */
export function normalizeMirrorUrl(raw: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new MirrorError("Give the mirror an https:// clone URL.");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new MirrorError("Mirrors push over https.");
  }
  if (url.username || url.password) {
    throw new MirrorError("Put the token in the token field, not in the URL.");
  }
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith(".git") ? path : `${path}.git`;
  return url.toString();
}

export function sealMirrorToken(env: Env, token: string): Promise<string> {
  return seal(env, token);
}

interface Target {
  url: string;
  authorization: string;
}

function basic(username: string, token: string): string {
  return `Basic ${btoa(`${username}:${token}`)}`;
}

/**
 * The source's branches and tags, tag objects unpeeled (a mirror pushes them
 * as they are), and the branch HEAD points at: the default branch.
 */
async function sourceRefs(env: Env, artifactsName: string, remote: string) {
  const token = await upstreamToken(env, artifactsName, "read");
  const response = await fetch(`${remote}/git-upload-pack`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      "git-protocol": "version=2",
    },
    body: lsRefsRequest(),
  });
  if (!response.ok) throw new MirrorError(`Couldn't list refs (HTTP ${response.status}).`);
  const refs = new Map<string, string>();
  let head: string | null = null;
  for (const ref of parseLsRefs(new Uint8Array(await response.arrayBuffer()))) {
    if (ref.name === "HEAD") head = ref.symrefTarget ?? null;
    else if (ref.oid && /^refs\/(heads|tags)\//.test(ref.name)) refs.set(ref.name, ref.oid);
  }
  return { refs, head };
}

async function advertisement(target: Target) {
  const response = await fetch(`${target.url}/info/refs?service=git-receive-pack`, {
    headers: { authorization: target.authorization, "user-agent": USER_AGENT },
  });
  if (response.status === 401 || response.status === 403) {
    throw new MirrorError(
      `The mirror target refused the token (HTTP ${response.status}); it needs push access.`,
    );
  }
  if (response.status === 404) {
    throw new MirrorError("The mirror target doesn't exist, or the token can't see it.");
  }
  if (!response.ok) throw new MirrorError(`The mirror target answered HTTP ${response.status}.`);
  return parseReceivePackAdvertisement(new Uint8Array(await response.arrayBuffer()));
}

/** Concatenate the command list and the pack into one streamed request body. */
function pushBody(commands: Uint8Array, pack: AsyncGenerator<Uint8Array> | null) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(commands);
      if (!pack) {
        controller.close();
        return;
      }
      try {
        for await (const chunk of pack) controller.enqueue(chunk);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/**
 * Push the source's default branch and tags to the target. Throws MirrorError
 * with a readable reason.
 */
export async function mirrorRepository(
  env: Env,
  source: { artifactsName: string; remote: string; defaultBranch: string },
  target: Target,
  prune: boolean,
): Promise<{ updates: RefUpdate[]; head: string | null }> {
  const [from, to] = await Promise.all([
    sourceRefs(env, source.artifactsName, source.remote),
    advertisement(target),
  ]);
  // Git's HEAD is the source of truth (imports keep theirs); the recorded
  // default branch covers a HEAD the listing didn't name.
  const defaultBranch = from.head ?? `refs/heads/${source.defaultBranch}`;
  const updates = planMirror(from.refs, to.refs, defaultBranch, prune);
  const head = from.refs.get(defaultBranch) ?? null;
  if (updates.length === 0) return { updates, head };
  if (updates.some((u) => u.new === ZERO_OID) && !to.capabilities.has("delete-refs")) {
    throw new MirrorError("The mirror target doesn't allow deleting refs; turn pruning off.");
  }

  let pack: AsyncGenerator<Uint8Array> | null = null;
  if (needsPack(updates)) {
    const wants = updates.filter((u) => u.new !== ZERO_OID).map((u) => u.new);
    const haves = [...to.refs.values()].slice(0, MAX_HAVES);
    const token = await upstreamToken(env, source.artifactsName, "read");
    const fetched = await fetch(`${source.remote}/git-upload-pack`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-git-upload-pack-request",
        accept: "application/x-git-upload-pack-result",
        "git-protocol": "version=2",
      },
      body: fetchRequest(wants, haves, to.capabilities.has("ofs-delta")),
    });
    if (!fetched.ok || !fetched.body) {
      throw new MirrorError(`Couldn't read objects from storage (HTTP ${fetched.status}).`);
    }
    pack = packFromFetchResponse(fetched.body);
  }

  const sideband = to.capabilities.has("side-band-64k");
  const pushed = await fetch(`${target.url}/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization: target.authorization,
      "user-agent": USER_AGENT,
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
    },
    body: pushBody(receivePackCommands(updates, to.capabilities), pack),
  });
  if (!pushed.ok) throw new MirrorError(`The mirror target answered HTTP ${pushed.status}.`);
  const report = parsePushReport(new Uint8Array(await pushed.arrayBuffer()), sideband);
  if (report.errors.length) throw new MirrorError(report.errors.join("; "));
  if (report.unpack && report.unpack !== "ok") {
    throw new MirrorError(`The mirror target couldn't unpack: ${report.unpack}`);
  }
  const rejected = report.refs.filter((r) => !r.ok);
  if (rejected.length) {
    throw new MirrorError(
      rejected.map((r) => `${r.ref}: ${r.reason || "rejected"}`).join("; ") +
        (rejected.some((r) => /protect/i.test(r.reason ?? ""))
          ? " (branch protection on the target blocks force-pushes)"
          : ""),
    );
  }
  return { updates, head };
}

/**
 * Sync one repository's mirror and record the outcome. "busy" means another
 * sync holds the lease; the caller retries later.
 */
export async function syncMirror(env: Env, repoId: string): Promise<MirrorResult> {
  if (!productionOnly(env, "mirror", `a mirror sync of ${repoId}`))
    throw new MirrorError("Previews don't mirror: this one never pushes anywhere.");
  const k = db(env.DB);
  const now = nowIso();
  const leased = await k
    .updateTable("repo_mirrors")
    .set({
      lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
      status: "syncing",
      last_attempt_at: now,
    })
    .where("repo_id", "=", repoId)
    .where("enabled", "=", 1)
    .where((eb) => eb.or([eb("lease_until", "is", null), eb("lease_until", "<", now)]))
    .executeTakeFirst();
  if (Number(leased.numUpdatedRows) === 0) {
    const exists = await k
      .selectFrom("repo_mirrors")
      .select("enabled")
      .where("repo_id", "=", repoId)
      .executeTakeFirst();
    return exists?.enabled
      ? { status: "busy", updates: [], message: "Another sync is running." }
      : { status: "skipped", updates: [], message: "No mirror is enabled." };
  }

  try {
    const row = await k
      .selectFrom("repo_mirrors as m")
      .innerJoin("repos as r", "r.id", "m.repo_id")
      .select([
        "m.url",
        "m.username",
        "m.token_sealed",
        "m.prune",
        "r.artifacts_name",
        "r.artifacts_remote",
        "r.default_branch",
      ])
      .where("m.repo_id", "=", repoId)
      .executeTakeFirstOrThrow();
    if (!row.token_sealed) throw new MirrorError("The mirror has no token.");
    const token = await unseal(env, row.token_sealed);
    const { updates, head } = await mirrorRepository(
      env,
      {
        artifactsName: row.artifacts_name,
        remote: row.artifacts_remote,
        defaultBranch: row.default_branch,
      },
      { url: row.url, authorization: basic(row.username, token) },
      row.prune === 1,
    );
    await k
      .updateTable("repo_mirrors")
      .set({
        status: "ok",
        last_error: null,
        last_synced_at: nowIso(),
        last_synced_commit: head,
        lease_until: null,
        updated_at: nowIso(),
      })
      .where("repo_id", "=", repoId)
      .execute();
    return {
      status: "ok",
      updates,
      message: updates.length
        ? `Pushed ${updates.length} ref${updates.length === 1 ? "" : "s"}.`
        : "Already in sync.",
    };
  } catch (error) {
    const message =
      error instanceof MirrorError
        ? error.message
        : `Mirroring failed: ${error instanceof Error ? error.message : String(error)}`;
    await k
      .updateTable("repo_mirrors")
      .set({ status: "failed", last_error: message, lease_until: null, updated_at: nowIso() })
      .where("repo_id", "=", repoId)
      .execute();
    throw new MirrorError(message);
  }
}
