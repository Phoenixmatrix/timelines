import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { SearchGroup, SearchResponse } from "../../shared/search.ts";
import { SEARCH_LIMITS } from "../../shared/search.ts";
import type { AppEnv } from "../auth.ts";
import { readableRepo, roleFor, selectRepos, type Actor } from "../db.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { PROVIDERS, type AnySearchProvider, type SearchProvider } from "./providers.ts";
import { searchApi } from "./api.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
const closers: Array<() => void> = [];

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann Lee", isSiteAdmin: false };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben Ito", isSiteAdmin: false };
const admin: Actor = { id: "root", slug: "root", displayName: "Root", isSiteAdmin: true };

// Issues (tracker Durable Objects) and packages (the registry) have their own tests.
const D1_PROVIDERS = PROVIDERS.filter(
  (provider) => provider.category !== "issues" && provider.category !== "packages",
);

async function setup(providers: readonly AnySearchProvider[] = D1_PROVIDERS) {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite, env } = fresh;
  closers.push(fresh.close);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann Lee'), ('ben', 'user', 'ben', 'Ben Ito'),
      ('root', 'user', 'root', 'Root');
    BEGIN;
    INSERT INTO organizations (id, slug, display_name, kind, default_space_id) VALUES
      ('org-ann', 'org-ann', 'Ann', 'company', 'ann'),
      ('org-ben', 'org-ben', 'Ben', 'company', 'ben'),
      ('org-orbit', 'org-orbit', 'Orbit Labs', 'company', 'orbit'),
      ('org-vault', 'org-vault', 'Vault', 'company', 'vault');
    INSERT INTO spaces (id, organization_id, slug, display_name) VALUES
      ('ann', 'org-ann', 'ann', 'Ann'), ('ben', 'org-ben', 'ben', 'Ben'),
      ('orbit', 'org-orbit', 'orbit', 'Orbit Labs'), ('vault', 'org-vault', 'vault', 'Vault');
    INSERT INTO organization_members (organization_id, account_id, role, origin, granted_by) VALUES
      ('org-ann', 'ann', 'owner', 'test', 'ann'), ('org-ben', 'ben', 'owner', 'test', 'ben'),
      ('org-orbit', 'ann', 'member', 'test', 'ann'), ('org-vault', 'ann', 'member', 'test', 'ann'),
      ('org-vault', 'ben', 'owner', 'test', 'ben');
    INSERT INTO space_grants (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by) VALUES
      ('ann', 'org-ann', 'ann', 'admin', 'write', 'write', 'test', 'ann'),
      ('ben', 'org-ben', 'ben', 'admin', 'write', 'write', 'test', 'ben'),
      ('orbit', 'org-orbit', 'ann', 'member', 'read', 'read', 'test', 'ann'),
      ('vault', 'org-vault', 'ann', 'member', 'none', 'read', 'test', 'ann'),
      ('vault', 'org-vault', 'ben', 'admin', 'write', 'write', 'test', 'ben');
    COMMIT;
  `);
  let actor: Actor | null = ann;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api/search", searchApi(providers));
  return {
    sqlite,
    env,
    as: (next: Actor | null) => {
      actor = next;
    },
    call: (params: Record<string, string>) =>
      app.request(`/api/search?${new URLSearchParams(params).toString()}`, {}, env),
    search: async (params: Record<string, string>) => {
      const response = await app.request(
        `/api/search?${new URLSearchParams(params).toString()}`,
        {},
        env,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as SearchResponse;
    },
  };
}

let repoCount = 0;
function repo(
  sqlite: DatabaseSync,
  owner: string,
  name: string,
  { visibility = "public", description = "", pushedAt = null as string | null } = {},
) {
  const id = `repo-${++repoCount}`;
  sqlite
    .prepare(
      `INSERT INTO repos (id, space_id, name, description, visibility, artifacts_name, artifacts_remote, pushed_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
    )
    .run(id, owner, name, description, visibility, id, pushedAt);
  return id;
}

function chat(sqlite: DatabaseSync, id: string, user: string, title: string, updatedAt: string) {
  sqlite
    .prepare(`INSERT INTO assistant_chats (id, user_id, title, updated_at) VALUES (?, ?, ?, ?)`)
    .run(id, user, title, updatedAt);
}

