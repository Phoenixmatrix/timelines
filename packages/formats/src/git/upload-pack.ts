import {
  concat,
  entryIsSubmodule,
  entryIsTree,
  inflate,
  isOid,
  parseCommit,
  parseTree,
  type Commit,
  type ObjType,
  type TreeEntry,
} from "./object.ts";
import { PackWriter } from "./pack.ts";
import { DELIM, errPkt, FLUSH, pkt, pktText, readPkts, sideband, type Pkt } from "./pktline.ts";

/**
 * The server half of git's smart protocol for a read-only repository
 * (`git-upload-pack`, protocol v0 over stateless HTTP and protocol v2). It
 * never deltifies: every response carries a complete pack of what the client
 * lacks, computed from the objects reachable from its wants minus those
 * reachable from the commits it already has.
 */

/** A stored object: its content is zlib-deflated without the loose header. */
export interface StoredObject {
  oid: string;
  type: ObjType;
  size: number;
  zdata: Uint8Array;
}

export interface GitRefs {
  /** Where HEAD points, e.g. `refs/heads/main`. */
  headTarget: string;
  /** Direct refs (no HEAD), sorted by name. */
  refs: { name: string; oid: string }[];
}

export class ProtocolError extends Error {}

export const ZERO_OID = "0".repeat(40);

/** An in-memory object database with lazily parsed commits and trees. */
export class ObjectGraph {
  private readonly objects = new Map<string, StoredObject>();
  private readonly commits = new Map<string, Commit>();
  private readonly trees = new Map<string, TreeEntry[]>();

  constructor(objects: Iterable<StoredObject> = []) {
    for (const object of objects) this.objects.set(object.oid, object);
  }

  add(object: StoredObject): void {
    this.objects.set(object.oid, object);
  }

  get(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  get size(): number {
    return this.objects.size;
  }

  isCommit(oid: string): boolean {
    return this.objects.get(oid)?.type === "commit";
  }

  commit(oid: string): Commit {
    let commit = this.commits.get(oid);
    if (!commit) {
      const object = this.objects.get(oid);
      if (object?.type !== "commit") throw new ProtocolError(`missing commit ${oid}`);
      commit = parseCommit(inflate(object.zdata));
      this.commits.set(oid, commit);
    }
    return commit;
  }

  tree(oid: string): TreeEntry[] {
    let entries = this.trees.get(oid);
    if (!entries) {
      const object = this.objects.get(oid);
      if (object?.type !== "tree") throw new ProtocolError(`missing tree ${oid}`);
      entries = parseTree(inflate(object.zdata));
      this.trees.set(oid, entries);
    }
    return entries;
  }

  /** Adds `treeOid` and everything below it to `out`, skipping what `seen` holds. */
  collectTree(treeOid: string, seen: Set<string>, out: string[]): void {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      out.push(oid);
      for (const entry of this.tree(oid)) {
        if (entryIsSubmodule(entry) || seen.has(entry.oid)) continue;
        if (entryIsTree(entry)) stack.push(entry.oid);
        else {
          seen.add(entry.oid);
          out.push(entry.oid);
        }
      }
    }
  }
}

export interface FetchPlan {
  /** Object ids to send, commits first. */
  objects: string[];
  shallow: string[];
  unshallow: string[];
}

/**
 * What to send for `wants` to a client holding `common` (and everything they
 * reach, cut at its `clientShallow` commits). `depth` limits history for
 * shallow clones (1 = just the wanted commits).
 */
