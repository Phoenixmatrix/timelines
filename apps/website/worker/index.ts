import { Hono } from "hono";
import { accounts } from "./api/accounts.ts";
import { dev } from "./api/dev.ts";
import { repos } from "./api/repos.ts";
import { tokens } from "./api/tokens.ts";
import { sessionActor, tokenCredential, type AppEnv } from "./auth.ts";
import { isArtifactsError } from "./artifacts.ts";
import { ci, runner } from "./ci/api.ts";
import { gitHttp } from "./git/http.ts";
import { knowledge } from "./knowledge/api.ts";
import { Timing } from "./timing.ts";

const api = new Hono<AppEnv>();

api.use(async (c, next) => {
  const timing = new Timing();
  c.set("timing", timing);
  await next();
  c.res.headers.set("server-timing", timing.header());
});

// Browsers authenticate with the persona cookie; scripts and CLIs send a
// personal access token (`Authorization: Bearer gmx_…`). Read-scoped tokens
// may only read.
api.use(async (c, next) => {
  if (!c.req.header("authorization")) {
    c.set("actor", await sessionActor(c));
    return next();
  }
  const credential = await tokenCredential(c);
  if (credential.kind !== "token") return c.json({ error: "Invalid access token." }, 401);
  if (credential.scope === "read" && c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.json({ error: "This token is read-only." }, 403);
  }
  c.set("actor", credential.actor);
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      "UPDATE access_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
      .bind(credential.tokenId)
      .run(),
  );
  return next();
});
api.route("/", accounts);
api.route("/repos/:owner/:name/knowledge", knowledge);
api.route("/repos/:owner/:name/ci", ci);
api.route("/ci/runner", runner);
api.route("/repos", repos);
api.route("/tokens", tokens);
api.route("/dev", dev);
api.notFound((c) => c.json({ error: "Not found." }, 404));
api.onError((error, c) => {
  if (
    isArtifactsError(error, "IMPORT_IN_PROGRESS") ||
    isArtifactsError(error, "CREATE_IN_PROGRESS") ||
    isArtifactsError(error, "FORK_IN_PROGRESS")
  ) {
    return c.json({ error: "This repository is still being set up. Try again in a moment." }, 409);
  }
  if (isArtifactsError(error, "MEMORY_LIMIT")) {
    return c.json({ error: "That object is too large to show here." }, 413);
  }
  console.error(error);
  return c.json({ error: "Something went wrong on our side." }, 500);
});

const app = new Hono<AppEnv>();
app.route("/api", api);
app.route("/", gitHttp);

export default app;
export { KnowledgeBuild } from "./knowledge/build.ts";
export { KnowledgeCoordinator } from "./knowledge/coordinator.ts";
export { CiRun } from "./ci/workflow.ts";
export { CiSandbox } from "./ci/sandbox.ts";
