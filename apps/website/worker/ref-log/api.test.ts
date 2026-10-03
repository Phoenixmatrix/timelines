import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { ChangeHistory, RefUpdateList } from "../../shared/api.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import type { PackCommit } from "../git/pack.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { refLog } from "./api.ts";
import { recordRefs } from "./record.ts";

// loadRepo's module reaches the knowledge coordinator, a Durable Object.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const oid = (n: number) => n.toString(16).padStart(40, "0");

async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('acc_ann', 'user', 'ann', 'Ann'), ('acc_bob', 'user', 'bob', 'Bob');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_builder', 'builder', 'acc_ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc_ann', 'app', 'private', 'a', 'https://a');
  `);
  const env = { DB: d1(sqlite) } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/repos/:owner/:name", refLog);
  const ann = (await issueToken(env.DB, "acc_ann", "laptop", "read")).secret;
  const bob = (await issueToken(env.DB, "acc_bob", "laptop", "read")).secret;
  const get = (token: string, path: string) =>
    app.request(path, { headers: { authorization: `Bearer ${token}` } }, env);
  /** Push `tips`; each update reads the pushed `commits` its new tip reaches. */
  const push = (
    tips: Record<string, string>,
    commits: PackCommit[],
    actor: { id: string; agent?: { id: string; name: string } } = { id: "acc_ann" },
  ) =>
    recordRefs(env.DB, "repo", new Map(Object.entries(tips)), actor, async (want) => {
      const found: PackCommit[] = [];
      for (let next = [want]; next.length;) {
        const commit = commits.find((c) => c.oid === next[0]);
        next = [...next.slice(1), ...(commit?.parents ?? [])];
        if (commit && !found.includes(commit)) found.push(commit);
      }
      return { commits: found, truncated: false };
    });
  return { get, push, ann, bob };
}

describe("ref updates", () => {
  test("lists a ref's updates newest first, in pages, with who pushed", async () => {
    const t = await setup();
    await t.push({ "refs/heads/main": oid(1) }, [{ oid: oid(1), parents: [], changeId: "kkkk" }]);
    for (let n = 2; n <= 60; n++) {
      await t.push(
        { "refs/heads/main": oid(n), "refs/heads/topic": oid(1) },
        [{ oid: oid(n), parents: [oid(n - 1)], changeId: null }],
        { id: "acc_ann", agent: { id: "agt_builder", name: "builder" } },
      );
    }
    const first = (await (
      await t.get(t.ann, "/api/repos/ann/app/ref-updates?ref=main")
    ).json()) as RefUpdateList;
    expect(first.updates).toHaveLength(50);
    expect(first.updates[0]).toMatchObject({
      ref: "refs/heads/main",
      old: oid(59),
      new: oid(60),
      forced: false,
      actor: "ann",
      agent: "builder",
    });
    const rest = (await (
      await t.get(t.ann, `/api/repos/ann/app/ref-updates?ref=refs/heads/main&before=${first.next}`)
    ).json()) as RefUpdateList;
    expect(rest.next).toBeNull();
    expect(rest.updates.at(-1)).toMatchObject({ old: null, new: oid(1), agent: null });
    expect(rest.updates).toHaveLength(10);

    const all = (await (
      await t.get(t.ann, "/api/repos/ann/app/ref-updates")
    ).json()) as RefUpdateList;
    expect(all.updates).toHaveLength(50);
    const topic = (await (
      await t.get(t.ann, "/api/repos/ann/app/ref-updates?ref=topic")
    ).json()) as RefUpdateList;
    expect(topic.updates.map((u) => [u.old, u.new])).toEqual([[null, oid(1)]]);
  });

  test("is a repository read: others get nothing", async () => {
    const t = await setup();
    expect((await t.get(t.bob, "/api/repos/ann/app/ref-updates")).status).toBe(404);
    expect((await t.get(t.bob, "/api/repos/ann/app/changes/kkkk")).status).toBe(404);
  });
});

describe("change history", () => {
  test("lists the refs a change reached, by id or unambiguous prefix", async () => {
    const t = await setup();
    const base = { oid: oid(1), parents: [], changeId: "mmmm" };
    const change = { oid: oid(2), parents: [oid(1)], changeId: "kkkkzzzz" };
    const merge = { oid: oid(3), parents: [oid(1), oid(2)], changeId: "nnnn" };
    const other = { oid: oid(4), parents: [oid(1)], changeId: "kkkkyyyy" };
    await t.push({ "refs/heads/main": oid(1) }, [base]);
    await t.push({ "refs/heads/main": oid(1), "refs/heads/timeline/x": oid(2) }, [change]);
    // The timeline merged into main, by an agent.
    await t.push({ "refs/heads/main": oid(3), "refs/heads/timeline/x": oid(2) }, [merge, change], {
      id: "acc_ann",
      agent: { id: "agt_builder", name: "builder" },
    });
    await t.push(
      { "refs/heads/main": oid(3), "refs/heads/timeline/x": oid(2), "refs/heads/y": oid(4) },
      [other],
    );

    const response = await t.get(t.ann, "/api/repos/ann/app/changes/kkkkz");
    const history = (await response.json()) as ChangeHistory;
    expect(history.changeId).toBe("kkkkzzzz");
    expect(history.refs.map((r) => [r.ref, r.firstCommit, r.firstUpdate.agent])).toEqual([
      ["refs/heads/timeline/x", oid(2), null],
      ["refs/heads/main", oid(2), "builder"],
    ]);
    expect((await t.get(t.ann, "/api/repos/ann/app/changes/kkkk")).status).toBe(409);
    expect((await t.get(t.ann, "/api/repos/ann/app/changes/zzzzzzzz")).status).toBe(404);
    expect((await t.get(t.ann, "/api/repos/ann/app/changes/no!")).status).toBe(400);
  });
});
