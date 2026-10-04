import { describe, expect, test } from "vite-plus/test";
import { FLUSH, pkt } from "./pktline.ts";
import { readReceivePackCommands } from "./receive-pack.ts";

const encoder = new TextEncoder();
const a = "a".repeat(40);
const b = "b".repeat(40);

/** A stream delivering `bytes` in chunks of `size`. */
function chunked(bytes: Uint8Array, size: number) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

describe("readReceivePackCommands", () => {
  test("reads shallow lines and commands across chunks, then replays the whole body", async () => {
    const request = encoder.encode(
      pkt(`shallow ${a}\n`) +
        pkt(`${a} ${b} refs/heads/x\0report-status side-band-64k\n`) +
        pkt(`${b} ${a} refs/heads/y\n`) +
        FLUSH +
        "PACK and the rest",
    );
    for (const size of [1, 3, 7, request.length]) {
      const read = await readReceivePackCommands(chunked(request, size));
      expect(read.commands).toEqual([
        { old: a, new: b, ref: "refs/heads/x" },
        { old: b, new: a, ref: "refs/heads/y" },
      ]);
      expect(read.pushCert).toBe(false);
      expect(new Uint8Array(await new Response(read.body).arrayBuffer())).toEqual(request);
    }
  });

  test("an empty request (git's probe) has no commands", async () => {
    const read = await readReceivePackCommands(chunked(encoder.encode(FLUSH), 4));
    expect(read.commands).toEqual([]);
  });

  test("extracts only certified commands and replays the end marker and pack across chunks", async () => {
    const request = encoder.encode(
      pkt("push-cert\0report-status\n") +
        pkt("certificate version 0.1\n") +
        pkt("pusher Person <p@example.test> 123 +0000\n") +
        pkt("\n") +
        pkt(`${a} ${b} refs/heads/work\n`) +
        pkt("-----BEGIN PGP SIGNATURE-----\n") +
        pkt(`${b} ${a} refs/heads/not-a-command\n`) +
        pkt("-----END PGP SIGNATURE-----\n") +
        pkt("push-cert-end\n") +
        "PACK and the rest",
    );
    for (const size of [1, 5, request.length]) {
      const result = await readReceivePackCommands(chunked(request, size));
      expect(result.pushCert).toBe(true);
      expect(result.commands).toEqual([{ old: a, new: b, ref: "refs/heads/work" }]);
      expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(request);
    }
  });

  test("refuses what isn't a command list", async () => {
    const reject = (text: string) =>
      expect(readReceivePackCommands(chunked(encoder.encode(text), 3))).rejects.toThrow();
    await reject("");
    await reject(pkt(`${a} ${b} refs/heads/x\n`)); // no flush
    await reject(pkt("hello\n") + FLUSH);
    await reject(pkt(`${a} ${b}\n`) + FLUSH);
    await reject(pkt(`${a} ${b} refs/heads/x\n`) + pkt(`${a} ${b} refs/heads/y\0caps\n`) + FLUSH);
    await reject("zzzz");
    await reject(pkt("push-cert\0report-status\n") + pkt("certificate version 0.1\n"));
    await reject(pkt("push-cert\0report-status\n") + pkt("\n") + FLUSH);
    await reject(pkt("push-cert\0report-status\n") + pkt("\n") + pkt("not a command\n"));
    await reject(pkt(`${a} ${b} refs/heads/x\n`).repeat(2000));
  });
});
