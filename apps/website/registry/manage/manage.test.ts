import { beforeEach, describe, expect, it } from "vite-plus/test";

import type {
  BulkActionResult,
  FeedSummary,
  OwnerPackages,
  PackageDetail,
  PackageSource,
  Published,
  PublishPage,
} from "../../shared/packages.ts";
import { publishBody } from "../formats/npm/testing.ts";
import { basic, makeHarness, purgedRepoObjects, type Harness } from "../testing/harness.ts";

describe("packages API", () => {
  let h: Harness;
  let admin: string;

  const call = async <T>(path: string, token?: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    const res = await h.request(`/api/packages${path}`, { ...init, headers });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const post = <T>(path: string, token: string, body: unknown, method = "POST") =>
    call<T>(path, token, { method, body: JSON.stringify(body) });

  const deploy = (path: string, token: string, body = "payload") =>
    h.request(`/generic/test/${path}`, {
      method: "PUT",
      headers: { authorization: basic(token) },
      body,
    });

  /** web publishes builds from main and a feature branch; api is added as a source. */
  async function seed() {
    for (let i = 1; i <= 6; i++) {
      const job = h.jobToken({ repo: "web", ref: i <= 4 ? "main" : "feature/login" });
      expect((await deploy(`web/1.0.${i}/web.tgz`, job.token, "x".repeat(i))).status).toBe(201);
    }
    const api = h.jobToken({ repo: "api", ref: "main" });
    expect((await post(`/test/generic/web/sources`, admin, { repo: "api" })).status).toBe(200);
    expect((await deploy(`web/2.0.0-api/web.tgz`, api.token)).status).toBe(201);
    return { api };
  }

  beforeEach(async () => {
    h = await makeHarness();
    h.grant("dana", "admin");
    admin = h.token("dana");
  });

  it("lists an owner's packages with their sources and recent activity", async () => {
    await seed();
    const { status, body } = await call<OwnerPackages>("/test", admin);
    expect(status).toBe(200);
    expect(body.access).toBe("admin");
    expect(body.packages).toHaveLength(1);
    expect(body.packages[0]).toMatchObject({
      format: "generic",
      name: "web",
      feed: "test",
      versions: 7,
      publishes24h: 7,
      latest: "2.0.0-api",
      sources: ["test/web", "test/api"],
    });
    expect(body.packages[0]!.spark).toHaveLength(24);
    expect(body.feeds.map((f) => [f.key, f.kind, f.packages])).toEqual([["test", "local", 1]]);
    // Someone with no access sees the owner but none of its private packages.
    const outsider = await call<OwnerPackages>("/test", h.token("eve"));
    expect(outsider.body.packages).toEqual([]);
    expect(outsider.body.access).toBeNull();
  });

  it("queries a package's history with facets and a publish-rate histogram", async () => {
    await seed();
    const all = await call<PublishPage>("/test/generic/web/publishes?q=", admin);
    expect(all.body.total).toBe(7);
    expect(all.body.rows[0]).toMatchObject({ version: "2.0.0-api", repo: "test/api", ref: "main" });
    const h0 = all.body.histogram!;
    expect(h0.active.reduce((a, b) => a + b, 0)).toBe(7);

    const main = await call<PublishPage>(
      `/test/generic/web/publishes?q=${encodeURIComponent("branch:main source:web")}`,
      admin,
    );
    expect(main.body.total).toBe(4);
    // A facet counts under every other filter, so its siblings stay visible.
    expect(main.body.facets!.branch).toEqual(
      expect.arrayContaining([
        { value: "main", count: 4 },
        { value: "feature/login", count: 2 },
      ]),
    );
    expect(main.body.facets!.source).toEqual([
      { value: "test/web", count: 4 },
      { value: "test/api", count: 1 },
    ]);

    const glob = await call<PublishPage>(
      `/test/generic/web/publishes?q=${encodeURIComponent("branch:feature/* -1.0.5")}`,
      admin,
    );
    expect(glob.body.rows.map((r) => r.version)).toEqual(["1.0.6"]);
    const negated = await call<PublishPage>(
      `/test/generic/web/publishes?q=${encodeURIComponent("-branch:main 1.0")}`,
      admin,
    );
    expect(negated.body.rows.map((r) => r.version)).toEqual(["1.0.6", "1.0.5"]);

    const window = await call<PublishPage>("/test/generic/web/publishes?offset=2&limit=2", admin);
    expect(window.body.rows).toHaveLength(2);
    expect(window.body.facets).toBeUndefined();

    const bad = await call<{ error: string }>("/test/generic/web/publishes?q=colour:red", admin);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("colour:red");
  });

  it("deletes everything a query matches, and only admins may", async () => {
    await seed();
    const job = h.jobToken({ repo: "web" });
    const refused = await post("/test/generic/web/actions", job.token, {
      action: "delete",
      query: "branch:feature/*",
    });
    expect(refused.status).toBe(403);

    const { body } = await post<BulkActionResult>("/test/generic/web/actions", admin, {
      action: "delete",
      query: "branch:feature/*",
    });
    expect(body.done.sort()).toEqual(["1.0.5", "1.0.6"]);
    expect(body.remaining).toBe(0);
    expect(
      (
        await h.request("/generic/test/web/1.0.5/web.tgz", {
          headers: { authorization: basic(admin) },
        })
      ).status,
    ).toBe(404);
    const deleted = await call<PublishPage>("/test/generic/web/publishes?q=status:deleted", admin);
    expect(deleted.body.total).toBe(2);
  });

  it("deprecates and tags npm versions through the package document", async () => {
    const job = h.jobToken({ repo: "ui" });
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
      const res = await h.request("/npm/test/@test%2fui", {
        method: "PUT",
        headers: { authorization: `Bearer ${job.token}`, "content-type": "application/json" },
        body: publishBody("@test/ui", version),
      });
      expect(res.status).toBe(201);
    }
    const detail = await call<PackageDetail>(`/test/npm/${encodeURIComponent("@test/ui")}`, admin);
    expect(detail.body.actions).toEqual(["delete", "deprecate", "unyank", "tag"]);
    expect(detail.body.tags).toEqual({ latest: "1.2.0" });

    const dep = await post<BulkActionResult>(
      `/test/npm/${encodeURIComponent("@test/ui")}/actions`,
      admin,
      {
        action: "deprecate",
        versions: ["1.0.0"],
        reason: "use 1.2",
      },
    );
    expect(dep.body.done).toEqual(["1.0.0"]);
    const tag = await post<BulkActionResult>(
      `/test/npm/${encodeURIComponent("@test/ui")}/actions`,
      admin,
      {
        action: "tag",
        versions: ["1.1.0"],
        tag: "stable",
      },
    );
    expect(tag.body.failed).toEqual([]);

    const doc = (await (
      await h.request("/npm/test/@test%2fui", { headers: { authorization: `Bearer ${admin}` } })
    ).json()) as {
      "dist-tags": Record<string, string>;
      versions: Record<string, { deprecated?: string }>;
    };
    expect(doc["dist-tags"]).toEqual({ latest: "1.2.0", stable: "1.1.0" });
    expect(doc.versions["1.0.0"]!.deprecated).toBe("use 1.2");
    const history = await call<PublishPage>(
      `/test/npm/${encodeURIComponent("@test/ui")}/publishes?q=status:deprecated`,
      admin,
    );
    expect(history.body.rows.map((r) => r.version)).toEqual(["1.0.0"]);
    const tagged = await call<PublishPage>(
      `/test/npm/${encodeURIComponent("@test/ui")}/publishes?q=tag:stable`,
      admin,
    );
    expect(tagged.body.rows.map((r) => [r.version, r.tags])).toEqual([["1.1.0", ["stable"]]]);
  });

  it("grants and revokes sources", async () => {
    const web = h.jobToken({ repo: "web" });
    await deploy("web/1/a", web.token);
    const api = h.jobToken({ repo: "api" });
    expect((await deploy("web/2/a", api.token)).status).toBe(403);

    h.grant("bob", "write");
    const denied = await post("/test/generic/web/sources", h.token("bob"), { repo: "test/api" });
    expect(denied.status).toBe(403);

    const granted = await post<{ sources: PackageSource[] }>("/test/generic/web/sources", admin, {
      repo: "test/api",
    });
    expect(granted.body.sources.map((s) => [s.repo, s.publishes])).toEqual([
      ["test/web", 1],
      ["test/api", 0],
    ]);
    expect((await deploy("web/2/a", api.token)).status).toBe(201);

    const revoked = await call<{ sources: PackageSource[] }>(
      `/test/generic/web/sources/${api.repoId}`,
      admin,
      { method: "DELETE" },
    );
    expect(revoked.body.sources.map((s) => s.repo)).toEqual(["test/web"]);
    expect((await deploy("web/3/a", h.jobToken({ repo: "api" }).token)).status).toBe(403);
  });

  it("creates proxies and virtual feeds, owner admins only", async () => {
    h.grant("bob", "write");
    const denied = await post("/test/feeds", h.token("bob"), {
      format: "npm",
      kind: "remote",
      name: "npmjs",
    });
    expect(denied.status).toBe(403);

    const proxy = await post<FeedSummary>("/test/feeds", admin, {
      format: "npm",
      kind: "remote",
      name: "npmjs",
      upstreamUsername: "me",
      upstreamPassword: "hunter2",
    });
    expect(proxy.status).toBe(201);
    expect(proxy.body).toMatchObject({
      key: "test.npmjs",
      kind: "remote",
      upstream: "https://registry.npmjs.org",
    });
    expect(JSON.stringify(proxy.body)).not.toContain("hunter2");

    // The owner's own npm registry exists on first use.
    await h.request("/npm/test/-/ping", { headers: { authorization: `Bearer ${admin}` } });
    await call("/test", admin);
    const all = await post<FeedSummary>("/test/feeds", admin, {
      format: "npm",
      kind: "virtual",
      name: "all",
      members: ["test", "test.npmjs"],
    });
    expect(all.body.members).toEqual(["test", "test.npmjs"]);

    const kept = await post<FeedSummary>(
      "/test/feeds/npm/test",
      admin,
      { retention: { keepLatest: 50, maxAgeDays: 30 }, visibility: "internal" },
      "PATCH",
    );
    expect(kept.body).toMatchObject({
      visibility: "internal",
      retention: { keepLatest: 50, maxAgeDays: 30 },
    });

    expect((await call("/test/feeds/npm/test", admin, { method: "DELETE" })).status).toBe(400);
    expect((await call("/test/feeds/npm/test.all", admin, { method: "DELETE" })).status).toBe(204);
    // Its Durable Object is purged through the registry, which records it (CORE-205).
    expect(purgedRepoObjects).toEqual(["registry repository deleted"]);
    expect(
      await h.gitmatrix
        .prepare(
          "SELECT purge_reason FROM do_instances WHERE class = 'RegistryRepo' AND purged_at IS NOT NULL",
        )
        .all(),
    ).toMatchObject({ results: [{ purge_reason: "registry repository deleted" }] });
  });

  it("shows what a commit and a CI run published", async () => {
    const job = h.jobToken({ repo: "web" });
    await deploy("web/1.0.0/web.tgz", job.token);
    const byCommit = await call<Published>(
      `/-/published?repo=test/web&commit=${job.commit}`,
      admin,
    );
    expect(byCommit.body.rows.map((r) => [r.format, r.package, r.version])).toEqual([
      ["generic", "web", "1.0.0"],
    ]);
    const run = Number(job.runId.replace("run_", ""));
    const byRun = await call<Published>(`/-/published?repo=test/web&run=${run}`, admin);
    expect(byRun.body.rows).toHaveLength(1);
    // Nothing leaks to people who can't read the feed.
    const outsider = await call<Published>(
      `/-/published?repo=test/web&commit=${job.commit}`,
      h.token("eve"),
    );
    expect(outsider.body.rows).toEqual([]);
  });
});
