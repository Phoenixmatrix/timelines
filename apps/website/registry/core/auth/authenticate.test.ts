import { beforeEach, describe, expect, it } from "vite-plus/test";

import { basic, makeHarness, type Harness } from "../../testing/harness.ts";
import { bearer, jwtClaims } from "../../formats/oci/testing.ts";
import { authenticate, currentPerson, hashSecret } from "./authenticate.ts";

// Exercise the real native /v2 token flow: no application JSON-version header.
describe("registry live credentials", () => {
  let h: Harness;
  let secret: string;

  beforeEach(async () => {
    h = await makeHarness({ BETTER_AUTH_SECRET: "registry-test-secret-registry-test-secret" });
    secret = h.token("alice");
    h.grant("alice", "write");
    expect(
      (await h.createRepo({ key: "images", format: "oci", kind: "local", visibility: "private" }))
        .status,
    ).toBe(201);
  });

  async function upload(authorization: string): Promise<Response> {
    return h.request("/v2/images/app/blobs/uploads/", {
      method: "POST",
      headers: { authorization },
    });
  }

  it("revokes an underlying access token immediately for both PAT and JWT", async () => {
    const jwt = await bearer(h, secret, ["repository:images/app:pull,push"]);
    expect((await upload(jwt)).status).toBe(202);
    h.gitmatrix.applySql(
      `DELETE FROM access_tokens WHERE token_hash = '${await hashSecret(secret)}'`,
    );
    expect((await upload(basic(secret))).status).toBe(401);
    expect((await upload(jwt)).status).toBe(401);
  });

  it("applies token expiry and narrower current scope to already issued JWTs", async () => {
    const jwt = await bearer(h, secret, ["repository:images/app:pull,push"]);
    const hash = await hashSecret(secret);
    h.gitmatrix.applySql(`UPDATE access_tokens SET scope = 'read' WHERE token_hash = '${hash}'`);
    expect((await upload(jwt)).status).toBe(401);
    h.gitmatrix.applySql(
      `UPDATE access_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = '${hash}'`,
    );
    expect((await h.request("/v2/", { headers: { authorization: jwt } })).status).toBe(401);
  });

  it("preserves agent attribution and rejects revoked or rebound agents", async () => {
    h.gitmatrix
      .applySql(`INSERT INTO agents (id, name, accountable_id) VALUES ('agent_alice', 'builder', 'acc_alice');
      UPDATE access_tokens SET agent_id = 'agent_alice' WHERE token_hash = '${await hashSecret(secret)}'`);
    const actor = await authenticate(h.env, new Headers({ authorization: basic(secret) }));
    expect(actor).toMatchObject({ personId: "acc_alice", agentId: "agent_alice" });
    expect(await currentPerson(h.env.DB, actor)).toMatchObject({
      id: "acc_alice",
      agent: { id: "agent_alice" },
    });
    const jwt = await bearer(h, secret, ["repository:images/app:pull,push"]);
    expect((await upload(jwt)).status).toBe(202);
    h.gitmatrix.applySql(
      "UPDATE agents SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE id = 'agent_alice'",
    );
    expect((await upload(basic(secret))).status).toBe(401);
    expect((await upload(jwt)).status).toBe(401);
    h.token("bob");
    h.gitmatrix.applySql(
      "UPDATE agents SET revoked_at = NULL, accountable_id = 'acc_bob' WHERE id = 'agent_alice'",
    );
    expect((await upload(jwt)).status).toBe(401);
    expect((await upload(basic(secret))).status).toBe(401);
  });

  it("does not preserve stale operator powers or revoked Space grants in JWTs", async () => {
    const admin = await h.adminToken();
    const jwt = await bearer(h, admin, ["repository:images/app:pull,push"]);
    expect((await upload(jwt)).status).toBe(202);
    h.gitmatrix.applySql("UPDATE accounts SET is_site_admin = 0 WHERE id = 'acc_admin'");
    expect((await upload(jwt)).status).toBe(401);
    const member = await bearer(h, secret, ["repository:images/app:pull,push"]);
    expect((await upload(member)).status).toBe(202);
    h.gitmatrix.applySql("DELETE FROM space_grants WHERE account_id = 'acc_alice'");
    expect((await upload(member)).status).toBe(401);
    expect((await upload(basic(secret))).status).toBe(403);
  });

  it("rejects JWTs after Organization membership removal even if a grant row remains", async () => {
    const jwt = await bearer(h, secret, ["repository:images/app:pull,push"]);
    h.gitmatrix.applySql("DELETE FROM organization_members WHERE account_id = 'acc_alice'");
    expect((await upload(jwt)).status).toBe(401);
  });

  it("cannot exchange an image-scoped JWT for sibling image rights", async () => {
    const jwt = await bearer(h, secret, ["repository:images/app:pull"]);
    const response = await h.request("/v2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: jwt.slice(7),
        service: "pkg.test",
        scope: "repository:images/sibling:pull,push repository:images/app:pull,push",
      }).toString(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    expect(jwtClaims(body.token).access).toEqual([
      { type: "repository", name: "images/app", actions: ["pull"] },
    ]);
  });

  it("rejects a supplied invalid cookie rather than falling back to anonymous", async () => {
    const response = await h.request("/v2/", {
      headers: { cookie: "gm.session_token=forged.value" },
    });
    expect(response.status).toBe(401);
  });

  it("requires live development persona credentials and revokes their registry JWT", async () => {
    h.env.DEV_MODE = "true";
    const response = await h.request(
      "/v2/token?service=pkg.test&scope=repository:images/app:pull,push",
      {
        headers: { cookie: `gm_persona=${secret}` },
      },
    );
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect((await upload(`Bearer ${token}`)).status).toBe(202);
    h.gitmatrix.applySql(
      `DELETE FROM access_tokens WHERE token_hash = '${await hashSecret(secret)}'`,
    );
    expect((await upload(`Bearer ${token}`)).status).toBe(401);
    expect((await h.request("/v2/", { headers: { cookie: `gm_persona=${secret}` } })).status).toBe(
      401,
    );
    Reflect.deleteProperty(h.env, "DEV_MODE");
    expect(
      await authenticate(h.env, new Headers({ cookie: `gm_persona=${h.token("alice")}` })),
    ).toMatchObject({ kind: "anonymous" });
  });

  it("rechecks live CI jobs even for an exchanged registry JWT", async () => {
    const job = await h.jobToken();
    const jwt = await bearer(h, job.token, ["repository:images/app:pull,push"]);
    const actor = await authenticate(h.env, new Headers({ authorization: jwt }));
    expect(actor).toMatchObject({
      kind: "job",
      job: { jobId: job.jobId, spaceId: "acc_test", repoId: job.repoId },
    });
    expect(actor.personId).toBeTruthy();
    h.gitmatrix.applySql(`DELETE FROM ci_job_tokens WHERE job_id = '${job.jobId}'`);
    expect((await h.request("/v2/", { headers: { authorization: jwt } })).status).toBe(401);
    expect((await h.request("/v2/", { headers: { authorization: basic(job.token) } })).status).toBe(
      401,
    );
  });

  it("rechecks the CI initiating person's credential and independent package grant", async () => {
    const job = await h.jobToken();
    const jwt = await bearer(h, job.token, ["repository:images/app:pull,push"]);
    const actor = await authenticate(h.env, new Headers({ authorization: jwt }));
    h.gitmatrix.applySql(`DELETE FROM space_grants WHERE account_id = '${actor.personId}'`);
    expect((await upload(jwt)).status).toBe(401);
    h.gitmatrix.applySql(`DELETE FROM access_tokens WHERE user_id = '${actor.personId}'`);
    expect((await h.request("/v2/", { headers: { authorization: jwt } })).status).toBe(401);
    expect((await h.request("/v2/", { headers: { authorization: basic(job.token) } })).status).toBe(
      401,
    );
  });

  it("denies private package grants to a repository-only CI initiator", async () => {
    const job = await h.jobToken({ packageRole: "none" });
    const jwt = await bearer(h, job.token, ["repository:images/app:pull,push"]);
    expect(jwtClaims(jwt.slice(7)).access).toEqual([]);
    expect((await upload(basic(job.token))).status).toBe(403);
  });

  it("revokes CI credentials when the initiating repository collaborator is removed", async () => {
    const job = await h.jobToken();
    const jwt = await bearer(h, job.token, ["repository:images/app:pull,push"]);
    h.gitmatrix.applySql(`DELETE FROM repo_collaborators WHERE repo_id = '${job.repoId}'`);
    expect((await h.request("/v2/", { headers: { authorization: jwt } })).status).toBe(401);
    expect((await h.request("/v2/", { headers: { authorization: basic(job.token) } })).status).toBe(
      401,
    );
  });

  it("revokes a CI initiating agent for both job tokens and exchanged JWTs", async () => {
    const job = await h.jobToken();
    const person = await authenticate(h.env, new Headers({ authorization: basic(job.token) }));
    h.gitmatrix.applySql(`INSERT INTO agents (id, name, accountable_id)
      VALUES ('ci_agent', 'CI agent', '${person.personId}');
      UPDATE access_tokens SET agent_id = 'ci_agent' WHERE user_id = '${person.personId}';
      UPDATE ci_runs SET agent_id = 'ci_agent', authority = json_set(authority, '$.agentId', 'ci_agent')
      WHERE id = '${job.runId}'`);
    const jwt = await bearer(h, job.token, ["repository:images/app:pull,push"]);
    expect(await authenticate(h.env, new Headers({ authorization: jwt }))).toMatchObject({
      personId: person.personId,
      agentId: "ci_agent",
    });
    h.gitmatrix.applySql(
      "UPDATE agents SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE id = 'ci_agent'",
    );
    expect((await h.request("/v2/", { headers: { authorization: jwt } })).status).toBe(401);
    expect((await h.request("/v2/", { headers: { authorization: basic(job.token) } })).status).toBe(
      401,
    );
  });

  it("fences old job authority epochs using the native service-unavailable response", async () => {
    const job = await h.jobToken();
    const jwt = await bearer(h, job.token, ["repository:images/app:pull,push"]);
    h.gitmatrix.applySql(`UPDATE ci_runs
      SET authority = json_set(authority, '$.migrationEpoch', migration_epoch + 1),
        migration_epoch = migration_epoch + 1 WHERE id = '${job.runId}'`);
    expect((await h.request("/v2/", { headers: { authorization: jwt } })).status).toBe(503);
    expect((await h.request("/v2/", { headers: { authorization: basic(job.token) } })).status).toBe(
      503,
    );
  });
});
