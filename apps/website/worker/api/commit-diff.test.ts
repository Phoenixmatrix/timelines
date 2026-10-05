import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { CommitDiff } from "../../shared/diff.ts";
import { DIFF_LIMITS } from "../../shared/diff.ts";
import { issueToken } from "./tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeHistory } from "../testing/history.ts";
import { Timing } from "../timing.ts";
import { repos } from "./repos.ts";

// loadRepo's module reaches the knowledge coordinator, a Durable Object.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkflowEntrypoint: class {} }));

beforeEach(() => {
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});
afterEach(() => vi.unstubAllGlobals());

async function setup(visibility = "private") {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('bob', 'user', 'bob', 'Bob'), ('orbit', 'org', 'orbit', 'Orbit');
    INSERT INTO org_members (org_id, user_id, role) VALUES ('orbit', 'ann', 'owner');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('app', 'orbit', 'app', '${visibility}', 'diff-${crypto.randomUUID()}', 'https://app');
  `);
  const git = fakeHistory();
  const env = { DB: d1(sqlite), ARTIFACTS: git.artifacts } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    c.set("timing", new Timing());
    return next();
  });
  app.route("/api/repos", repos);
  const tokens = {
    ann: (await issueToken(env.DB, "ann", "t", "read")).secret,
    bob: (await issueToken(env.DB, "bob", "t", "read")).secret,
  };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };
  const get = async (oid: string, who: keyof typeof tokens = "ann") => {
    const response = await app.request(
      `/api/repos/orbit/app/commits/${oid}/diff`,
      { headers: { authorization: `Bearer ${tokens[who]}` } },
      env,
      ctx as unknown as ExecutionContext,
    );
    return { status: response.status, response, body: (await response.json()) as CommitDiff };
  };
  return { git, get };
}

describe("GET /commits/:oid/diff", () => {
  test("a commit's files against its first parent, with hunks and counts", async () => {
    const { git, get } = await setup();
    const base = git.commit({
      files: { "src/rank.ts": "a\nb\nc\n", "README.md": "hi\n", "old.txt": "gone\n" },
      message: "Start",
    });
    const step = git.commit({
      parents: [base],
      files: { "src/rank.ts": "a\nB\nc\nd\n", "README.md": "hi\n", "src/new.ts": "x\n" },
      message: "Rank by recency",
    });
    const { status, body, response } = await get(step);
    expect(status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(body.message).toBe("Rank by recency");
    expect(body.parents).toEqual([base]);
    expect(body.truncated).toBe(false);
    expect(body.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["old.txt", "deleted", 0, 1],
      ["src/new.ts", "added", 1, 0],
      ["src/rank.ts", "modified", 2, 1],
    ]);
    const rank = body.files.find((f) => f.path === "src/rank.ts")!;
    expect(rank.hunks[0]!.lines).toEqual([" a", "-b", "+B", " c", "+d"]);
    // A root commit compares with nothing.
    expect((await get(base)).body.files.every((f) => f.status === "added")).toBe(true);
  });

  test("binary and oversized files are counted without hunks; many files are bounded", async () => {
    const { git, get } = await setup();
    const files: Record<string, string> = {
      "bin.dat": "a\u0000b",
      "big.txt": "x".repeat(DIFF_LIMITS.blobBytes + 1),
    };
    for (let n = 0; n < DIFF_LIMITS.files + 5; n++)
      files[`many/f${String(n).padStart(3, "0")}.txt`] = `${n}\n`;
    const oid = git.commit({ files, message: "Lots" });
    const { body } = await get(oid);
    expect(body.files).toHaveLength(DIFF_LIMITS.files);
    expect(body.truncated).toBe(true);
    const bin = body.files.find((f) => f.path === "bin.dat")!;
    expect([bin.binary, bin.hunks.length]).toEqual([true, 0]);
    const big = body.files.find((f) => f.path === "big.txt")!;
    expect([big.omitted, big.hunks.length]).toEqual([true, 0]);
    // Past the patch budget, files are listed but not patched.
    expect(body.files.at(-1)!.omitted).toBe(true);
  });

  test("needs read access and a full commit hash", async () => {
    const { git, get } = await setup();
    const oid = git.commit({ files: { a: "a\n" } });
    expect((await get(oid, "bob")).status).toBe(404);
    expect((await get(oid.slice(0, 12))).status).toBe(400);
    expect((await get("f".repeat(40))).status).toBe(404);
  });
});
