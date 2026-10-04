// The command list that opens a receive-pack request (a push), read off the
// front of the request body so the proxy can decide on it before the rest
// (the pack) streams upstream untouched.
// https://git-scm.com/docs/pack-protocol#_reference_update_request_and_packfile_transfer
//
//   update-requests = *shallow ( command-list | push-cert )
//   command-list    = PKT-LINE(command NUL capability-list) *PKT-LINE(command) flush-pkt
//   command         = old-id SP new-id SP name

export interface ReceiveCommand {
  old: string;
  new: string;
  ref: string;
}

export interface ReceivePackRequest {
  commands: ReceiveCommand[];
  /** A signed push (`push-cert`): its commands sit inside the certificate, not read here. */
  pushCert: boolean;
  /** The whole request again, the bytes already read first, to send on. */
  body: ReadableStream<Uint8Array>;
}

/** More than any command list a landing sends; a body that keeps going without a flush is refused. */
const MAX_COMMANDS_BYTES = 64 * 1024;
const COMMAND = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/;

const decoder = new TextDecoder();

/**
 * Read the shallow lines and commands up to the flush that ends them. An
 * empty request (git's `0000` probe before a large push) has no commands.
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
  let pushCert = false;

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
        offset += 4;
        break;
      }
      if (length < 4) throw new Error("Unexpected special pkt-line in the push's command list");
      if (!(await want(length))) throw new Error("The push ended mid-line");
      let text = decoder.decode(buffer.subarray(offset + 4, offset + length)).replace(/\n$/, "");
      offset += length;
      if (!commands.length && text.startsWith("shallow ")) continue;
      if (!commands.length && text.startsWith("push-cert")) {
        // Its commands are inside the certificate; nothing that takes one reads further.
        pushCert = true;
        break;
      }
      const nul = text.indexOf("\0");
      if (nul !== -1) {
        if (commands.length) throw new Error("Capabilities after the first command");
        text = text.slice(0, nul);
      }
      const match = COMMAND.exec(text);
      if (!match) throw new Error("Malformed command in the push");
      commands.push({ old: match[1]!, new: match[2]!, ref: match[3]! });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
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
  return { commands, pushCert, body };
}
