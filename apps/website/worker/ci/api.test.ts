import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { CiRunList } from "../../shared/api.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { ci } from "./api.ts";

// loadRepo's module reaches the knowledge coordinator, a Durable Object.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const oid = (n: number) => n.toString(16).padStart(40, "0");

async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('repo', 'acc_ann', 'app', 'private', 'a', 'https://a');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES
      ('run1', 'repo', 1, '${oid(1)}', 'main', 'push', 'succeeded'),
      ('run2', 'repo', 2, '${oid(2)}', 'timeline/fast-search', 'push', 'failed'),
      ('run3', 'repo', 3, '${oid(3)}', 'topic', 'push', 'succeeded'),
      ('run4', 'repo', 4, '${oid(4)}', 'timeline/fast-search', 'push', 'succeeded');
  `);
  const env = { DB: d1(sqlite) } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/repos/:owner/:name/ci", ci);
  const { secret } = await issueToken(env.DB, "acc_ann", "t", "read");
  return async (path: string) => {
    const response = await app.request(
      path,
      { headers: { authorization: `Bearer ${secret}` } },
      env,
    );
    return { status: response.status, json: (await response.json()) as CiRunList };
  };
}

describe("CI runs list", () => {
  test("lists every branch's runs, newest first", async () => {
    const get = await setup();
    const { json } = await get("/api/repos/ann/app/ci");
    expect(json.runs.map((run) => run.number)).toEqual([4, 3, 2, 1]);
  });

  test("?ref= lists one branch's runs: a timeline's bookmark in its scope", async () => {
    const get = await setup();
    const scoped = await get("/api/repos/ann/app/ci?ref=timeline/fast-search");
    expect(scoped.json.runs.map((run) => run.number)).toEqual([4, 2]);
    const full = await get("/api/repos/ann/app/ci?ref=refs/heads/timeline/fast-search&before=4");
    expect(full.json.runs.map((run) => run.number)).toEqual([2]);
  });
});
