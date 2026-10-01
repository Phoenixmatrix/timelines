// Git pkt-line framing: a 4-hex-digit length (including itself) and a payload.
// https://git-scm.com/docs/protocol-common#_pkt_line_format

export const FLUSH = "0000";
export const DELIM = "0001";

export type PktLine = { type: "data"; data: Uint8Array } | { type: "flush" | "delim" | "end" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function pkt(line: string): string {
  const length = encoder.encode(line).length + 4;
  if (length > 65520) throw new Error("pkt-line too long");
  return length.toString(16).padStart(4, "0") + line;
}

export function* parsePktLines(bytes: Uint8Array): Generator<PktLine> {
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length)) throw new Error(`Bad pkt-line length at byte ${offset}`);
    if (length === 0) yield { type: "flush" };
    else if (length === 1) yield { type: "delim" };
    else if (length === 2) yield { type: "end" };
    else if (length < 4 || offset + length > bytes.length) {
      throw new Error(`Truncated pkt-line at byte ${offset}`);
    } else yield { type: "data", data: bytes.subarray(offset + 4, offset + length) };
    offset += length < 4 ? 4 : length;
  }
  if (offset !== bytes.length) throw new Error("Trailing bytes after the last pkt-line");
}

export interface LsRefsEntry {
  oid: string | null;
  name: string;
  symrefTarget?: string;
  peeled?: string;
}

/** Parse a protocol v2 `ls-refs` response, including `unborn HEAD` lines. */
export function parseLsRefs(bytes: Uint8Array): LsRefsEntry[] {
  const refs: LsRefsEntry[] = [];
  for (const line of parsePktLines(bytes)) {
    if (line.type !== "data") continue;
    const text = decoder.decode(line.data).replace(/\n$/, "");
    if (text.startsWith("ERR ")) throw new Error(`git: ${text.slice(4)}`);
    const [oid, name, ...attributes] = text.split(" ");
    if (!oid || !name) continue;
    const entry: LsRefsEntry = { oid: oid === "unborn" ? null : oid, name };
    for (const attribute of attributes) {
      if (attribute.startsWith("symref-target:")) entry.symrefTarget = attribute.slice(14);
      if (attribute.startsWith("peeled:")) entry.peeled = attribute.slice(7);
    }
    refs.push(entry);
  }
  return refs;
}

export function lsRefsRequest(): string {
  return (
    pkt("command=ls-refs\n") +
    pkt("agent=gitmatrix\n") +
    pkt("object-format=sha1\n") +
    DELIM +
    pkt("peel\n") +
    pkt("symrefs\n") +
    pkt("unborn\n") +
    pkt("ref-prefix HEAD\n") +
    pkt("ref-prefix refs/heads/\n") +
    pkt("ref-prefix refs/tags/\n") +
    FLUSH
  );
}
