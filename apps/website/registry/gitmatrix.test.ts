// What the artifact store adds in gitmatrix: owner registries that exist on
// first use, CI jobs publishing as their repository, packages remembering
// their sources, and a provenance row for every publish.

import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createDb } from "./core/db.ts";
import { bearer, pushImage } from "./formats/oci/testing.ts";
import { publishBody } from "./formats/npm/testing.ts";
import { basic, makeHarness, OWNER_ID, type Harness } from "./testing/harness.ts";

describe("gitmatrix integration", () => {
  let h: Harness;
  const db = () => createDb(h.env.REGISTRY_DB);

  const deploy = (path: string, token: string, body = "payload") =>
    h.request(`/generic/test/${path}`, {
      method: "PUT",
      headers: { authorization: basic(token) },
      body,
    });

  const publishes = () =>
    db().selectFrom("publishes").selectAll().orderBy("at").orderBy("id").execute();

  beforeEach(async () => {
    h = await makeHarness();
  });

  it("creates an owner's registry on first use, owned by them and private", async () => {
    const job = h.jobToken();
    expect((await deploy("app/1.0.0/app.tar.gz", job.token)).status).toBe(201);
    const feed = await db()
      .selectFrom("repositories")
      .selectAll()
      .where("key", "=", "test")
      .where("format", "=", "generic")
      .executeTakeFirstOrThrow();
    expect(feed).toMatchObject({ owner_id: OWNER_ID, kind: "local", visibility: "private" });
    // Nobody else's slug gets a registry.
    expect((await h.request("/generic/nobody/x/1/y")).status).toBe(404);
    // Private: anonymous readers are challenged, never told it's missing.
    expect((await h.request("/generic/test/app/1.0.0/app.tar.gz")).status).toBe(401);
  });

  it("records where every publish came from", async () => {
    const job = h.jobToken({ repo: "web", ref: "feature/login" });
    await deploy("web/1.4.0-main.12/web.tar.gz", job.token, "aaaa");
    await deploy("web/1.4.0-main.12/web.tar.gz.sha256", job.token, "bb");
    const rows = await publishes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      format: "generic",
      version: "1.4.0-main.12",
      size: 6,
      git_repo_id: job.repoId,
      commit_oid: job.commit,
      ref: "feature/login",
      ci_run_id: job.runId,
      ci_job_id: job.jobId,
      actor: `job:${job.jobId}`,
      via: "job",
      status: "active",
    });
    expect(rows[0]!.actor_label).toContain("test/web");
  });

  it("lets the first CI publish claim a package for its repository", async () => {
    const web = h.jobToken({ repo: "web" });
    expect((await deploy("web/1/a", web.token)).status).toBe(201);
    const sources = await db().selectFrom("package_sources").selectAll().execute();
    expect(sources.map((s) => s.git_repo_id)).toEqual([web.repoId]);

    // Another repository of the same owner is refused, and told why.
    const api = h.jobToken({ repo: "api" });
    const denied = await deploy("web/2/a", api.token);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("test/web");

    // Until an owner admin grants it as a source.
    await db()
      .insertInto("package_sources")
      .values({
        package_id: sources[0]!.package_id,
        git_repo_id: api.repoId,
        granted_by: "user:acc_admin",
        granted_at: new Date().toISOString(),
      })
      .execute();
    expect((await deploy("web/2/a", api.token)).status).toBe(201);
  });

  it("refuses CI jobs from another owner's repositories", async () => {
    const outsider = h.jobToken({ owner: "acc_priya", repo: "fork" });
    expect((await deploy("thing/1/a", outsider.token)).status).toBe(403);
    expect(await publishes()).toHaveLength(0);
    // A refused first publish leaves no package behind.
    expect(await db().selectFrom("packages").selectAll().execute()).toHaveLength(0);
  });

  it("lets people publish a package when they can write one of its sources", async () => {
    const web = h.jobToken({ repo: "web" });
    const api = h.jobToken({ repo: "api" });
    await deploy("web/1/a", web.token);
    await deploy("api/1/a", api.token);
    // An org that gives members read only; bob writes test/web as a collaborator.
    h.gitmatrix.applySql(`UPDATE accounts SET member_repo_role = 'read' WHERE id = '${OWNER_ID}'`);
    h.grant("bob", "write");
    h.gitmatrix.applySql(
      `INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('${web.repoId}', 'acc_bob', 'write')`,
    );
    const bob = h.token("bob");
    expect((await deploy("web/2/a", bob)).status).toBe(201);
    const denied = await deploy("api/2/a", bob);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("test/api");
    // A read-only collaborator can't publish at all.
    h.grant("carol", "read");
    expect((await deploy("notes/1/a", h.token("carol"))).status).toBe(403);
  });

  it("keeps CI job credentials only as long as the job runs", async () => {
    const job = h.jobToken();
    expect((await deploy("app/1/a", job.token)).status).toBe(201);
    h.gitmatrix.applySql(`UPDATE ci_jobs SET status = 'succeeded' WHERE id = '${job.jobId}'`);
    expect((await deploy("app/2/a", job.token)).status).toBe(401);
  });

  it("marks deletions in the history instead of forgetting them", async () => {
    const job = h.jobToken();
    await deploy("app/1/a", job.token);
    h.grant("dana", "admin");
    const del = await h.request("/generic/test/app/1", {
      method: "DELETE",
      headers: { authorization: basic(h.token("dana")) },
    });
    expect(del.status).toBe(204);
    expect((await publishes()).map((p) => p.status)).toEqual(["deleted"]);
    // CI jobs never delete.
    await deploy("app/2/a", job.token);
    const jobDelete = await h.request("/generic/test/app/2", {
      method: "DELETE",
      headers: { authorization: basic(job.token) },
    });
    expect(jobDelete.status).toBe(403);
  });

  it("records docker pushes from CI through the token flow", async () => {
    const job = h.jobToken({ repo: "web" });
    const auth = await bearer(h, job.token, ["repository:test/web:pull,push"]);
    await pushImage(h, auth, "test/web", "sha-abc123", "layer bytes");
    const rows = await publishes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      format: "oci",
      version: "sha-abc123",
      git_repo_id: job.repoId,
      commit_oid: job.commit,
      via: "job",
    });
    expect(rows[0]!.digest).toMatch(/^sha256:/);
    expect(rows[0]!.size).toBeGreaterThan(0);
  });

  it("gates npm publishes the same way", async () => {
    const web = h.jobToken({ repo: "web" });
    const put = (token: string, version: string) =>
      h.request("/npm/test/@test%2fui", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: publishBody("@test/ui", version),
      });
    expect((await put(web.token, "1.0.0")).status).toBe(201);
    expect((await put(h.jobToken({ repo: "api" }).token, "1.0.1")).status).toBe(403);
    const rows = await publishes();
    expect(rows.map((r) => [r.format, r.version, r.git_repo_id])).toEqual([
      ["npm", "1.0.0", web.repoId],
    ]);
  });
});
