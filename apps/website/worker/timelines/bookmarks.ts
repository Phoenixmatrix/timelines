// Timeline bookmarks in Artifacts. The binding can't write refs, so this
// speaks receive-pack to the repository's remote like a push whose objects the
// server already has: the ref commands, then an empty pack (git sends one
// whenever a command creates or moves a ref), with a short-lived write token.

import { upstreamToken } from "../artifacts.ts";
import {
  needsPack,
  parsePushReport,
  parseReceivePackAdvertisement,
  receivePackCommands,
  ZERO_OID,
} from "../mirror/protocol.ts";
import { invalidateRefs } from "../objects.ts";

/** "PACK", version 2, no objects, and the SHA-1 of those 12 bytes. */
const EMPTY_PACK = new Uint8Array([
  0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0, 0x02, 0x9d, 0x08, 0x82, 0x3b, 0xd8, 0xa8, 0xea,
  0xb5, 0x10, 0xad, 0x6a, 0xc7, 0x5c, 0x82, 0x3c, 0xfd, 0x3e, 0xd3, 0x1e,
]);

export interface RefWrite {
  ref: string;
  /** What the ref must hold now: null to create it. */
  old: string | null;
  /** What it should hold: null to delete it. */
  new: string | null;
}

export interface RefWriteResult {
  ref: string;
  ok: boolean;
  reason?: string;
}

/**
 * Create, move or delete refs pointing at commits the repository has. Each
 * write applies only if the ref still holds `old`. With `atomic` (Artifacts
 * offers it), they apply together or not at all.
 */
export async function writeRefs(
  env: Env,
  repo: { artifacts_name: string; artifacts_remote: string },
  writes: RefWrite[],
): Promise<RefWriteResult[]> {
  if (!writes.length) return [];
  const authorization = `Bearer ${await upstreamToken(env, repo.artifacts_name, "write")}`;
  const advertised = await fetch(`${repo.artifacts_remote}/info/refs?service=git-receive-pack`, {
    headers: { authorization },
  });
  if (!advertised.ok)
    throw new Error(`Artifacts refused to list refs for a push (HTTP ${advertised.status}).`);
  const { capabilities } = parseReceivePackAdvertisement(
    new Uint8Array(await advertised.arrayBuffer()),
  );
  const updates = writes.map((w) => ({
    ref: w.ref,
    old: w.old ?? ZERO_OID,
    new: w.new ?? ZERO_OID,
  }));
  const commands = receivePackCommands(updates, capabilities);
  let body = commands;
  if (needsPack(updates)) {
    body = new Uint8Array(commands.length + EMPTY_PACK.length);
    body.set(commands);
    body.set(EMPTY_PACK, commands.length);
  }
  const response = await fetch(`${repo.artifacts_remote}/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
    },
    body,
  });
  invalidateRefs(repo.artifacts_name);
  if (!response.ok) throw new Error(`Artifacts refused the ref update (HTTP ${response.status}).`);
  const report = parsePushReport(
    new Uint8Array(await response.arrayBuffer()),
    capabilities.has("side-band-64k"),
  );
  if (report.errors.length) throw new Error(`Artifacts: ${report.errors.join("; ")}`);
  if (report.unpack && report.unpack !== "ok")
    throw new Error(`Artifacts couldn't apply the ref update: ${report.unpack}`);
  return writes.map((write) => {
    const status = report.refs.find((r) => r.ref === write.ref);
    if (status?.ok) return { ref: write.ref, ok: true };
    return { ref: write.ref, ok: false, reason: status?.reason || "not reported" };
  });
}
