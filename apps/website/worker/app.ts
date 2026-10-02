// The HTTP application: the JSON API under /api, sign-in, package protocols and
// git smart HTTP. Its own module so the assistant can call the API in-process
// (worker/assistant/internal.ts) with every permission check in place.

import { Hono } from "hono";
import { accounts } from "./api/accounts.ts";
import { dev } from "./api/dev.ts";
import { repos } from "./api/repos.ts";
import { sshAuth, sshKeys } from "./api/ssh.ts";
import { invites } from "./api/invites.ts";
import { agents } from "./api/agents.ts";
import { tokens } from "./api/tokens.ts";
import { sessionActor, tokenCredential, type AppEnv } from "./auth.ts";
import { createAuth } from "./better-auth.ts";
import { isArtifactsError } from "./artifacts.ts";
import { sqlNow } from "./db.ts";
import { ci, runner } from "./ci/api.ts";
import { mirrors } from "./mirror/api.ts";
import { gitHttp } from "./git/http.ts";
import { knowledge } from "./knowledge/api.ts";
import { releaseNotes, trackerReleaseNotes } from "./release-notes/api.ts";
import { db } from "./schema.ts";
import { Timing } from "./timing.ts";
import { buildRegistry } from "../registry/app.ts";
import { tracker } from "./tracker/api.ts";
import { assistant } from "./api/assistant.ts";

const api = new Hono<AppEnv>();

api.use(async (c, next) => {
  const timing = new Timing();
  c.set("timing", timing);
  await next();
  // A WebSocket upgrade (the assistant's live chat) can't take headers.
  if (c.res.status !== 101) {
    try {
      c.res.headers.set("server-timing", timing.header());
    } catch {
      // A proxied response with immutable headers goes out without timings.
    }
  }
});

// Browsers authenticate with a Better Auth session cookie (or, in development,
// the persona cookie); scripts and CLIs send a personal access token
// (`Authorization: Bearer gmx_…`). Read-scoped tokens may only read.
api.use(async (c, next) => {
  // Dev endpoints authenticate their own environment secret, and the device
  // exchange a Better Auth session token, not a user PAT.
  if (
    c.req.path === "/api/dev" ||
    c.req.path.startsWith("/api/dev/") ||
    c.req.path === "/api/tokens/device"
  ) {
    c.set("actor", null);
    return next();
  }
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
    db(c.env.DB)
      .updateTable("access_tokens")
      .set({ last_used_at: sqlNow })
      .where("id", "=", credential.tokenId)
      .execute(),
  );
  return next();
});
api.route("/", accounts);
api.route("/tracker/:owner/release-notes", trackerReleaseNotes);
api.route("/", tracker);
api.route("/repos/:owner/:name/knowledge", knowledge);
api.route("/repos/:owner/:name/release-notes", releaseNotes);
api.route("/repos/:owner/:name/ci", ci);
api.route("/ci/runner", runner);
api.route("/repos", repos);
api.route("/repos", mirrors);
api.route("/tokens", tokens);
api.route("/agents", agents);
api.route("/invites", invites);
api.route("/ssh-keys", sshKeys);
api.route("/auth/ssh", sshAuth);
api.route("/dev", dev);
api.route("/assistant", assistant);
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

export const app = new Hono<AppEnv>();
// Sign-in: emailed codes and device login (worker/better-auth.ts).
app.on(["GET", "POST"], "/api/identity/*", async (c) =>
  (await createAuth(c.env, new URL(c.req.url).origin)).handler(c.req.raw),
);
// Package protocols (/v2, /npm/…, /pypi/…) and their REST extras
// (/api/registry/…) come first; their middleware is scoped to those paths.
app.route("/", buildRegistry() as unknown as Hono<AppEnv>);
app.route("/api", api);
app.route("/", gitHttp);
