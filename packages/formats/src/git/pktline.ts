import { concat, dec, enc } from "./object.ts";

/** pkt-line framing (gitprotocol-common). */
export const FLUSH = enc.encode("0000");
export const DELIM = enc.encode("0001");
export const RESPONSE_END = enc.encode("0002");

/** Largest pkt-line including its 4-byte length. */
export const MAX_PKT = 65520;

export function pkt(line: string | Uint8Array): Uint8Array {
  const body = typeof line === "string" ? enc.encode(line) : line;
  const len = body.length + 4;
  if (len > MAX_PKT) throw new Error(`pkt-line too long (${len})`);
  return concat([enc.encode(len.toString(16).padStart(4, "0")), body]);
}

export type Pkt =
  | { type: "flush" }
  | { type: "delim" }
  | { type: "end" }
  | { type: "data"; data: Uint8Array };

/** Parses every pkt-line in `buf`. Throws on malformed framing. */
export function readPkts(buf: Uint8Array): Pkt[] {
  const pkts: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error("truncated pkt-line");
    const hex = dec.decode(buf.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error(`bad pkt-line length at ${offset}`);
    const len = Number.parseInt(hex, 16);
    if (len === 0) pkts.push({ type: "flush" });
    else if (len === 1) pkts.push({ type: "delim" });
    else if (len === 2) pkts.push({ type: "end" });
    else if (len < 4) throw new Error(`bad pkt-line length ${len}`);
    else {
      if (offset + len > buf.length) throw new Error("truncated pkt-line");
      pkts.push({ type: "data", data: buf.subarray(offset + 4, offset + len) });
      offset += len;
      continue;
    }
    offset += 4;
  }
  return pkts;
}

/** A data pkt's text without its trailing newline ("" for special packets). */
export function pktText(p: Pkt): string {
  if (p.type !== "data") return "";
  const s = dec.decode(p.data);
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/** Side-band framing: payload split into pkts on `band` (1 data, 2 progress, 3 error). */
export function sideband(band: 1 | 2 | 3, data: Uint8Array, maxPkt = MAX_PKT): Uint8Array[] {
  const room = maxPkt - 5;
  const out: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += room) {
    const chunk = data.subarray(at, Math.min(at + room, data.length));
    const body = new Uint8Array(chunk.length + 1);
    body[0] = band;
    body.set(chunk, 1);
    out.push(pkt(body));
  }
  return out;
}

/** An `ERR` packet, which git prints as `remote error: <message>`. */
export function errPkt(message: string): Uint8Array {
  return pkt(`ERR ${message}\n`);
}
