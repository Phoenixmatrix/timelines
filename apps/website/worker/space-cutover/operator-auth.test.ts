import { Hono } from "hono";
import { expect, onTestFinished, test } from "vite-plus/test";
import { spaceDigest } from "../../shared/space-cutover.ts";
import { sessionActor, type AppEnv } from "../auth.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import {
  createLegacyCutoverTestEnvironment,
  cutoverTestManifest,
  CUTOVER_TEST_CHECKPOINT,
} from "../testing/space-cutover.ts";
import { spaceCutoverApi } from "./api.ts";
import { cutoverHumanSession } from "./operator-auth.ts";

const origin = "https://fixture.invalid";

test("a human can reauthenticate without business writes, but recovery alone, replay and another origin cannot approve", async () => {
  const h = createLegacyCutoverTestEnvironment();
  onTestFinished(() => h.close());
  h.sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name,is_site_admin) VALUES('test-person','user','test-person','Operator',1)",
  );
  const email = "operator@example.test";
  await h.env.DB.prepare(
    "INSERT INTO auth_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES('test-person','Operator',?,1,?,?)",
  )
    .bind(email, new Date().toISOString(), new Date().toISOString())
    .run();
  Reflect.set(
    h.env,
    "BETTER_AUTH_SECRET",
    "isolated-operator-auth-secret-at-least-thirty-two-bytes",
  );
  const sent: Array<{ to: string; text: string }> = [];
  Reflect.set(h.env, "EMAIL", {
    send: async (message: { to: string; text: string }) => {
      sent.push(message);
    },
  });
  const control = cutoverControl(h.env);
  const recovery = "isolated-recovery-capability";
  const run = await control.prepare(
    cutoverTestManifest(),
    CUTOVER_TEST_CHECKPOINT,
    "test-person",
    await spaceDigest(recovery),
  );
  await control.approve(run.runId, run.manifestDigest, run.checkpoint, "test-person");
  await control.fence(run.runId);
  await control.fenceDatabases(run.runId);
  const headers = {
    origin,
    "content-type": "application/json",
    "x-space-cutover-recovery": recovery,
  };
  const call = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    spaceCutoverApi.request(
      `${origin}/${path}`,
      { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) },
      h.env,
    );
  expect(
    (await call("operator-auth/start", {}, { "x-space-cutover-recovery": "wrong" })).status,
  ).toBe(403);
  expect((await call("operator-auth/start", {}, { origin: "https://other.invalid" })).status).toBe(
    403,
  );
  expect(sent).toEqual([]);
  const started = await call("operator-auth/start", {});
  expect(started.status).toBe(200);
  const challenge = (await started.json()) as { challengeId: string };
  expect(sent.map((message) => message.to)).toEqual([email]);
  const code = sent[0]!.text.match(/\b\d{8}\b/)![0];
  const verified = await call("operator-auth/verify", { challengeId: challenge.challengeId, code });
  expect(verified.status).toBe(200);
  const setCookie = verified.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("Path=/api/admin/space-cutover");
  const cookie = setCookie.split(";")[0]!;
  const probe = new Hono<AppEnv>().get("/", async (c) =>
    c.json({
      operator: (await cutoverHumanSession(c))?.id ?? null,
      ordinary: (await sessionActor(c))?.id ?? null,
    }),
  );
  expect(await (await probe.request(`${origin}/`, { headers: { cookie } }, h.env)).json()).toEqual({
    operator: "test-person",
    ordinary: null,
  });
  expect(
    await (await probe.request("https://other.invalid/", { headers: { cookie } }, h.env)).json(),
  ).toEqual({ operator: null, ordinary: null });
  expect(
    (await call("operator-auth/verify", { challengeId: challenge.challengeId, code })).status,
  ).toBe(403);
  const decision = {
    runId: run.runId,
    manifestDigest: run.manifestDigest,
    checkpoint: run.checkpoint,
    versionId: run.preparationVersionId,
    mode: "legacy",
  };
  expect((await call("approve-release", decision)).status).toBe(403);
  // Authentication is now valid, but an unrecovered fenced run still cannot be released.
  expect((await call("approve-release", decision, { cookie })).status).toBe(409);
  expect(await h.env.DB.prepare("SELECT count(*) AS count FROM auth_sessions").first()).toEqual({
    count: 0,
  });
  expect((await control.admission(3)).allowed).toBe(false);
  await expect(
    h.env.DB.prepare(
      "UPDATE accounts SET display_name='unauthorized' WHERE id='test-person'",
    ).run(),
  ).rejects.toThrow("space_cutover_fenced");
});
