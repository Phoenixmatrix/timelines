import { Hono } from "hono";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import { startPersonaSession, type AppEnv } from "../auth.ts";
import { issueToken } from "../api/tokens.ts";
import { spaceCutoverApi } from "./api.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import {
  createLegacyCutoverTestEnvironment,
  cutoverTestManifest,
  CUTOVER_TEST_CHECKPOINT,
} from "../testing/space-cutover.ts";
import { spaceDigest } from "../../shared/space-cutover.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));
const origin = "https://fixture.invalid";

async function fixture() {
  const h = createLegacyCutoverTestEnvironment();
  onTestFinished(() => h.close());
  Reflect.set(h.env, "DEV_MODE", "true");
  h.sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name,is_site_admin) VALUES('test-person','user','test-person','Operator',1)",
  );
  const token = await issueToken(h.env.DB, "test-person", "Operator API token", "write");
  const login = new Hono<AppEnv>().post("/", async (c) => {
    await startPersonaSession(c, "test-person");
    return c.body(null, 204);
  });
  const response = await login.request(`${origin}/`, { method: "POST" }, h.env);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("gm_persona=gmx_"))!
    .split(";")[0]!;
  return { ...h, token: token.secret, cookie };
}

describe("human operator cutover protocol", () => {
  test("does not accept anonymous requests or a general API token as human mapping approval", async () => {
    const h = await fixture();
    const anonymous = await spaceCutoverApi.request(`${origin}/inventory`, {}, h.env);
    expect(anonymous.status).toBe(403);
    const tokenOnly = await spaceCutoverApi.request(
      `${origin}/inventory`,
      { headers: { authorization: `Bearer ${h.token}` } },
      h.env,
    );
    expect(tokenOnly.status).toBe(403);
    const human = await spaceCutoverApi.request(
      `${origin}/inventory`,
      { headers: { cookie: h.cookie } },
      h.env,
    );
    expect(human.status).toBe(200);
    expect(
      (
        await spaceCutoverApi.request(
          `${origin}/inventory`,
          { headers: { cookie: "gm_persona=test-person" } },
          h.env,
        )
      ).status,
    ).toBe(403);
    Reflect.deleteProperty(h.env, "DEV_MODE");
    const forgedProductionPersona = await spaceCutoverApi.request(
      `${origin}/inventory`,
      { headers: { cookie: h.cookie } },
      h.env,
    );
    expect(forgedProductionPersona.status).toBe(403);
  });
  test("requires a same-origin fresh human mapping decision and rechecks pre-fence operator revocation", async () => {
    const h = await fixture();
    const control = cutoverControl(h.env);
    const recovery = "private-run-recovery";
    const run = await control.prepare(
      cutoverTestManifest(),
      CUTOVER_TEST_CHECKPOINT,
      "test-person",
      await spaceDigest(recovery),
    );
    const decision = {
      runId: run.runId,
      manifestDigest: run.manifestDigest,
      checkpoint: run.checkpoint,
    };
    const call = (path: string, headers: Record<string, string>) =>
      spaceCutoverApi.request(
        `${origin}/${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(decision),
        },
        h.env,
      );
    expect((await call("approve", { origin, "x-space-cutover-recovery": recovery })).status).toBe(
      403,
    );
    expect(
      (await call("approve-release", { origin, "x-space-cutover-recovery": recovery })).status,
    ).toBe(403);
    expect((await call("approve", { cookie: h.cookie })).status).toBe(403);
    expect((await call("approve", { origin, cookie: h.cookie })).status).toBe(200);
    await h.env.DB.prepare("UPDATE accounts SET is_site_admin=0 WHERE id='test-person'").run();
    expect((await call("fence", { origin, "x-space-cutover-recovery": recovery })).status).toBe(
      403,
    );
    expect((await control.admission(3)).allowed).toBe(true);
  });
});
