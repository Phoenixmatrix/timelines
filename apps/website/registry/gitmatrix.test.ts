// What the artifact store adds in gitmatrix: Space registries that exist on
// first use, CI jobs publishing as their repository, packages remembering
// their sources, and a provenance row for every publish.

import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createDb } from "./core/db.ts";
import { bearer, pushImage } from "./formats/oci/testing.ts";
import { publishBody } from "./formats/npm/testing.ts";
import { basic, makeHarness, SPACE_ID, type Harness } from "./testing/harness.ts";

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

  it("creates a Space registry on first use, owned by that Space and private", async () => {
    const job = await h.jobToken();
    expect((await deploy("app/1.0.0/app.tar.gz", job.token)).status).toBe(201);
    const feed = await db()
      .selectFrom("repositories")
      .selectAll()
      .where("key", "=", "test")
      .where("format", "=", "generic")
      .executeTakeFirstOrThrow();
    expect(feed).toMatchObject({ space_id: SPACE_ID, kind: "local", visibility: "private" });
    // Nobody else's slug gets a registry.
    expect((await h.request("/generic/nobody/x/1/y")).status).toBe(404);
    // Private: anonymous readers are challenged, never told it's missing.
    expect((await h.request("/generic/test/app/1.0.0/app.tar.gz")).status).toBe(401);
  });

  it("records where every publish came from", async () => {
    const job = await h.jobToken({ repo: "web", ref: "feature/login" });
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
    const web = await h.jobToken({ repo: "web" });
    expect((await deploy("web/1/a", web.token)).status).toBe(201);
    const sources = await db().selectFrom("package_sources").selectAll().execute();
    expect(sources.map((s) => s.git_repo_id)).toEqual([web.repoId]);

    // Another repository in the same Space is refused, and told why.
    const api = await h.jobToken({ repo: "api" });
    const denied = await deploy("web/2/a", api.token);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("not an authorized source");

    // Until a Space admin grants it as a source.
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

  it("refuses CI jobs from another Space's repositories", async () => {
    const outsider = await h.jobToken({ space: "acc_priya", repo: "fork" });
    expect((await deploy("thing/1/a", outsider.token)).status).toBe(403);
    expect(await publishes()).toHaveLength(0);
    // A refused first publish leaves no package behind.
    expect(await db().selectFrom("packages").selectAll().execute()).toHaveLength(0);
  });

  it("requires package write independently of write on a package source", async () => {
    const web = await h.jobToken({ repo: "web" });
    const api = await h.jobToken({ repo: "api" });
    await deploy("web/1/a", web.token);
    await deploy("api/1/a", api.token);
    // Bob can publish packages but gets no repository baseline.
    h.grant("bob", "write");
    h.gitmatrix.applySql(
      `UPDATE space_grants SET repository_role = 'none' WHERE space_id = '${SPACE_ID}' AND account_id = 'acc_bob'`,
    );
    h.gitmatrix.applySql(
      `INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('${web.repoId}', 'acc_bob', 'write')`,
    );
    const bob = h.token("bob");
    expect((await deploy("web/2/a", bob)).status).toBe(201);
    const denied = await deploy("api/2/a", bob);
    expect(denied.status).toBe(403);
    const denial = await denied.text();
    expect(denial).toContain("authorized source");
    expect(denial).not.toContain("test/api");
    // A package-read member cannot publish, even with a repository grant.
    h.grant("carol", "read");
    expect((await deploy("notes/1/a", h.token("carol"))).status).toBe(403);
    h.collaborate("outsider", "web", "write");
    expect((await deploy("web/3/a", h.token("outsider"))).status).toBe(403);
  });

  it("keeps package read independent of repository none and revokes it on the next request", async () => {
    const job = await h.jobToken();
    await deploy("app/1/a", job.token);
    h.grant("reader", "read");
    const headers = { authorization: basic(h.token("reader")) };
    const read = () => h.request("/generic/test/app/1/a", { headers });
    expect((await read()).status).toBe(200);
    expect((await deploy("app/2/a", h.token("reader"))).status).toBe(403);
    h.gitmatrix.applySql(
      `DELETE FROM space_grants WHERE space_id = '${SPACE_ID}' AND account_id = 'acc_reader'`,
    );
    expect((await read()).status).toBe(403);
    h.grant("reader", "read");
    expect((await read()).status).toBe(200);
    h.gitmatrix.applySql(`DELETE FROM organization_members WHERE account_id = 'acc_reader'`);
    expect((await read()).status).toBe(403);
  });

  it("does not let Organization ownership or repository collaboration authorize private packages", async () => {
    await deploy("app/1/a", (await h.jobToken()).token);
    h.grant("directory-admin", "none");
    h.gitmatrix.applySql(
      `UPDATE organization_members SET role = 'owner' WHERE account_id = 'acc_directory-admin'`,
    );
    h.gitmatrix.applySql(`DELETE FROM space_grants WHERE account_id = 'acc_directory-admin'`);
    h.collaborate("collaborator", "app", "write");
    for (const person of ["directory-admin", "collaborator"]) {
      expect(
        (
          await h.request("/generic/test/app/1/a", {
            headers: { authorization: basic(h.token(person)) },
          })
        ).status,
      ).toBe(403);
    }
  });

  it("observes public-to-private feed changes without a warm cache grant", async () => {
    await deploy("app/1/a", (await h.jobToken()).token);
    await db()
      .updateTable("repositories")
      .set({ visibility: "public" })
      .where("key", "=", "test")
      .execute();
    expect((await h.request("/generic/test/app/1/a")).status).toBe(200);
    await db()
      .updateTable("repositories")
      .set({ visibility: "private" })
      .where("key", "=", "test")
      .execute();
    expect((await h.request("/generic/test/app/1/a")).status).toBe(401);
  });

  it("keeps CI job credentials only as long as the job runs", async () => {
    const job = await h.jobToken();
    expect((await deploy("app/1/a", job.token)).status).toBe(201);
    h.gitmatrix.applySql(`UPDATE ci_jobs SET status = 'succeeded' WHERE id = '${job.jobId}'`);
    expect((await deploy("app/2/a", job.token)).status).toBe(401);
  });

  it("marks deletions in the history instead of forgetting them", async () => {
    const job = await h.jobToken();
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
    const job = await h.jobToken({ repo: "web" });
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
    const web = await h.jobToken({ repo: "web" });
    const put = (token: string, version: string) =>
      h.request("/npm/test/@test%2fui", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: publishBody("@test/ui", version),
      });
    expect((await put(web.token, "1.0.0")).status).toBe(201);
    expect((await put((await h.jobToken({ repo: "api" })).token, "1.0.1")).status).toBe(403);
    const rows = await publishes();
    expect(rows.map((r) => [r.format, r.version, r.git_repo_id])).toEqual([
      ["npm", "1.0.0", web.repoId],
    ]);
  });
});
