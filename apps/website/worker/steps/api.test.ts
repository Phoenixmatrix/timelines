import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { Step, StepPage, StepUpload, StepVersions } from "../../shared/steps.ts";
import { STEP_LIMITS } from "../../shared/steps.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { steps } from "./api.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkflowEntrypoint: class {} }));

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const annsAgent: Actor = { ...ann, agent: { id: "agt_builder", name: "builder" } };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };
const cid: Actor = { id: "cid", slug: "cid", displayName: "Cid", isSiteAdmin: false };

const oid = (n: number) => n.toString(16).padStart(40, "0");

function setup(visibility: "public" | "private" = "private") {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben'), ('cid', 'user', 'cid', 'Cid');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_builder', 'builder', 'ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'ann', 'app', '${visibility}', 'a', 'https://a');
    INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('repo', 'ben', 'write');
  `);
  const env = { DB: d1(sqlite) } as unknown as Env;
  let actor: Actor | null = annsAgent;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api/repos/:owner/:name/steps", steps);
  const call = (path: string, init?: RequestInit) =>
    app.request(`/api/repos/ann/app/steps${path}`, init, env);
  return {
    sqlite,
    as: (next: Actor | null) => {
      actor = next;
    },
    call,
    upload: (step: Partial<StepUpload>) => call("", { method: "POST", body: JSON.stringify(step) }),
  };
}

const step = (n: number, over: Partial<StepUpload> = {}): StepUpload => ({
  changeId: `change${String(n).padStart(4, "0")}`,
  commitOid: oid(n),
  summary: `Step ${n}`,
  committedAt: `2026-10-04T00:${String(n).padStart(2, "0")}:00.000Z`,
  timeline: "search",
  issue: "CORE-9",
  instructions: [{ text: "Rank results by recency", source: "hook" }],
  steering: [{ text: "Keep the old order as a fallback", source: "hook" }],
  why: "Recency matters more than score here.",
  challenges: "The first index didn't cover updated_at.",
  tests: [{ command: "vp test run search", exit: 0, summary: "12 passed", origin: "local" }],
  coverage: { instructions: "hook:claude-code", steering: "hook:claude-code" },
  harness: "claude-code",
  model: "claude-opus-5-5",
  ...over,
});

describe("step context", () => {
  test("an agent uploads a step; it reads back with its context and author", async () => {
    const s = setup();
    const made = await s.upload(step(1));
    expect(made.status).toBe(201);
    const body = (await made.json()) as Step;
    expect(body).toMatchObject({
      changeId: "change0001",
      commitOid: oid(1),
      summary: "Step 1",
      timeline: "search",
      issue: "CORE-9",
      verified: false,
      deleted: false,
      author: {
        id: "agt_builder",
        kind: "agent",
        name: "builder",
        accountable: { id: "ann", slug: "ann", displayName: "Ann" },
      },
      context: {
        why: "Recency matters more than score here.",
        steering: [{ text: "Keep the old order as a fallback", source: "hook" }],
        tests: [{ command: "vp test run search", exit: 0, origin: "local" }],
        coverage: { instructions: "hook:claude-code", steering: "hook:claude-code" },
      },
    });
  });

  test("is verified when a push has shown its commit as that change", async () => {
    const s = setup();
    s.sqlite.exec(`
      INSERT INTO ref_updates (repo_id, ref, new_oid, actor_id) VALUES ('repo', 'refs/heads/timeline/search', '${oid(2)}', 'ann');
      INSERT INTO change_refs (repo_id, change_id, ref, first_commit_oid, first_update_id, last_commit_oid)
      VALUES ('repo', 'change0002', 'refs/heads/timeline/search', '${oid(2)}', 1, '${oid(2)}');
    `);
    expect(((await (await s.upload(step(2))).json()) as Step).verified).toBe(true);
    // A different incarnation of the change isn't the commit the push showed.
    expect(
      ((await (await s.upload(step(2, { commitOid: oid(99) }))).json()) as Step).verified,
    ).toBe(false);
  });

  test("retries replace the author's own record; nobody else can overwrite it", async () => {
    const s = setup();
    await s.upload(step(1));
    const again = await s.upload(step(1, { why: "Better reason." }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as Step).context.why).toBe("Better reason.");
    s.as(ben);
    expect((await s.upload(step(1))).status).toBe(409);
  });

  test("checks its input and bounds", async () => {
    const s = setup();
    expect((await s.upload(step(1, { changeId: "NOT A CHANGE" }))).status).toBe(400);
    expect((await s.upload(step(1, { commitOid: "abc" }))).status).toBe(400);
    expect((await s.upload(step(1, { committedAt: "yesterday" }))).status).toBe(400);
    // Per-field caps bound why and challenges; the overall cap bounds the rest.
    const many = Array.from({ length: STEP_LIMITS.entries }, () => ({
      text: "x".repeat(3000),
      source: "hook" as const,
    }));
    expect((await s.upload(step(1, { instructions: many }))).status).toBe(413);
    // Unknown or malformed parts are dropped, not stored.
    const odd = await s.upload({
      ...step(3),
      steering: [
        { text: "ok", source: "nonsense" as never },
        { nope: 1 } as never,
        { text: "  ", source: "hook" },
      ],
      tests: [{ command: "x" } as never],
    } as StepUpload);
    const stored = (await odd.json()) as Step;
    expect(stored.context.steering).toEqual([{ text: "ok", source: "agent" }]);
    expect(stored.context.tests).toEqual([]);
  });

  test("readers read, only writers upload, outsiders see nothing", async () => {
    const s = setup();
    await s.upload(step(1));
    s.as(cid);
    expect((await s.call("")).status).toBe(404);
    expect((await s.call("/change0001")).status).toBe(404);
    expect((await s.upload(step(2))).status).toBe(404);

    const open = setup("public");
    await open.upload(step(1));
    open.as(cid);
    expect(((await (await open.call("")).json()) as StepPage).steps).toHaveLength(1);
    expect((await open.upload(step(2))).status).toBe(403);
    open.as(null);
    expect((await open.call("")).status).toBe(200);
  });

  test("lists newest first, filters by timeline and issue, and pages without repeats", async () => {
    const s = setup();
    for (let n = 1; n <= 7; n++)
      await s.upload(step(n, n > 5 ? { timeline: "other", issue: "CORE-8" } : {}));
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await (
        await s.call(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      ).json()) as StepPage;
      all.push(...page.steps.map((x) => x.summary));
      cursor = page.cursor;
    } while (cursor);
    expect(all).toEqual(["Step 7", "Step 6", "Step 5", "Step 4", "Step 3", "Step 2", "Step 1"]);
    const timeline = (await (await s.call("?timeline=search")).json()) as StepPage;
    expect(timeline.steps.map((x) => x.summary)).toEqual([
      "Step 5",
      "Step 4",
      "Step 3",
      "Step 2",
      "Step 1",
    ]);
    const issue = (await (await s.call("?issue=CORE-8")).json()) as StepPage;
    expect(issue.steps).toHaveLength(2);
    expect((await s.call("?cursor=junk")).status).toBe(400);
    expect((await s.call("?limit=500")).status).toBe(400);
  });

  test("keeps every version of an amended change", async () => {
    const s = setup();
    await s.upload(step(1));
    await s.upload(
      step(1, {
        commitOid: oid(50),
        committedAt: "2026-10-04T01:00:00.000Z",
        why: "After review.",
      }),
    );
    const versions = (await (await s.call("/change0001")).json()) as StepVersions;
    expect(versions.versions.map((v) => [v.commitOid, v.context.why])).toEqual([
      [oid(50), "After review."],
      [oid(1), "Recency matters more than score here."],
    ]);
    expect((await s.call("/nochange00")).status).toBe(404);
  });

  test("admins delete a step's context, leaving the step; it can't be re-uploaded", async () => {
    const s = setup();
    await s.upload(step(1));
    s.as(ben);
    expect((await s.call(`/change0001/${oid(1)}`, { method: "DELETE" })).status).toBe(403);
    s.as(ann);
    expect((await s.call(`/change0001/${oid(1)}`, { method: "DELETE" })).status).toBe(204);
    const [kept] = ((await (await s.call("")).json()) as StepPage).steps;
    expect(kept).toMatchObject({ deleted: true, summary: "", context: { why: "", steering: [] } });
    s.as(annsAgent);
    expect((await s.upload(step(1))).status).toBe(410);
  });
});