function group(response: SearchResponse, category: string) {
  const found = response.groups.find((g) => g.category === category);
  if (!found || found.status !== "ok") throw new Error(`${category} is ${found?.status}`);
  return found;
}

const titles = (g: SearchGroup) => (g.status === "ok" ? g.results.map((r) => r.title) : []);

afterEach(() => {
  vi.useRealTimers();
  for (const close of closers.splice(0)) close();
});

describe("global search", () => {
  test("requires a signed-in viewer", async () => {
    const { call, as } = await setup();
    as(null);
    expect((await call({ q: "orbit" })).status).toBe(401);
  });

  test("returns typed groups with canonical destinations, in category order", async () => {
    const { sqlite, search } = await setup();
    repo(sqlite, "orbit", "engine", { description: "The orbit engine" });
    chat(sqlite, "chat-engine-1", "ann", "Why is the engine slow?", "2026-10-01T00:00:00.000Z");
    const response = await search({ q: "orbit engine" });
    expect(response.query).toBe("orbit engine");
    expect(response.groups.map((g) => [g.category, g.status])).toEqual([
      ["repositories", "ok"],
      ["accounts", "ok"],
      ["conversations", "ok"],
    ]);
    expect(group(response, "repositories").results).toEqual([
      {
        category: "repositories",
        id: "repositories:" + `repo-${repoCount}`,
        title: "orbit/engine",
        subtitle: "The orbit engine",
        breadcrumb: ["orbit"],
        // "orbit/engine" reads as the words "orbit engine".
        match: "word",
        target: { kind: "path", path: "/orbit/engine" },
        space: expect.objectContaining({ id: "orbit", slug: "orbit", organizationId: "org-orbit" }),
        name: "engine",
        visibility: "public",
        defaultBranch: "main",
      },
    ]);

    expect(group(await search({ q: "orbit" }), "accounts").results).toEqual([]);
    const people = await search({ q: "ann" });
    expect(group(people, "accounts").results).toEqual([
      {
        category: "accounts",
        id: "accounts:ann",
        title: "Ann Lee",
        subtitle: "ann",
        breadcrumb: [],
        match: "exact",
        target: { kind: "path", path: "/accounts/ann" },
        kind: "user",
        slug: "ann",
      },
    ]);

    const chats = await search({ q: "slow why", categories: "conversations" });
    expect(chats.groups).toEqual([
      {
        category: "conversations",
        status: "ok",
        cursor: null,
        truncated: false,
        incomplete: null,
        results: [
          {
            category: "conversations",
            id: "conversations:chat-engine-1",
            title: "Why is the engine slow?",
            subtitle: "",
            breadcrumb: ["Assistant"],
            match: "contains",
            target: { kind: "chat", chatId: "chat-engine-1" },
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      },
    ]);
  });

  test("ranks exact identifiers over prefixes, words and descriptions, then by recency and ID", async () => {
    const { sqlite, search } = await setup();
    repo(sqlite, "ann", "notes", { description: "has an engine inside", pushedAt: "2026-09-30" });
    repo(sqlite, "ann", "rocket-engine", { pushedAt: "2026-09-29" });
    repo(sqlite, "ann", "engine-tools", { pushedAt: "2026-09-01" });
    repo(sqlite, "ann", "engine-docs", { pushedAt: "2026-09-02" });
    repo(sqlite, "orbit", "engine", { pushedAt: "2026-01-01" });
    const response = await search({ q: "engine", categories: "repositories", limit: "10" });
    const results = group(response, "repositories").results;
    expect(results.map((r) => [r.title, r.match])).toEqual([
      ["orbit/engine", "exact"],
      ["ann/engine-docs", "prefix"],
      ["ann/engine-tools", "prefix"],
      ["ann/rocket-engine", "word"],
      ["ann/notes", "contains"],
    ]);
    // owner/name is an identifier too, and wins over an equal bare name elsewhere.
    repo(sqlite, "ben", "engine", { pushedAt: "2026-10-01" });
    const qualified = await search({ q: "orbit/engine", categories: "repositories" });
    expect(titles(group(qualified, "repositories"))).toEqual(["orbit/engine"]);
    const bare = await search({ q: "engine", categories: "repositories", limit: "2" });
    expect(titles(group(bare, "repositories"))).toEqual(["ben/engine", "orbit/engine"]);
  });

  test("never shows a repository the viewer can't read, and honors revocation", async () => {
    const { sqlite, search, as } = await setup();
    const secret = repo(sqlite, "ben", "secret-plans", {
      visibility: "private",
      description: "secret",
    });
    repo(sqlite, "vault", "secret-vault", { visibility: "private" });
    repo(sqlite, "orbit", "secret-orbit", { visibility: "private" });
    const visible = async () =>
      titles(group(await search({ q: "secret", categories: "repositories" }), "repositories")).sort(
        (a, b) => a.localeCompare(b),
      );

    // Ann: an orbit member (members read), a vault member (members get nothing).
    expect(await visible()).toEqual(["orbit/secret-orbit"]);
    sqlite
      .prepare(`INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES (?, 'ann', 'read')`)
      .run(secret);
    expect(await visible()).toEqual(["ben/secret-plans", "orbit/secret-orbit"]);
    sqlite.exec(`DELETE FROM repo_collaborators WHERE user_id = 'ann'`);
    expect(await visible()).toEqual(["orbit/secret-orbit"]);

    // Ben has explicit admin grants for his Space and vault; operators read everything.
    as(ben);
    expect(await visible()).toEqual(["ben/secret-plans", "vault/secret-vault"]);
    as(admin);
    expect(await visible()).toHaveLength(3);
  });

  test("authorizes repositories in SQL exactly as permissions.ts does", async () => {
    const { sqlite, env } = await setup();
    for (const owner of ["ann", "ben", "orbit", "vault"])
      for (const visibility of ["public", "private"])
        repo(sqlite, owner, `r-${visibility}`, { visibility });
    sqlite.exec(`
      INSERT INTO repo_collaborators (repo_id, user_id, role)
        SELECT id, 'ben', 'write' FROM repos WHERE space_id = 'orbit' AND visibility = 'private';
    `);
    for (const viewer of [ann, ben, admin]) {
      const rows = await selectRepos(env.DB, viewer.id).execute();
      const readable = await selectRepos(env.DB, viewer.id).where(readableRepo(viewer)).execute();
      expect(readable.map((row) => row.id).sort((a, b) => a.localeCompare(b))).toEqual(
        rows
          .filter((row) => roleFor(row, viewer) !== "none")
          .map((row) => row.id)
          .sort((a, b) => a.localeCompare(b)),
      );
    }
  });

  test("old cursors and Organization ownership never retain revoked repository access", async () => {
    const { sqlite, search, as } = await setup();
    for (let i = 0; i < 6; i++) repo(sqlite, "ben", `private-${i}`, { visibility: "private" });
    as(ben);
    const first = group(
      await search({ q: "private", categories: "repositories", limit: "2" }),
      "repositories",
    );
    expect(first.cursor).not.toBeNull();
    sqlite.exec(`DELETE FROM space_grants WHERE space_id = 'ben' AND account_id = 'ben'`);
    expect(
      group(
        await search({
          q: "private",
          categories: "repositories",
          limit: "2",
          cursor: first.cursor!,
        }),
        "repositories",
      ).results,
    ).toEqual([]);
    expect(
      group(await search({ q: "private", categories: "repositories" }), "repositories").results,
    ).toEqual([]);
  });

  test("searches only the viewer's own conversation titles, all of them", async () => {
    const { sqlite, search } = await setup();
    // More than the chat directory's 200; the oldest still matches.
    sqlite.exec("BEGIN");
    for (let i = 0; i < 250; i++)
      chat(
        sqlite,
        `chat-ann-${i}`,
        "ann",
        `Daily standup ${i}`,
        `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      );
    sqlite.exec("COMMIT");
    chat(sqlite, "chat-ann-old", "ann", "Rotate the deploy keys", "2020-01-01T00:00:00.000Z");
    chat(sqlite, "chat-ben-1", "ben", "Rotate my secret keys", "2026-10-01T00:00:00.000Z");
    const response = await search({ q: "rotate", categories: "conversations" });
    expect(titles(group(response, "conversations"))).toEqual(["Rotate the deploy keys"]);
    expect(JSON.stringify(response)).not.toContain("chat-ben-1");
  });

  test("rejects empty, oversized and malformed queries", async () => {
    const { call } = await setup();
    for (const params of [
      {},
      { q: "   " },
      { q: "x".repeat(SEARCH_LIMITS.queryLength + 1) },
      { q: "a b c d e f g" },
      { q: "engine", limit: "0" },
      { q: "engine", limit: String(SEARCH_LIMITS.maxLimit + 1) },
      { q: "engine", limit: "2.5" },
      { q: "engine", categories: "repositories,secrets" },
      { q: "engine", categories: "," },
      { q: "engine", cursor: "abc" },
      { q: "engine", categories: "accounts", cursor: "not-a-cursor" },
    ] as Record<string, string>[])
      expect((await call(params)).status, JSON.stringify(params)).toBe(400);
  });

  test("matches LIKE wildcards literally", async () => {
    const { sqlite, search } = await setup();
    repo(sqlite, "ann", "plain");
    repo(sqlite, "ann", "100_percent", { description: "100% done" });
    for (const q of ["%", "_", "\\"])
      expect(
        titles(group(await search({ q, categories: "repositories" }), "repositories")),
        q,
      ).toEqual(q === "\\" ? [] : ["ann/100_percent"]);
  });

  test("pages with cursors bound to their query, up to the documented depth", async () => {
    const { sqlite, search, call } = await setup();
    sqlite.exec("BEGIN");
    for (let i = 0; i < 130; i++) {
      const slug = `bulk-${String(i).padStart(3, "0")}`;
      sqlite
        .prepare(`INSERT INTO accounts (id, kind, slug, display_name) VALUES (?, 'user', ?, ?)`)
        .run(slug, slug, `Bulk ${i}`);
    }
    sqlite.exec("COMMIT");
    const seen: string[] = [];
    let cursor: string | null = null;
    let last: SearchGroup | undefined;
    do {
      const params: Record<string, string> = { q: "bulk", categories: "accounts", limit: "20" };
      if (cursor) params.cursor = cursor;
      last = group(await search(params), "accounts");
      if (last.status !== "ok") break;
      seen.push(...last.results.map((r) => r.id));
      cursor = last.cursor;
    } while (cursor);
    expect(seen).toHaveLength(SEARCH_LIMITS.maxOffset);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toBe("accounts:bulk-000");
    expect(last).toMatchObject({ cursor: null, truncated: true });
    expect(
      (
        await call({
          q: "bulk",
          categories: "accounts",
          cursor: btoa(JSON.stringify({ v: 1, c: "accounts", q: "bulk", o: 20 })),
        })
      ).status,
    ).toBe(400);

    // A cursor only resumes the query and category that issued it.
    const first = group(await search({ q: "bulk", categories: "accounts" }), "accounts");
    expect(first.cursor).not.toBeNull();
    for (const params of [
      { q: "bulk 1", categories: "accounts", cursor: first.cursor! },
      { q: "bulk", categories: "repositories", cursor: first.cursor! },
      { q: "bulk", categories: "accounts,repositories", cursor: first.cursor! },
    ])
      expect((await call(params)).status).toBe(400);
  });

  test("reports a failing or slow category as unavailable without losing the others", async () => {
    const failing: SearchProvider<"accounts"> = {
      category: "accounts",
      search: async () => {
        throw new Error("D1_ERROR: no such table");
      },
    };
    const slow: SearchProvider<"conversations"> = {
      category: "conversations",
      search: () => new Promise(() => {}),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { sqlite, search } = await setup([D1_PROVIDERS[0]!, failing, slow]);
    repo(sqlite, "orbit", "engine");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = search({ q: "engine" });
    await vi.advanceTimersByTimeAsync(SEARCH_LIMITS.timeoutMs);
    const response = await pending;
    expect(response.groups).toEqual([
      expect.objectContaining({ category: "repositories", status: "ok" }),
      {
        category: "accounts",
        status: "unavailable",
        error: "Couldn't search people right now.",
      },
      {
        category: "conversations",
        status: "unavailable",
        error: "Couldn't search conversations right now.",
      },
    ]);
    expect(titles(response.groups[0]!)).toEqual(["orbit/engine"]);
    // Internal errors stay in the log.
    expect(JSON.stringify(response)).not.toContain("D1_ERROR");
  });

  test("is never stored by a shared cache", async () => {
    const { call } = await setup();
    expect((await call({ q: "orbit" })).headers.get("cache-control")).toBe("private, no-store");
  });
});