export function planFetch(
  graph: ObjectGraph,
  input: {
    wants: readonly string[];
    common?: readonly string[];
    clientShallow?: readonly string[];
    depth?: number | null;
  },
): FetchPlan {
  const clientShallow = new Set(input.clientShallow ?? []);
  const depth = input.depth ?? null;

  const wantCommits: string[] = [];
  const boundary = new Set<string>();
  const seenWant = new Set<string>();
  if (depth !== null) {
    let frontier = [...new Set(input.wants)];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seenWant.has(oid) || !graph.isCommit(oid)) continue;
        seenWant.add(oid);
        wantCommits.push(oid);
        const parents = graph.commit(oid).parents.filter((p) => graph.isCommit(p));
        if (d === depth - 1) {
          if (parents.length > 0) boundary.add(oid);
        } else next.push(...parents);
      }
      frontier = next;
    }
  } else {
    const stack = [...input.wants];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seenWant.has(oid) || !graph.isCommit(oid)) continue;
      seenWant.add(oid);
      wantCommits.push(oid);
      if (!clientShallow.has(oid)) stack.push(...graph.commit(oid).parents);
    }
  }

  const haveCommits = new Set<string>();
  const stack = [...(input.common ?? [])];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (haveCommits.has(oid) || !graph.isCommit(oid)) continue;
    haveCommits.add(oid);
    if (!clientShallow.has(oid)) stack.push(...graph.commit(oid).parents);
  }

  const seen = new Set<string>();
  for (const oid of haveCommits) graph.collectTree(graph.commit(oid).tree, seen, []);

  const commits = wantCommits.filter((oid) => !haveCommits.has(oid));
  const rest: string[] = [];
  for (const oid of commits) graph.collectTree(graph.commit(oid).tree, seen, rest);

  return {
    objects: [...commits, ...rest],
    shallow: [...boundary].filter((oid) => !clientShallow.has(oid)),
    unshallow: [...clientShallow].filter((oid) => seenWant.has(oid) && !boundary.has(oid)),
  };
}

/** The complete pack for `oids`, as chunks. */
export function writePack(graph: ObjectGraph, oids: readonly string[]): Uint8Array[] {
  const writer = new PackWriter();
  writer.header(oids.length);
  for (const oid of oids) {
    const object = graph.get(oid);
    if (!object) throw new ProtocolError(`missing object ${oid}`);
    writer.addDeflated(object.type, object.size, object.zdata);
  }
  return writer.finish();
}

function headOid(refs: GitRefs): string | null {
  return refs.refs.find((r) => r.name === refs.headTarget)?.oid ?? null;
}

export function v0Capabilities(refs: GitRefs, agent: string): string {
  return [
    "multi_ack_detailed",
    "side-band-64k",
    "thin-pack",
    "ofs-delta",
    "shallow",
    "no-progress",
    "include-tag",
    `symref=HEAD:${refs.headTarget}`,
    `agent=${agent}`,
    "object-format=sha1",
  ].join(" ");
}

