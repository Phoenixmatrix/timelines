import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import type { PackageResult, SearchResponse } from "../../shared/search.ts";
import { makeHarness, type Harness } from "../../registry/testing/harness.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { searchApi } from "./api.ts";
import { packages } from "./packages.ts";

let h: Harness;
let feeds: Record<string, string>;
let added = 0;

/** A package row in a feed, as publishing would leave it. */
function addPackage(feed: string, name: string) {
  const id = `pkg_${++added}`;
  h.db.applySql(
    `INSERT INTO packages (id, repo_id, name, normalized_name, created_at, updated_at)
     VALUES ('${id}', '${feeds[feed]}', '${name}', '${name.toLowerCase()}',
       '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  );
}

async function feed(input: Record<string, unknown>) {
  const response = await h.createRepo(input);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** Search as whoever holds `token`: the registry authenticates the request itself. */
async function search(token: string, params: Record<string, string>) {
  const app = new Hono<AppEnv>();
  const actor: Actor = {
    id: "acc_viewer",
    slug: "viewer",
    displayName: "Viewer",
    isSiteAdmin: false,
  };
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api/search", searchApi([packages]));
  const response = await app.request(
    `/api/search?${new URLSearchParams({ categories: "packages", ...params }).toString()}`,
    { headers: { authorization: `Bearer ${token}` } },
    h.env,
  );
  expect(response.status).toBe(200);
  const group = ((await response.json()) as SearchResponse).groups[0]!;
  if (group.status !== "ok") throw new Error(group.error);
  return { ...group, results: group.results as PackageResult[] };
}

const names = (results: PackageResult[]) =>
  results.map((r) => `${r.space.slug}/${r.format}/${r.name}`);

beforeEach(async () => {
  h = await makeHarness();
  added = 0;
  feeds = {
    // The harness's org `test`: private feeds, read by its members.
    testGeneric: await feed({
      key: "test",
      format: "generic",
      kind: "local",
      visibility: "private",
    }),
    testNpm: await feed({ key: "test", format: "npm", kind: "local", visibility: "private" }),
    // Another org's public feed.
    pubNpm: await feed({
      space: "pubco",
      key: "pubco",
      format: "npm",
      kind: "local",
      visibility: "public",
    }),
  };
  addPackage("testGeneric", "shared");
  addPackage("testNpm", "shared");
  addPackage("testGeneric", "secret-build");
  addPackage("pubNpm", "shared");
  addPackage("pubNpm", "left-pad");
});

describe("package search", () => {
  test("finds public packages anywhere, and only them for an outsider", async () => {
    const outsider = h.token("olly");
    const { results, cursor, truncated } = await search(outsider, { q: "shared" });
    expect(names(results)).toEqual(["pubco/npm/shared"]);
    expect([cursor, truncated]).toEqual([null, false]);
    expect((await search(outsider, { q: "secret" })).results).toEqual([]);
    expect(results[0]).toMatchObject({
      id: expect.stringMatching(/^packages:/),
      title: "shared",
      subtitle: "npm · pubco",
      breadcrumb: ["pubco", "npm"],
      match: "exact",
      target: { kind: "path", path: "/pubco/-/packages/npm/shared" },
    });
  });

  test("members see their org's private feeds; equal names stay distinct by owner and format", async () => {
    h.grant("mia", "write");
    const member = h.token("mia");
    const { results } = await search(member, { q: "shared" });
    // All exact: ties go to name, then format, then owner.
    expect(names(results)).toEqual(["test/generic/shared", "pubco/npm/shared", "test/npm/shared"]);
    expect(new Set(results.map((r) => r.id)).size).toBe(3);
    expect(names((await search(member, { q: "secret" })).results)).toEqual([
      "test/generic/secret-build",
    ]);
  });

  test("a qualified owner/name is exact and ranks first", async () => {
    h.grant("mia", "write");
    const { results } = await search(h.token("mia"), { q: "test/shared" });
    expect(results.map((r) => [`${r.space.slug}/${r.format}/${r.name}`, r.match])).toEqual([
      ["test/generic/shared", "exact"],
      ["test/npm/shared", "exact"],
    ]);
  });

  test("losing membership hides private packages at once", async () => {
    h.grant("mia", "write");
    const token = h.token("mia");
    expect((await search(token, { q: "secret" })).results).toHaveLength(1);
    h.gitmatrix.applySql(`DELETE FROM organization_members WHERE account_id = 'acc_mia'`);
    expect((await search(token, { q: "secret" })).results).toEqual([]);
  });

  test("a CI job reads only feeds allowed by its current Space package grant", async () => {
    const job = await h.jobToken({ repo: "web" });
    expect(names((await search(job.token, { q: "secret" })).results)).toEqual([
      "test/generic/secret-build",
    ]);
    const elsewhere = await h.jobToken({ repo: "app", space: "acc_pubco" });
    expect((await search(elsewhere.token, { q: "secret" })).results).toEqual([]);
  });

  test("repository collaborators and Organization owners without grants cannot search private packages", async () => {
    h.collaborate("collaborator");
    expect((await search(h.token("collaborator"), { q: "secret" })).results).toEqual([]);
    const token = h.token("company-owner");
    h.gitmatrix.applySql(`INSERT INTO organization_members
      (organization_id, account_id, role, origin, granted_by)
      VALUES ('org_test', 'acc_company-owner', 'owner', 'test-fixture', 'acc_company-owner')`);
    expect((await search(token, { q: "secret" })).results).toEqual([]);
  });

  test("package read is independent of repository baseline and old cursors recheck revoked grants", async () => {
    h.grant("reader", "read");
    const token = h.token("reader");
    for (let i = 0; i < 8; i++) addPackage("testGeneric", `private-lib-${i}`);
    const first = await search(token, { q: "private-lib", limit: "2" });
    expect(first.results).toHaveLength(2);
    expect(first.cursor).not.toBeNull();
    h.gitmatrix.applySql(`DELETE FROM space_grants WHERE account_id = 'acc_reader'`);
    expect(
      (await search(token, { q: "private-lib", limit: "2", cursor: first.cursor! })).results,
    ).toEqual([]);
    expect((await search(token, { q: "private-lib" })).results).toEqual([]);
  });

  test("pages within the shared bounds without crossing into unreadable feeds", async () => {
    for (let i = 0; i < 12; i++) addPackage("pubNpm", `lib-${String(i).padStart(2, "0")}`);
    for (let i = 0; i < 5; i++) addPackage("testNpm", `lib-private-${i}`);
    const outsider = h.token("olly");
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const params: Record<string, string> = { q: "lib", limit: "5" };
      if (cursor) params.cursor = cursor;
      const page = await search(outsider, params);
      seen.push(...names(page.results));
      cursor = page.cursor;
    } while (cursor);
    expect(seen).toHaveLength(12);
    expect(seen.every((name) => name.startsWith("pubco/npm/lib-"))).toBe(true);
  });
});
