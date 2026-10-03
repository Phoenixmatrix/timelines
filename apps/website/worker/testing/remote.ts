// Test helpers: Artifacts git remotes in memory, answering the requests the
// Worker makes itself (ls-refs, an empty-object fetch, receive-pack ref
// writes), and an Artifacts binding that mints tokens and knows commits.

import { FLUSH, pkt } from "../git/pktline.ts";
import { ZERO_OID } from "../mirror/protocol.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FakeRemote {
  refs: Map<string, string>;
  head: string;
  /** Every receive-pack: its commands, and whether an empty pack followed them. */
  pushes: { commands: string[]; pack: "none" | "empty" | "other" }[];
  /** Refuse every receive-pack with this reason. */
  refuse?: string;
}

function sideband(band: number, text: string): string {
  return pkt(String.fromCharCode(band) + text);
}

export function fakeRemotes() {
  const remotes = new Map<string, FakeRemote>();
  const commits = new Set<string>();
  const add = (url: string, refs: Record<string, string>, head = "refs/heads/main") => {
    const remote: FakeRemote = { refs: new Map(Object.entries(refs)), head, pushes: [] };
    for (const oid of Object.values(refs)) commits.add(oid);
    remotes.set(url, remote);
    return remote;
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = input instanceof Request ? input.url : String(input);
    const url = [...remotes.keys()].find((base) => href.startsWith(`${base}/`));
    if (!url) throw new Error(`Unexpected fetch: ${href}`);
    const remote = remotes.get(url)!;
    const path = href.slice(url.length);
    const body =
      init?.body instanceof Uint8Array
        ? init.body
        : typeof init?.body === "string"
          ? encoder.encode(init.body)
          : new Uint8Array();
    if (path === "/git-upload-pack" && decoder.decode(body).includes("command=ls-refs")) {
      const head = remote.refs.get(remote.head);
      let text = head ? pkt(`${head} HEAD symref-target:${remote.head}\n`) : "";
      for (const [ref, oid] of remote.refs) text += pkt(`${oid} ${ref}\n`);
      return new Response(text + FLUSH);
    }
    // A fetch of new commits: none here, so no pack.
    if (path === "/git-upload-pack") return new Response(FLUSH);
    if (path === "/info/refs?service=git-receive-pack") {
      const caps = "report-status delete-refs side-band-64k atomic quiet ofs-delta agent=fake";
      const refs = [...remote.refs];
      let text = pkt("# service=git-receive-pack\n") + FLUSH;
      text += refs.length
        ? refs.map(([ref, oid], i) => pkt(`${oid} ${ref}${i ? "" : `\0${caps}`}\n`)).join("")
        : pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`);
      return new Response(text + FLUSH);
    }
    if (path === "/git-receive-pack") {
      const commands: string[] = [];
      let offset = 0;
      for (;;) {
        const length = Number.parseInt(decoder.decode(body.subarray(offset, offset + 4)), 16);
        offset += 4;
        if (length === 0) break;
        commands.push(
          decoder.decode(body.subarray(offset, offset + length - 4)).split(/[\0\n]/)[0]!,
        );
        offset += length - 4;
      }
      const rest = body.subarray(offset);
      const pack =
        rest.length === 0
          ? "none"
          : rest.length === 32 && decoder.decode(rest.subarray(0, 4)) === "PACK"
            ? "empty"
            : "other";
      remote.pushes.push({ commands, pack });
      const updates = commands.map((command) => {
        const [old, next, ref] = command.split(" ") as [string, string, string];
        return { old, next, ref };
      });
      const reason = (u: (typeof updates)[number]) => {
        if (remote.refuse) return remote.refuse;
        if ((remote.refs.get(u.ref) ?? ZERO_OID) !== u.old) return "stale info";
        if (u.next !== ZERO_OID && !commits.has(u.next)) return "missing necessary objects";
        return null;
      };
      const failed = updates.map(reason);
      const unpack = updates.some((u) => u.next !== ZERO_OID) && pack !== "empty" ? "eof" : "ok";
      // Atomic: all of them or none.
      const ok = unpack === "ok" && failed.every((f) => f === null);
      if (ok)
        for (const u of updates)
          if (u.next === ZERO_OID) remote.refs.delete(u.ref);
          else remote.refs.set(u.ref, u.next);
      let report = pkt(`unpack ${unpack}\n`);
      for (const [i, u] of updates.entries())
        report += ok
          ? pkt(`ok ${u.ref}\n`)
          : pkt(`ng ${u.ref} ${failed[i] ?? "atomic push failed"}\n`);
      return new Response(sideband(1, report + FLUSH) + FLUSH);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  const artifacts = {
    get: async () => ({
      createToken: async () => ({
        id: "token",
        plaintext: "artifacts-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      readCommit: async (hash: string) => (commits.has(hash) ? { hash } : null),
      [Symbol.dispose]() {},
    }),
  };
  return { remotes, commits, add, fetch, artifacts };
}
