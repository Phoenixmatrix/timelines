import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { IssueResult, SearchResponse } from "../../shared/search.ts";
import { SEARCH_LIMITS } from "../../shared/search.ts";
import type { Issue, IssueCloseReason, Mutation } from "../../shared/tracker.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { trackerSql, transactional } from "../testing/tracker.ts";
import { TrackerStore, type Access } from "../tracker/store.ts";
import { searchApi } from "./api.ts";
import { PROVIDERS } from "./providers.ts";
import { parseQuery, type SearchQuery } from "./query.ts";

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const issuesOnly = PROVIDERS.filter((provider) => provider.category === "issues");

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
  vi.restoreAllMocks();
});

/** A real TrackerStore for one owner, with a team ENG and a way to add issues. */
function trackerFor(owner: { id: string; slug: string }) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  let now = Date.parse("2026-10-01T00:00:00Z");
  const store = new TrackerStore(trackerSql(db), transactional(db), () => now);
  const identity = { id: owner.id, slug: owner.slug, displayName: owner.slug };
  const access: Access = {
    actorId: "ann",
    principalId: "ann",
    agents: [],
    owner: identity,
    canAdmin: true,
    members: [{ id: "ann", slug: "ann", displayName: "Ann" }],
    repos: [],
  };
  let operation = 0;
  const mutate = (...mutations: Mutation[]) =>
    store.mutate(access, { operationId: `${owner.id}-${++operation}`, mutations });
  mutate({ kind: "team.create", id: "team", data: { key: "ENG", name: "Engineering" } });
  let n = 0;
  return {
    store,
    /** Creates the next ENG-N issue; later issues are updated later. */
    add(data: {
      title: string;
      description?: string;
      status?: Issue["status"];
      priority?: Issue["priority"];
      closeReason?: IssueCloseReason;
    }) {
      now += 1000;
      const id = `${owner.id}-issue-${++n}`;
      mutate({ kind: "issue.create", id, data: { teamId: "team", ...data } });
      return id;
    },
  };
}

