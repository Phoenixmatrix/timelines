// Measuring unreachable git data (CORE-202): which commits count, the fetch
// asked of Artifacts, and the pack counted as it streams. Against real
// Artifacts: the E2E scenario push-log-retention-and-unreachable-git.

import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { FLUSH, pkt } from "./pktline.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { buildPack, commitBody } from "../testing/pack.ts";
import {
  countPack,
  droppedCommits,
  measureUnreachable,
  unreachableRequest,
} from "./unreachable.ts";

const oid = (n: number) => n.toString(16).padStart(40, "0");
const encoder = new TextEncoder();

vi.mock(import("../artifacts.ts"), async (original) => ({
  ...(await original()),
  upstreamToken: async () => "token",
  lsRefs: async (_env: Env, _name: string, _remote: string, prefixes?: readonly string[]) => {
    // Every ref, not only branches and tags.
    expect(prefixes).toEqual([]);
    return [
      { name: "HEAD", oid: oid(3), symrefTarget: "refs/heads/main" },
      { name: "refs/heads/main", oid: oid(3) },
      { name: "refs/heads/back", oid: oid(5) },
      { name: "refs/gm/keep", oid: oid(6) },
    ];
  },
}));

afterEach(() => vi.unstubAllGlobals());

/** A fetch response: pkt-lines, with pack bytes on side-band 1. */
function response(pack: Uint8Array | null, before = pkt("acknowledgments\n") + pkt("NAK\n")) {
  const parts: Uint8Array[] = [encoder.encode(before)];
  if (pack) {
    parts.push(encoder.encode(pkt("packfile\n")));
    for (let at = 0; at < pack.length; at += 1000) {
      const chunk = pack.subarray(at, at + 1000);
      parts.push(encoder.encode((chunk.length + 5).toString(16).padStart(4, "0")));
      parts.push(new Uint8Array([1, ...chunk]));
    }
  }
  parts.push(encoder.encode(FLUSH));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

const blob = new Uint8Array(5000).map((_, i) => (i * 7919) % 251);
const PACK = buildPack([
  { type: "commit", body: commitBody({ changeId: "gone" }) },
  { type: "blob", body: blob },
]);

function seeded() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('app', 'ann', 'app', 'private', 'a', 'https://artifacts.example/a');
    INSERT INTO ref_updates (id, repo_id, ref, old_oid, new_oid, forced) VALUES
      (1, 'app', 'refs/heads/main', NULL, '${oid(1)}', NULL),  -- created: nothing left
      (2, 'app', 'refs/heads/main', '${oid(1)}', '${oid(3)}', 0), -- fast-forward: still reachable
      (3, 'app', 'refs/heads/topic', NULL, '${oid(4)}', NULL),
      (4, 'app', 'refs/heads/topic', '${oid(4)}', NULL, NULL),    -- deleted: left oid 4
      (5, 'app', 'refs/heads/forced', '${oid(7)}', '${oid(8)}', 1), -- force push: left oid 7
      (6, 'app', 'refs/heads/back', '${oid(5)}', NULL, NULL),     -- deleted, but back again at oid 5
      (7, 'app', 'refs/heads/again', '${oid(4)}', NULL, NULL);    -- oid 4 left twice: once
  `);
  return { sqlite, env: { DB: d1(sqlite) } as unknown as Env };
}

describe("unreachable git data", () => {
  test("the commits refs left: deletions and force pushes, once each, newest first", async () => {
    const { env } = seeded();
    expect(await droppedCommits(env.DB, "app")).toEqual([oid(4), oid(5), oid(7)]);
    expect(await droppedCommits(env.DB, "app", 1)).toEqual([oid(4)]);
    expect(await droppedCommits(env.DB, "other")).toEqual([]);
  });

  test("the fetch wants what left and has every ref, for a full pack", () => {
    const body = unreachableRequest([oid(4)], [oid(3), oid(5)]);
    expect(body).toContain(pkt(`want ${oid(4)}\n`));
    expect(body).toContain(pkt(`have ${oid(3)}\n`));
    expect(body).toContain(pkt("done\n"));
    expect(body).not.toContain("thin-pack");
    expect(body).not.toContain("filter");
  });

  test("a pack is counted as it streams: objects from its header, bytes, a cap", async () => {
    expect(await countPack(response(PACK), 1 << 20)).toEqual({
      objects: 2,
      bytes: PACK.length,
      truncated: false,
    });
    const capped = await countPack(response(PACK), 100);
    expect(capped.truncated).toBe(true);
    expect(capped.objects).toBe(2);
    expect(await countPack(response(null), 100)).toEqual({
      objects: 0,
      bytes: 0,
      truncated: false,
    });
    await expect(countPack(response(null, pkt("ERR upload-pack: nope\n")), 100)).rejects.toThrow(
      /nope/,
    );
  });

  test("one fetch per repository, wanting only what no ref holds now", async () => {
    const { env } = seeded();
    const requests: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: init.body as string });
      return new Response(response(PACK));
    });
    const repo = {
      id: "app",
      artifacts_name: "a",
      artifacts_remote: "https://artifacts.example/a",
    };
    expect(await measureUnreachable(env, repo)).toEqual({
      commits: 2,
      objects: 2,
      bytes: PACK.length,
      truncated: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://artifacts.example/a/git-upload-pack");
    const wants = [...requests[0]!.body.matchAll(/want ([0-9a-f]{40})/g)].map((m) => m[1]);
    const haves = [...requests[0]!.body.matchAll(/have ([0-9a-f]{40})/g)].map((m) => m[1]);
    // oid 5 is back on a branch: reachable, not wanted.
    expect(wants).toEqual([oid(4), oid(7)]);
    expect(haves.toSorted((a, b) => a!.localeCompare(b!))).toEqual([oid(3), oid(5), oid(6)]);

    // Nothing left a ref: no fetch at all.
    const none = { ...repo, id: "other" };
    expect(await measureUnreachable(env, none)).toEqual({
      commits: 0,
      objects: 0,
      bytes: 0,
      truncated: false,
    });
    expect(requests).toHaveLength(1);
  });
});
