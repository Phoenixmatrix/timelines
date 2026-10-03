// The git wire protocol a mirror needs, and nothing more: read the target's
// refs (receive-pack advertisement, protocol v0), plan the ref updates, fetch
// a pack from Artifacts (protocol v2 `fetch`), and read the target's report.
// https://git-scm.com/docs/http-protocol · https://git-scm.com/docs/protocol-v2

import { DELIM, FLUSH, parsePktLines, pkt, type PktLine } from "../git/pktline.ts";

export const ZERO_OID = "0".repeat(40);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The default branch (e.g. `refs/heads/main`) and tags are mirrored. Other
 * branches (timelines, experiments) stay here, as does everything else
 * (notes, PR refs, gm's own).
 */
export function isMirroredRef(name: string, defaultBranch: string | null): boolean {
  return name === defaultBranch || name.startsWith("refs/tags/");
}

export interface Advertisement {
  refs: Map<string, string>;
  capabilities: Set<string>;
}

/** `GET /info/refs?service=git-receive-pack` from a smart-HTTP server. */
export function parseReceivePackAdvertisement(bytes: Uint8Array): Advertisement {
  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  let first = true;
  for (const line of parsePktLines(bytes)) {
    if (line.type !== "data") continue;
    let text = decoder.decode(line.data).replace(/\n$/, "");
    if (text.startsWith("# service=")) continue;
    if (text.startsWith("ERR ")) throw new Error(`The mirror target refused: ${text.slice(4)}`);
    if (first) {
      const nul = text.indexOf("\0");
      if (nul !== -1) {
        for (const cap of text.slice(nul + 1).split(" ")) if (cap) capabilities.add(cap);
        text = text.slice(0, nul);
      }
      first = false;
    }
    const [oid, name] = text.split(" ");
    // An empty repository advertises only `capabilities^{}`; peeled tags end in ^{}.
    if (!oid || !name || name.endsWith("^{}") || oid === ZERO_OID) continue;
    refs.set(name, oid);
  }
  return { refs, capabilities };
}

export interface RefUpdate {
  ref: string;
  /** What the target has now (ZERO_OID to create). */
  old: string;
  /** What it should have (ZERO_OID to delete). */
  new: string;
}

/**
 * The commands that make the target's default branch and tags match the
 * source. Updates may rewind (a mirror follows force-pushes). Refs only the
 * target has are deleted only when `prune` is set, and only within that set:
 * a backup never loses data by default, and other branches already on the
 * target are left as they are.
 */
export function planMirror(
  source: Map<string, string>,
  target: Map<string, string>,
  defaultBranch: string | null,
  prune: boolean,
): RefUpdate[] {
  const updates: RefUpdate[] = [];
  for (const [ref, oid] of source) {
    if (!isMirroredRef(ref, defaultBranch)) continue;
    const current = target.get(ref) ?? ZERO_OID;
    if (current !== oid) updates.push({ ref, old: current, new: oid });
  }
  if (prune) {
    for (const [ref, oid] of target) {
      if (isMirroredRef(ref, defaultBranch) && !source.has(ref))
        updates.push({ ref, old: oid, new: ZERO_OID });
    }
  }
  return updates.sort((a, b) => a.ref.localeCompare(b.ref));
}

const PUSH_CAPABILITIES = ["report-status", "side-band-64k", "atomic", "quiet"];

/** The pkt-line command list that opens a receive-pack request. */
export function receivePackCommands(updates: RefUpdate[], offered: Set<string>): Uint8Array {
  const caps = PUSH_CAPABILITIES.filter((c) => offered.has(c));
  if (offered.has("agent") || [...offered].some((c) => c.startsWith("agent="))) {
    caps.push("agent=gitmatrix");
  }
  let text = "";
  updates.forEach((u, i) => {
    const line = `${u.old} ${u.new} ${u.ref}`;
    text += pkt(i === 0 ? `${line}\0${caps.join(" ")}\n` : `${line}\n`);
  });
  return encoder.encode(text + FLUSH);
}

/** Whether the target must receive a pack (anything but deletions). */
export function needsPack(updates: RefUpdate[]): boolean {
  return updates.some((u) => u.new !== ZERO_OID);
}

/**
 * A protocol v2 `fetch` for exactly the objects the target lacks: `want` the
 * new tips, `have` what the target already has (tips the source doesn't know
 * are ignored). `done` skips negotiation; no `thin-pack`, so the pack stands
 * on its own.
 */
export function fetchRequest(wants: string[], haves: string[], ofsDelta: boolean): string {
  let body =
    pkt("command=fetch\n") +
    pkt("agent=gitmatrix\n") +
    pkt("object-format=sha1\n") +
    DELIM +
    pkt("no-progress\n");
  if (ofsDelta) body += pkt("ofs-delta\n");
  for (const oid of new Set(wants)) body += pkt(`want ${oid}\n`);
  for (const oid of new Set(haves)) body += pkt(`have ${oid}\n`);
  return body + pkt("done\n") + FLUSH;
}

/** Pkt-lines from a byte stream, as they arrive. */
export async function* readPktLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<PktLine> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer);
    next.set(chunk, buffer.length);
    buffer = next;
  };
  try {
    for (;;) {
      while (buffer.length >= 4) {
        const length = Number.parseInt(decoder.decode(buffer.subarray(0, 4)), 16);
        if (Number.isNaN(length)) throw new Error("Bad pkt-line from the git server");
        if (length < 4) {
          yield { type: length === 0 ? "flush" : length === 1 ? "delim" : "end" };
          buffer = buffer.subarray(4);
          continue;
        }
        if (buffer.length < length) break;
        yield { type: "data", data: buffer.slice(4, length) };
        buffer = buffer.subarray(length);
      }
      const { done, value } = await reader.read();
      if (done) break;
      append(value);
    }
    if (buffer.length > 0) throw new Error("The git server's response ended mid-line");
  } finally {
    reader.releaseLock();
  }
}

