// The command list that opens a receive-pack request (a push), read off the
// front of the request body so the proxy can decide on it before the rest
// (the pack) streams upstream untouched.
// https://git-scm.com/docs/pack-protocol#_reference_update_request_and_packfile_transfer
//
//   update-requests = *shallow ( command-list | push-cert )
//   command-list    = PKT-LINE(command NUL capability-list) *PKT-LINE(command) flush-pkt
//   command         = old-id SP new-id SP name

import { parsePktLines } from "./pktline.ts";

export interface ReceiveCommand {
  old: string;
  new: string;
  ref: string;
}

export interface ReceivePackRequest {
  commands: ReceiveCommand[];
  capabilities: string[];
  /** A signed push; commands are extracted for routing, never signature validation. */
  pushCert: boolean;
  /** The whole request again, the bytes already read first, to send on. */
  body: ReadableStream<Uint8Array>;
}

/** Bound command/certificate inspection before streaming the remaining pack. */
const MAX_COMMANDS_BYTES = 64 * 1024;
const COMMAND = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/;

const decoder = new TextDecoder();

/**
 * Read shallow lines and commands through their flush, or a signed certificate
 * through its push-cert-end marker. An empty `0000` probe has no commands.
 * Throws on anything malformed.
 */
export async function readReceivePackCommands(
  stream: ReadableStream<Uint8Array>,
): Promise<ReceivePackRequest> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let offset = 0;
  let ended = false;
  const commands: ReceiveCommand[] = [];
  let capabilities: string[] = [];
  let pushCert = false;
  let certificate: "headers" | "commands" | "signature" | null = null;

  /** Make sure `n` bytes past `offset` are buffered; false once the body ends first. */
  const want = async (n: number) => {
    while (buffer.length - offset < n) {
      if (ended) return false;
      if (buffer.length > MAX_COMMANDS_BYTES)
        throw new Error("The push's command list is too long");
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        continue;
      }
      const next = new Uint8Array(buffer.length + value.length);
      next.set(buffer);
      next.set(value, buffer.length);
      buffer = next;
    }
    return true;
  };

  try {
    for (;;) {
      if (!(await want(4))) throw new Error("The push ended before its command list did");
      const hex = decoder.decode(buffer.subarray(offset, offset + 4));
      if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error("Bad pkt-line length in the push");
      const length = Number.parseInt(hex, 16);
      if (length === 0) {
        if (pushCert) throw new Error("The push certificate ended before its end marker");
        offset += 4;
        break;
      }
      if (length < 4) throw new Error("Unexpected special pkt-line in the push's command list");
      if (!(await want(length))) throw new Error("The push ended mid-line");
      let text = decoder.decode(buffer.subarray(offset + 4, offset + length)).replace(/\n$/, "");
      offset += length;
      if (offset > MAX_COMMANDS_BYTES) throw new Error("The push's command list is too long");
      if (certificate) {
        if (text === "push-cert-end") {
          if (certificate !== "signature") throw new Error("Missing push certificate signature");
          break;
        }
        if (certificate === "headers") {
          if (text === "") certificate = "commands";
          continue;
        }
        if (certificate === "signature") continue;
        if (text.startsWith("-----BEGIN ") && text.endsWith(" SIGNATURE-----")) {
          certificate = "signature";
          continue;
        }
        const match = COMMAND.exec(text);
        if (!match) throw new Error("Malformed certified command in the push");
        commands.push({ old: match[1]!, new: match[2]!, ref: match[3]! });
        continue;
      }
      if (!commands.length && text.startsWith("shallow ")) continue;
      if (!commands.length && text.startsWith("push-cert\0")) {
        pushCert = true;
        certificate = "headers";
        continue;
      }
      const nul = text.indexOf("\0");
      if (nul !== -1) {
        if (commands.length) throw new Error("Capabilities after the first command");
        capabilities = text.slice(nul + 1).split(" ");
        text = text.slice(0, nul);
      }
      const match = COMMAND.exec(text);
      if (!match) {
        throw new Error("Malformed command in the push");
      }
      commands.push({ old: match[1]!, new: match[2]!, ref: match[3]! });
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }

  const head = buffer;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length) controller.enqueue(head);
      if (ended) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { commands, capabilities, pushCert, body };
}

/**
 * A complete, negotiated report is evidence; an HTTP status or an observed old
 * ref is not. v2 rewrites must still describe exactly the admitted update.
 */
export function receivePackReport(bytes: Uint8Array, request: ReceivePackRequest) {
  const v2 = request.capabilities.includes("report-status-v2");
  if (!v2 && !request.capabilities.includes("report-status"))
    throw new Error("Missing receive-pack report-status negotiation.");
  if (request.capabilities.includes("side-band-64k")) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let flushed = false;
    for (const line of parsePktLines(bytes)) {
      if (flushed) throw new Error("Data after receive-pack sideband flush.");
      if (line.type === "flush") {
        flushed = true;
        continue;
      }
      if (line.type !== "data" || !line.data.length)
        throw new Error("Invalid receive-pack sideband packet.");
      const channel = line.data[0];
      if (channel === 2) continue;
      if (channel !== 1) throw new Error("Receive-pack sideband failure.");
      const payload = line.data.subarray(1);
      chunks.push(payload);
      size += payload.length;
    }
    if (!flushed) throw new Error("Incomplete receive-pack sideband.");
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  const statuses = new Map<string, "ok" | "ng">();
  const commands = new Map(request.commands.map((command) => [command.ref, command]));
  let unpack: string | undefined;
  let flushed = false;
  let current: ReceiveCommand | undefined;
  const options = new Set<string>();
  for (const line of parsePktLines(bytes)) {
    if (flushed) throw new Error("Data after receive-pack report flush.");
    if (line.type === "flush") {
      flushed = true;
      continue;
    }
    if (line.type !== "data") throw new Error("Invalid receive-pack report packet.");
    const text = decoder.decode(line.data).replace(/\n$/, "");
    if (/[\0\n\r]/.test(text)) throw new Error("Invalid receive-pack report line.");
    if (unpack === undefined) {
      if (!text.startsWith("unpack ") || text.length === 7)
        throw new Error("Missing receive-pack unpack result.");
      unpack = text.slice(7);
      continue;
    }
    if (text.startsWith("option ")) {
      if (!v2 || !current || statuses.get(current.ref) !== "ok")
        throw new Error("Unexpected receive-pack report option.");
      const [, name, value, extra] = text.split(" ");
      if (!name || options.has(name) || extra !== undefined)
        throw new Error("Invalid receive-pack report option.");
      options.add(name);
      if (
        !(
          (name === "refname" && value === current.ref) ||
          (name === "old-oid" && value === current.old) ||
          (name === "new-oid" && value === current.new) ||
          (name === "forced-update" && value === undefined)
        )
      )
        throw new Error("Receive-pack report does not describe the admitted update.");
      continue;
    }
    const match = /^(ok) (\S+)$|^(ng) (\S+) (.+)$/.exec(text);
    const status = match?.[1] ?? match?.[3];
    const ref = match?.[2] ?? match?.[4];
    if (!ref || (status !== "ok" && status !== "ng") || statuses.has(ref))
      throw new Error("Invalid or duplicate receive-pack ref result.");
    current = commands.get(ref);
    if (!current) throw new Error("Unexpected receive-pack ref result.");
    if (unpack !== "ok" && status === "ok")
      throw new Error("Contradictory receive-pack unpack result.");
    statuses.set(ref, status);
    options.clear();
  }
  if (!flushed || unpack === undefined || statuses.size !== commands.size)
    throw new Error("Incomplete receive-pack report.");
  return statuses;
}
