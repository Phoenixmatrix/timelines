import { expect, test } from "vite-plus/test";
import { pkt, FLUSH, parsePktLines } from "./pktline.ts";
import { uploadCommand, workAdvertisement } from "./source-protocol.ts";
import { readReceivePackCommands } from "./receive-pack.ts";

test("work advertisement replaces inherited HEAD and removes every inherited ref", () => {
  const old = "1".repeat(40),
    tip = "2".repeat(40);
  const input =
    pkt("# service=git-upload-pack\n") +
    FLUSH +
    pkt(`${old} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`) +
    pkt(`${old} refs/heads/main\n`) +
    pkt(`${tip} refs/heads/work\n`) +
    FLUSH;
  const output = [
    ...parsePktLines(workAdvertisement(new TextEncoder().encode(input), tip)),
  ].flatMap((line) => (line.type === "data" ? [new TextDecoder().decode(line.data)] : []));
  expect(output).toEqual([
    "# service=git-upload-pack\n",
    `${tip} HEAD\0multi_ack symref=HEAD:refs/heads/work\n`,
    `${tip} refs/heads/work\n`,
  ]);
});

test("fragmented fetch command inspection preserves all negotiation bytes", async () => {
  const input = new TextEncoder().encode(
    pkt("command=fetch\n") + "0001" + pkt("want " + "a".repeat(40) + "\n") + FLUSH,
  );
  let position = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === input.length) {
        controller.close();
        return;
      }
      controller.enqueue(input.slice(position, ++position));
    },
  });
  const inspected = await uploadCommand(stream);
  expect(inspected.command).toBe("command=fetch");
  expect(new Uint8Array(await new Response(inspected.body).arrayBuffer())).toEqual(input);
});

test("signed receive-pack exposes certified refs to lifecycle admission without changing bytes", async () => {
  const old = "1".repeat(40),
    next = "2".repeat(40);
  const text =
    pkt("push-cert\0report-status\n") +
    pkt("certificate version 0.1\n") +
    pkt("pusher Person <p@example.test>\n") +
    pkt("\n") +
    pkt(`${old} ${next} refs/heads/timeline/ended\n`) +
    pkt("-----BEGIN PGP SIGNATURE-----\n") +
    pkt("signature\n") +
    pkt("-----END PGP SIGNATURE-----\n") +
    pkt("push-cert-end\n") +
    FLUSH;
  const result = await readReceivePackCommands(new Response(text).body!);
  expect(result.pushCert).toBe(true);
  expect(result.commands).toEqual([{ old, new: next, ref: "refs/heads/timeline/ended" }]);
  expect(await new Response(result.body).text()).toBe(text);
});