/** `info/refs?service=git-upload-pack` for protocol v0/v1 clients. */
export function advertiseV0(refs: GitRefs, agent = "gitmatrix"): Uint8Array {
  const caps = v0Capabilities(refs, agent);
  const lines: Uint8Array[] = [pkt("# service=git-upload-pack\n"), FLUSH];
  const head = headOid(refs);
  const all = head ? [{ name: "HEAD", oid: head }, ...refs.refs] : refs.refs;
  if (all.length === 0) lines.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  all.forEach((ref, i) => {
    lines.push(pkt(i === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`));
  });
  lines.push(FLUSH);
  return concat(lines);
}

/** `info/refs?service=git-upload-pack` with `Git-Protocol: version=2`. */
export function advertiseV2(agent = "gitmatrix"): Uint8Array {
  return concat([
    pkt("version 2\n"),
    pkt(`agent=${agent}\n`),
    pkt("ls-refs=unborn\n"),
    pkt("fetch=shallow\n"),
    pkt("server-option\n"),
    pkt("object-format=sha1\n"),
    FLUSH,
  ]);
}

export interface V2Request {
  command: string;
  capabilities: string[];
  args: string[];
}

export function parseV2Request(body: Uint8Array): V2Request {
  const pkts = readPkts(body);
  let i = 0;
  const first = pkts[i++];
  const firstLine = first ? pktText(first) : "";
  if (!firstLine.startsWith("command=")) throw new ProtocolError("expected a command");
  const request: V2Request = {
    command: firstLine.slice("command=".length),
    capabilities: [],
    args: [],
  };
  for (; i < pkts.length; i++) {
    const p = pkts[i]!;
    if (p.type === "delim") {
      i++;
      break;
    }
    if (p.type === "flush") return request;
    request.capabilities.push(pktText(p));
  }
  for (; i < pkts.length; i++) {
    const p = pkts[i]!;
    if (p.type === "flush") break;
    if (p.type === "data") request.args.push(pktText(p));
  }
  return request;
}

function lsRefs(request: V2Request, refs: GitRefs): Uint8Array[] {
  const prefixes = request.args
    .filter((a) => a.startsWith("ref-prefix "))
    .map((a) => a.slice("ref-prefix ".length));
  const symrefs = request.args.includes("symrefs");
  const unborn = request.args.includes("unborn");
  const matches = (name: string) =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Uint8Array[] = [];
  if (matches("HEAD")) {
    const head = headOid(refs);
    const target = symrefs ? ` symref-target:${refs.headTarget}` : "";
    if (head) out.push(pkt(`${head} HEAD${target}\n`));
    else if (unborn) out.push(pkt(`unborn HEAD${target}\n`));
  }
  for (const ref of refs.refs) {
    if (matches(ref.name)) out.push(pkt(`${ref.oid} ${ref.name}\n`));
  }
  out.push(FLUSH);
  return out;
}

function parseDepth(value: string): number {
  const depth = Number(value);
  if (!Number.isInteger(depth) || depth <= 0) throw new ProtocolError(`invalid deepen ${value}`);
  return depth;
}

function requireOid(value: string): string {
  if (!isOid(value)) throw new ProtocolError(`invalid object id ${value}`);
  return value;
}

function checkWants(graph: ObjectGraph, wants: readonly string[]): void {
  for (const want of wants) {
    if (!graph.isCommit(want)) throw new ProtocolError(`upload-pack: not our ref ${want}`);
  }
}

function fetchV2(request: V2Request, graph: ObjectGraph): Uint8Array[] {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let done = false;
  let waitForDone = false;
  let depth: number | null = null;
  for (const arg of request.args) {
    const sp = arg.indexOf(" ");
    const key = sp === -1 ? arg : arg.slice(0, sp);
    const value = sp === -1 ? "" : arg.slice(sp + 1);
    switch (key) {
      case "want":
        wants.push(requireOid(value));
        break;
      case "have":
        haves.push(requireOid(value));
        break;
      case "shallow":
        clientShallow.push(requireOid(value));
        break;
      case "deepen":
        depth = parseDepth(value);
        break;
      case "done":
        done = true;
        break;
      case "wait-for-done":
        waitForDone = true;
        break;
      case "thin-pack":
      case "no-progress":
      case "include-tag":
      case "ofs-delta":
        break;
      default:
        throw new ProtocolError(`unsupported fetch argument ${key}`);
    }
  }
  if (wants.length === 0) throw new ProtocolError("fetch needs at least one want");
  checkWants(graph, wants);
  const common = haves.filter((oid) => graph.isCommit(oid));

  const out: Uint8Array[] = [];
  if (!done) {
    out.push(pkt("acknowledgments\n"));
    if (common.length === 0) out.push(pkt("NAK\n"));
    for (const oid of common) out.push(pkt(`ACK ${oid}\n`));
    if (waitForDone) {
      out.push(FLUSH);
      return out;
    }
    out.push(pkt("ready\n"), DELIM);
  }
  const plan = planFetch(graph, { wants, common, clientShallow, depth });
  if (depth !== null || clientShallow.length > 0) {
    out.push(pkt("shallow-info\n"));
    for (const oid of plan.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(DELIM);
  }
  out.push(pkt("packfile\n"));
  for (const chunk of writePack(graph, plan.objects)) out.push(...sideband(1, chunk));
  out.push(FLUSH);
  return out;
}

/** Answers a protocol v2 `git-upload-pack` POST (ls-refs or fetch). */
export function handleV2(body: Uint8Array, graph: ObjectGraph, refs: GitRefs): Uint8Array[] {
  try {
    const request = parseV2Request(body);
    if (request.command === "ls-refs") return lsRefs(request, refs);
    if (request.command === "fetch") return fetchV2(request, graph);
    throw new ProtocolError(`unknown command ${request.command}`);
  } catch (error) {
    return [errPkt(errorMessage(error))];
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ProtocolError) return error.message;
  if (error instanceof Error) return `upload-pack: ${error.message}`;
  return "upload-pack: internal error";
}

interface V0Request {
  wants: string[];
  capabilities: Set<string>;
  clientShallow: string[];
  depth: number | null;
  rest: Pkt[];
}

function parseV0Request(body: Uint8Array): V0Request {
  const pkts = readPkts(body);
  const request: V0Request = {
    wants: [],
    capabilities: new Set(),
    clientShallow: [],
    depth: null,
    rest: [],
  };
  let i = 0;
  for (; i < pkts.length; i++) {
    const p = pkts[i]!;
    if (p.type === "flush") {
      i++;
      break;
    }
    const line = pktText(p);
    if (line.startsWith("want ")) {
      const [oid, ...caps] = line.slice(5).split(" ");
      request.wants.push(requireOid(oid ?? ""));
      if (request.wants.length === 1) for (const cap of caps) request.capabilities.add(cap);
    } else if (line.startsWith("shallow ")) request.clientShallow.push(requireOid(line.slice(8)));
    else if (line.startsWith("deepen ")) request.depth = parseDepth(line.slice(7));
    else if (line.startsWith("deepen-") || line.startsWith("filter "))
      throw new ProtocolError(`unsupported request ${line.split(" ")[0]}`);
    else throw new ProtocolError(`protocol error: unexpected '${line}'`);
  }
  request.rest = pkts.slice(i);
  return request;
}

/**
 * Answers a protocol v0 `git-upload-pack` POST the way `upload-pack
 * --stateless-rpc` does: shallow list, then ACK/NAK for the have lines, and a
 * pack once the client says `done`.
 */
export function handleV0(body: Uint8Array, graph: ObjectGraph): Uint8Array[] {
  let request: V0Request;
  try {
    request = parseV0Request(body);
    checkWants(graph, request.wants);
  } catch (error) {
    return [errPkt(errorMessage(error))];
  }
  if (request.wants.length === 0) return [];
  const caps = request.capabilities;
  const detailed = caps.has("multi_ack_detailed");
  const multiAck = detailed || caps.has("multi_ack");
  const out: Uint8Array[] = [];

  const plan = (common: string[]) =>
    planFetch(graph, {
      wants: request.wants,
      common,
      clientShallow: request.clientShallow,
      depth: request.depth,
    });

  if (request.depth !== null) {
    const shallow = plan([]);
    for (const oid of shallow.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of shallow.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(FLUSH);
  }

  const common: string[] = [];
  let sentReady = false;
  for (const p of request.rest) {
    if (p.type === "flush") {
      const last = common.at(-1);
      if (detailed && last && !sentReady) out.push(pkt(`ACK ${last} ready\n`));
      if (common.length === 0 || multiAck) out.push(pkt("NAK\n"));
      return out;
    }
    const line = pktText(p);
    if (line.startsWith("have ")) {
      const oid = line.slice(5);
      if (graph.isCommit(oid)) {
        common.push(oid);
        if (detailed) out.push(pkt(`ACK ${oid} common\n`));
        else if (multiAck) out.push(pkt(`ACK ${oid} continue\n`));
        else if (common.length === 1) out.push(pkt(`ACK ${oid}\n`));
      } else {
        if (multiAck && common.length > 0) {
          if (detailed) {
            sentReady = true;
            out.push(pkt(`ACK ${oid} ready\n`));
          } else out.push(pkt(`ACK ${oid} continue\n`));
        }
      }
      continue;
    }
    if (line === "done") {
      const last = common.at(-1);
      if (last) {
        if (multiAck) out.push(pkt(`ACK ${last}\n`));
      } else out.push(pkt("NAK\n"));
      const pack = concat(writePack(graph, plan(common).objects));
      if (caps.has("side-band-64k")) out.push(...sideband(1, pack), FLUSH);
      else if (caps.has("side-band")) out.push(...sideband(1, pack, 1000), FLUSH);
      else out.push(pack);
      return out;
    }
    out.push(errPkt(`protocol error: expected have or done, got '${line}'`));
    return out;
  }
  return out;
}
