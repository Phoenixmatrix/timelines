// Test helpers: Artifacts git remotes in memory, answering the requests the
// Worker makes itself (ls-refs, an empty-object fetch, receive-pack ref
// writes), and an Artifacts binding that mints tokens and knows commits.

import { FLUSH, pkt } from "../git/pktline.ts";
import { ZERO_OID } from "../mirror/protocol.ts";
import { packCommits } from "../git/pack.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FakeRemote {
  refs: Map<string, string>;
  head: string;
  /** Commits retained by this repository, copied independently on fork. */
  commits: Set<string>;
  /** Unlisted fixture commits are roots; callers can supply a real DAG. */
  parents: Map<string, string[]>;
  tokens: Map<string, { id: string; plaintext: string; expiresAt: string }>;
  isolated: boolean;
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
  /**
   * Trees, content-addressed like git's, so shared by every repository: a
   * commit's root tree (the empty tree when unlisted) and each tree's entries.
   */
  const treeOf = new Map<string, string>();
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  const names = new Map<string, string>();
  const add = (
    url: string,
    refs: Record<string, string>,
    head = "refs/heads/main",
    name?: string,
  ) => {
    const parsed = new URL(url);
    const remote: FakeRemote = {
      refs: new Map(Object.entries(refs)),
      head,
      pushes: [],
      commits: new Set(Object.values(refs)),
      parents: new Map(),
      tokens: new Map(),
      isolated: false,
    };
    names.set(
      name ?? (parsed.pathname.split("/").filter(Boolean).at(-1) || `r-${parsed.hostname}`),
      url,
    );
    for (const oid of Object.values(refs)) commits.add(oid);
    remotes.set(url, remote);
    return remote;
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = input instanceof Request ? input.url : String(input);
    const url = [...remotes.keys()]
      .filter((base) => href.startsWith(`${base}/`))
      .sort((a, b) => b.length - a.length)[0];
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
      let unpack = "ok";
      if (pack === "other") {
        const received = await packCommits(rest);
        const count =
          rest.length >= 12
            ? new DataView(rest.buffer, rest.byteOffset, rest.byteLength).getUint32(8)
            : -1;
        if (received.length !== count) unpack = "eof";
        else
          for (const commit of received) {
            remote.commits.add(commit.oid);
            commits.add(commit.oid);
            remote.parents.set(commit.oid, commit.parents);
          }
      }
      const updates = commands.map((command) => {
        const [old, next, ref] = command.split(" ") as [string, string, string];
        return { old, next, ref };
      });
      const reason = (u: (typeof updates)[number]) => {
        if (remote.refuse) return remote.refuse;
        if ((remote.refs.get(u.ref) ?? ZERO_OID) !== u.old) return "stale info";
        if (u.next !== ZERO_OID && !(remote.isolated ? remote.commits : commits).has(u.next))
          return "missing necessary objects";
        return null;
      };
      const failed = updates.map(reason);
      if (updates.some((u) => u.next !== ZERO_OID) && pack === "none") unpack = "eof";
      // Atomic: all of them or none.
      const ok = unpack === "ok" && failed.every((f) => f === null);
      if (ok)
        for (const u of updates)
          if (u.next === ZERO_OID) remote.refs.delete(u.ref);
          else {
            remote.refs.set(u.ref, u.next);
            remote.commits.add(u.next);
          }
      let report = pkt(`unpack ${unpack}\n`);
      for (const [i, u] of updates.entries())
        report += ok
          ? pkt(`ok ${u.ref}\n`)
          : pkt(`ng ${u.ref} ${failed[i] ?? "atomic push failed"}\n`);
      return new Response(sideband(1, report + FLUSH) + FLUSH);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  const getByName = (name: string): FakeRemote => {
    const url = names.get(name);
    const remote = url ? remotes.get(url) : undefined;
    if (!remote)
      throw Object.assign(new Error(`No Artifacts repository ${name}`), { code: "NOT_FOUND" });
    return remote;
  };
  const artifacts = {
    delete: async (name: string) => {
      const url = names.get(name);
      if (!url || !remotes.has(url))
        throw Object.assign(new Error("Repository is already gone"), { code: "NOT_FOUND" });
      remotes.delete(url);
      names.delete(name);
    },
    get: async (name?: string) => {
      const url = name ? names.get(name) : undefined;
      const remote = url ? remotes.get(url) : undefined;
      if (name && !remote)
        throw Object.assign(new Error(`No Artifacts repository ${name}`), { code: "NOT_FOUND" });
      return {
        info: async () => ({ remote: url }),
        fork: async (newName: string, options: { readOnly: boolean }) => {
          if (!remote || !url) throw new Error("Fork requires a named source repository");
          if (names.has(newName))
            throw Object.assign(new Error(`Artifacts repository ${newName} exists`), {
              code: "ALREADY_EXISTS",
            });
          const destination = new URL(`forks/${encodeURIComponent(newName)}`, `${url}/`).href;
          const fork = add(destination, Object.fromEntries(remote.refs), remote.head, newName);
          fork.commits = new Set([...remote.commits, ...remote.refs.values()]);
          fork.parents = new Map([...remote.parents].map(([oid, parents]) => [oid, [...parents]]));
          fork.isolated = true;
          if (options.readOnly) fork.refuse = "read-only";
          const id = crypto.randomUUID();
          fork.tokens.set(id, {
            id,
            plaintext: `artifacts-${id}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
          return { remote: destination };
        },
        createToken: async () => {
          const id = crypto.randomUUID();
          const token = {
            id,
            plaintext: `artifacts-${id}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          };
          remote?.tokens.set(id, token);
          return token;
        },
        listTokens: async () => ({ tokens: [...(remote?.tokens.values() ?? [])] }),
        revokeToken: async (id: string) => {
          if (!remote?.tokens.delete(id)) throw new Error(`Unknown token ${id}`);
        },
        readCommit: async (hash: string) =>
          (
            remote
              ? remote.commits.has(hash) || [...remote.refs.values()].includes(hash)
              : commits.has(hash)
          )
            ? {
                hash,
                treeHash: treeOf.get(hash) ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
                parents: [...(remote?.parents.get(hash) ?? [])],
                message: "Fixture commit",
                // Whole metadata, as the binding returns it (CORE-382).
                author: { name: "Fixture Author", email: "author@example.com" },
                committer: { name: "Fixture Author", email: "author@example.com" },
                authoredAt: 1_790_000_000,
                committedAt: 1_790_000_000,
              }
            : null,
        readTree: async (hash?: string): Promise<ArtifactsTreeEntry[]> =>
          (hash && trees.get(hash)) || [],
        [Symbol.dispose]() {},
      };
    },
  };
  return { remotes, commits, add, getByName, fetch, artifacts, treeOf, trees };
}