function query(text: string): SearchQuery {
  const parsed = parseQuery(text);
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
}

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben'),
      ('orbit', 'org', 'orbit', 'Orbit'), ('vault', 'org', 'vault', 'Vault');
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('orbit', 'ann', 'member'), ('vault', 'ben', 'owner');
  `);
  const trackers = new Map<string, ReturnType<typeof trackerFor>>();
  const failing = new Set<string>();
  const tracker = (id: string) => {
    let found = trackers.get(id);
    if (!found) trackers.set(id, (found = trackerFor({ id, slug: id })));
    return found;
  };
  const getByName = vi.fn((id: string) => ({
    searchIssues: async (q: SearchQuery, limit: number) => {
      if (failing.has(id)) throw new Error("Durable Object reset");
      return { ok: true, value: tracker(id).store.searchIssues(q, limit) };
    },
  }));
  const env = { DB: d1(sqlite), TRACKER: { getByName } } as unknown as Env;
  let actor: Actor = ann;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api/search", searchApi(issuesOnly));
  const call = (params: Record<string, string>) =>
    app.request(`/api/search?${new URLSearchParams(params).toString()}`, {}, env);
  return {
    sqlite,
    tracker,
    failing,
    getByName,
    as: (next: Actor) => {
      actor = next;
    },
    call,
    search: async (params: Record<string, string>) => {
      const response = await call({ categories: "issues", ...params });
      expect(response.status).toBe(200);
      const group = ((await response.json()) as SearchResponse).groups[0]!;
      if (group.status !== "ok") throw new Error(group.error);
      return { ...group, results: group.results as IssueResult[] };
    },
  };
}

describe("tracker issue search", () => {
  test("ranks exact keys, then titles, then descriptions, open and closed alike", () => {
    const t = trackerFor({ id: "orbit", slug: "orbit" });
    t.add({ title: "Login is slow", description: "Profile the token check" }); // ENG-1
    t.add({ title: "Token refresh", status: "done" }); // ENG-2
    t.add({ title: "Refactor the token cache", status: "canceled", closeReason: "obsolete" }); // ENG-3
    t.add({ title: "Unrelated" }); // ENG-4
    const found = (text: string) =>
      t.store.searchIssues(query(text), 10).map(({ issue, rank }) => [issue.key, rank]);
    expect(found("token")).toEqual([
      ["ENG-2", 1], // title prefix, closed
      ["ENG-3", 2], // a word in the title, canceled
      ["ENG-1", 3], // description only
    ]);
    expect(found("eng-4")).toEqual([["ENG-4", 0]]);
    // ENG-1 is a prefix of ENG-10.. but the exact key ranks first.
    expect(found("ENG-1")[0]).toEqual(["ENG-1", 0]);
    expect(found("%")).toEqual([]);
  });

  test("breaks ties by priority, then most recently updated", () => {
    const t = trackerFor({ id: "orbit", slug: "orbit" });
    t.add({ title: "Deploy fails", priority: 3 });
    t.add({ title: "Deploy flakes", priority: 1 });
    t.add({ title: "Deploy docs", priority: 1 });
    expect(t.store.searchIssues(query("deploy"), 10).map(({ issue }) => issue.title)).toEqual([
      "Deploy docs",
      "Deploy flakes",
      "Deploy fails",
    ]);
  });

  test("searches every tracker the viewer belongs to, with distinct breadcrumbs for equal keys", async () => {
    const s = setup();
    s.tracker("ann").add({ title: "Personal budget" });
    s.tracker("orbit").add({ title: "Orbit budget review", status: "done" });
    s.tracker("vault").add({ title: "Vault budget secrets" });
    const { results, incomplete } = await s.search({ q: "budget" });
    expect(incomplete).toBeNull();
    expect(
      results.map((r) => [r.key, r.tracker.slug, r.status, r.breadcrumb, r.target, r.id]),
    ).toEqual([
      [
        "ENG-1",
        "ann",
        "todo",
        ["ann"],
        { kind: "path", path: "/tracker/ann/issues/ann-issue-1" },
        "issues:ann:ann-issue-1",
      ],
      [
        "ENG-1",
        "orbit",
        "done",
        ["orbit"],
        { kind: "path", path: "/tracker/orbit/issues/orbit-issue-1" },
        "issues:orbit:orbit-issue-1",
      ],
    ]);
    // Ann isn't in vault: its tracker is never even asked.
    expect(s.getByName.mock.calls.map(([id]) => id).sort()).toEqual(["ann", "orbit"]);
    expect(JSON.stringify(results)).not.toContain("Vault");
  });

  test("an exact key outranks text matches in other trackers", async () => {
    const s = setup();
    s.tracker("ann").add({ title: "Mentions orbit ENG-1 in passing" });
    s.tracker("orbit").add({ title: "The real one" });
    const { results } = await s.search({ q: "ENG-1" });
    expect(results.map((r) => [r.tracker.slug, r.title, r.match])).toEqual([
      ["ann", "Mentions orbit ENG-1 in passing", "exact"],
      ["orbit", "The real one", "exact"],
    ]);
    const { results: text } = await s.search({ q: "real one" });
    expect(text.map((r) => r.match)).toEqual(["word"]);
  });

  test("losing membership removes a tracker's issues at once", async () => {
    const s = setup();
    s.tracker("orbit").add({ title: "Orbit roadmap" });
    expect((await s.search({ q: "roadmap" })).results).toHaveLength(1);
    s.sqlite.exec(`DELETE FROM org_members WHERE org_id = 'orbit' AND user_id = 'ann'`);
    expect((await s.search({ q: "roadmap" })).results).toEqual([]);
  });

  test("pages across trackers without duplicates", async () => {
    const s = setup();
    for (let i = 0; i < 7; i++) s.tracker("ann").add({ title: `Release ${i}` });
    for (let i = 0; i < 6; i++) s.tracker("orbit").add({ title: `Release orbit ${i}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const params: Record<string, string> = { q: "release", limit: "5" };
      if (cursor) params.cursor = cursor;
      const page = await s.search(params);
      seen.push(...page.results.map((r) => r.id));
      cursor = page.cursor;
    } while (cursor);
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
  });

  test("reports failed trackers as incomplete, and all failing as unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup();
    s.tracker("ann").add({ title: "Budget" });
    s.tracker("orbit").add({ title: "Budget" });
    s.failing.add("orbit");
    const partial = await s.search({ q: "budget" });
    expect(partial.results.map((r) => r.tracker.slug)).toEqual(["ann"]);
    expect(partial.incomplete).toBe("Couldn't search orbit.");

    s.failing.add("ann");
    const response = await s.call({ q: "budget", categories: "issues" });
    expect(((await response.json()) as SearchResponse).groups[0]).toEqual({
      category: "issues",
      status: "unavailable",
      error: "Couldn't search issues right now.",
    });
  });

  test("reads a bounded number of trackers and says so", async () => {
    const s = setup();
    const many = SEARCH_LIMITS.trackers + 3;
    const rows = Array.from({ length: many }, (_, i) => `org${String(i).padStart(2, "0")}`);
    s.sqlite.exec(
      rows
        .map(
          (id) =>
            `INSERT INTO accounts (id, kind, slug, display_name) VALUES ('${id}', 'org', '${id}', '${id}');
             INSERT INTO org_members (org_id, user_id, role) VALUES ('${id}', 'ann', 'member');`,
        )
        .join("\n"),
    );
    const page = await s.search({ q: "anything" });
    expect(s.getByName).toHaveBeenCalledTimes(SEARCH_LIMITS.trackers);
    // Ann's own tracker is always among them.
    expect(s.getByName.mock.calls.map(([id]) => id)).toContain("ann");
    expect(page.incomplete).toBe(
      `Searched ${SEARCH_LIMITS.trackers} of your ${many + 2} trackers.`,
    );
  });
});