/**
 * The pack inside a v2 fetch response: after the `packfile` section header,
 * side-band 1 carries pack bytes, 2 progress, 3 a fatal error.
 */
export async function* packFromFetchResponse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let inPack = false;
  for await (const line of readPktLines(stream)) {
    if (line.type !== "data") {
      if (inPack && line.type === "flush") return;
      continue;
    }
    if (!inPack) {
      const text = decoder.decode(line.data);
      if (text.startsWith("ERR ")) throw new Error(`Artifacts refused the fetch: ${text.slice(4)}`);
      if (text === "packfile\n") inPack = true;
      continue;
    }
    const band = line.data[0];
    if (band === 1) yield line.data.subarray(1);
    else if (band === 3) throw new Error(`Artifacts: ${decoder.decode(line.data.subarray(1))}`);
  }
  if (!inPack) throw new Error("Artifacts sent no pack");
}

export interface PushReport {
  unpack: string;
  refs: { ref: string; ok: boolean; reason?: string }[];
  /** Side-band 3 messages: a fatal error on the target. */
  errors: string[];
}

/** A receive-pack response with report-status, in side-band-64k or plain. */
export function parsePushReport(bytes: Uint8Array, sideband: boolean): PushReport {
  let status = bytes;
  const errors: string[] = [];
  if (sideband) {
    const parts: Uint8Array[] = [];
    for (const line of parsePktLines(bytes)) {
      if (line.type !== "data") continue;
      const band = line.data[0];
      if (band === 1) parts.push(line.data.subarray(1));
      else if (band === 3) errors.push(decoder.decode(line.data.subarray(1)).trim());
    }
    status = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      status.set(part, offset);
      offset += part.length;
    }
  }
  const report: PushReport = { unpack: "", refs: [], errors };
  if (status.length === 0) return report;
  for (const line of parsePktLines(status)) {
    if (line.type !== "data") continue;
    const text = decoder.decode(line.data).replace(/\n$/, "");
    if (text.startsWith("unpack ")) report.unpack = text.slice(7);
    else if (text.startsWith("ok ")) report.refs.push({ ref: text.slice(3), ok: true });
    else if (text.startsWith("ng ")) {
      const [ref = "", ...reason] = text.slice(3).split(" ");
      report.refs.push({ ref, ok: false, reason: reason.join(" ") });
    }
  }
  return report;
}
