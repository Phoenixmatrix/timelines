import { describe, expect, it } from "vite-plus/test";

import { FLUSH, pkt } from "../git/pktline.ts";
import {
  fetchRequest,
  packFromFetchResponse,
  parsePushReport,
  parseReceivePackAdvertisement,
  planMirror,
  receivePackCommands,
  ZERO_OID,
} from "./protocol.ts";

const enc = new TextEncoder();
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function sideband(band: number, payload: string | Uint8Array): string {
  const bytes = typeof payload === "string" ? enc.encode(payload) : payload;
  const length = (bytes.length + 5).toString(16).padStart(4, "0");
  return length + String.fromCharCode(band) + new TextDecoder("latin1").decode(bytes);
}

function streamOf(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = enc.encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
}

describe("mirror protocol", () => {
  it("reads a receive-pack advertisement, capabilities and all", () => {
    const body =
      pkt("# service=git-receive-pack\n") +
      FLUSH +
      pkt(
        `${A} refs/heads/main\0report-status side-band-64k delete-refs atomic ofs-delta agent=git/github\n`,
      ) +
      pkt(`${B} refs/tags/v1\n`) +
      pkt(`${C} refs/tags/v1^{}\n`) +
      pkt(`${C} refs/pull/1/head\n`) +
      FLUSH;
    const ad = parseReceivePackAdvertisement(enc.encode(body));
    expect([...ad.refs]).toEqual([
      ["refs/heads/main", A],
      ["refs/tags/v1", B],
      ["refs/pull/1/head", C],
    ]);
    expect(ad.capabilities.has("delete-refs")).toBe(true);
    expect(ad.capabilities.has("agent=git/github")).toBe(true);
  });

  it("reads an empty repository's advertisement", () => {
    const body =
      pkt("# service=git-receive-pack\n") +
      FLUSH +
      pkt(`${ZERO_OID} capabilities^{}\0report-status delete-refs\n`) +
      FLUSH;
    const ad = parseReceivePackAdvertisement(enc.encode(body));
    expect(ad.refs.size).toBe(0);
    expect(ad.capabilities.has("report-status")).toBe(true);
  });

  it("plans creations, force-updates and (only when pruning) deletions", () => {
    const source = new Map([
      ["refs/heads/main", A],
      ["refs/heads/new", B],
      ["refs/tags/v1", C],
    ]);
    const target = new Map([
      ["refs/heads/main", B],
      ["refs/heads/gone", C],
      ["refs/tags/v1", C],
      ["refs/pull/1/head", A],
    ]);
    expect(planMirror(source, target, false)).toEqual([
      { ref: "refs/heads/main", old: B, new: A },
      { ref: "refs/heads/new", old: ZERO_OID, new: B },
    ]);
    // Pruning deletes only branches and tags, never a host's own refs.
    expect(planMirror(source, target, true)).toContainEqual({
      ref: "refs/heads/gone",
      old: C,
      new: ZERO_OID,
    });
    expect(planMirror(source, target, true).map((u) => u.ref)).not.toContain("refs/pull/1/head");
  });

  it("writes commands with only the capabilities the target offers", () => {
    const text = new TextDecoder().decode(
      receivePackCommands(
        [
          { ref: "refs/heads/main", old: B, new: A },
          { ref: "refs/heads/x", old: ZERO_OID, new: B },
        ],
        new Set(["report-status", "side-band-64k", "agent=git/2.4"]),
      ),
    );
    expect(text).toBe(
      pkt(`${B} ${A} refs/heads/main\0report-status side-band-64k agent=gitmatrix\n`) +
        pkt(`${ZERO_OID} ${B} refs/heads/x\n`) +
        FLUSH,
    );
  });

  it("asks Artifacts for exactly the missing objects", () => {
    const text = fetchRequest([A, A], [B], true);
    expect(text).toContain(pkt(`want ${A}\n`));
    expect(text.split(`want ${A}`).length).toBe(2);
    expect(text).toContain(pkt(`have ${B}\n`));
    expect(text).toContain(pkt("ofs-delta\n"));
    expect(text).toContain(pkt("done\n"));
    expect(text).not.toContain("thin-pack");
  });

  it("streams the pack out of a v2 fetch response, across chunk boundaries", async () => {
    const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0xff, 0x00, 0x0a]);
    const body =
      pkt("packfile\n") +
      sideband(2, "Counting objects\n") +
      sideband(1, pack.slice(0, 5)) +
      sideband(1, pack.slice(5)) +
      FLUSH;
    const out: number[] = [];
    // latin1 round-trips the binary pack bytes through the test's text framing.
    const bytes = Uint8Array.from(body, (ch) => ch.charCodeAt(0));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    for await (const chunk of packFromFetchResponse(stream)) out.push(...chunk);
    expect(out).toEqual([...pack]);
  });

  it("surfaces a fatal side-band message from Artifacts", async () => {
    const body = pkt("packfile\n") + sideband(3, "object missing") + FLUSH;
    const run = async () => {
      for await (const _ of packFromFetchResponse(streamOf(body))) void _;
    };
    await expect(run()).rejects.toThrow("object missing");
  });

  it("reads the target's report, in side-band or plain", () => {
    const status =
      pkt("unpack ok\n") +
      pkt("ok refs/heads/main\n") +
      pkt("ng refs/heads/x protected branch hook declined\n") +
      FLUSH;
    const plain = parsePushReport(enc.encode(status), false);
    expect(plain.unpack).toBe("ok");
    expect(plain.refs).toEqual([
      { ref: "refs/heads/main", ok: true },
      { ref: "refs/heads/x", ok: false, reason: "protected branch hook declined" },
    ]);
    const banded = parsePushReport(enc.encode(sideband(1, status) + FLUSH), true);
    expect(banded).toEqual({ ...plain, errors: [] });
    const fatal = parsePushReport(enc.encode(sideband(3, "denied\n") + FLUSH), true);
    expect(fatal.errors).toEqual(["denied"]);
  });
});
