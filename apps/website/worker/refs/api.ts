// POST /api/refs/resolve: refs found in text, resolved for the viewer in one
// batch (shared/refs.ts). GET /api/refs/go/<ref>: one ref, as a redirect to
// its target or, for a script, JSON. People open /-/go/<ref> instead, the
// app's page for the same answer, with a chooser when it's ambiguous.

import { Hono, type Context } from "hono";
import {
  goPath,
  REF_LIMITS,
  type RefContext,
  type RefResolution,
  type ResolveRefsRequest,
  type ResolveRefsResponse,
} from "../../shared/refs.ts";
import type { AppEnv } from "../auth.ts";
import { fail, readJson } from "../api/http.ts";
import { ownOrigins, resolveRefs, type ResolveScope } from "./resolve.ts";

const SLUG = /^[a-z0-9][a-z0-9-]{0,38}$/;
const REPO = /^(?!\.)[A-Za-z0-9._-]{1,100}$/;

/** A context's fields, each dropped unless it's well formed. */
function cleanContext(raw: unknown): RefContext {
  if (typeof raw !== "object" || raw === null) return {};
  const { owner, repo, tracker } = raw as Record<string, unknown>;
  const context: RefContext = {};
  if (typeof owner === "string" && SLUG.test(owner)) context.owner = owner;
  if (typeof repo === "string" && REPO.test(repo) && context.owner) context.repo = repo;
  if (typeof tracker === "string" && SLUG.test(tracker)) context.tracker = tracker;
  return context;
}

function scopeOf(c: Context<AppEnv>): ResolveScope {
  return {
    env: c.env,
    actor: c.get("actor") ?? null,
    request: c.req.raw,
    origins: ownOrigins(c.env, c.req.url),
    timing: c.get("timing"),
    waitUntil: (work) => {
      try {
        c.executionCtx.waitUntil(work);
      } catch {
        // No execution context (tests): let it run.
      }
    },
  };
}

export const refs = new Hono<AppEnv>();

refs.post("/resolve", async (c) => {
  const body = await readJson<ResolveRefsRequest>(c);
  const list = body.refs;
  if (
    !Array.isArray(list) ||
    list.length > REF_LIMITS.refs ||
    list.some((ref) => typeof ref !== "string" || !ref || ref.length > REF_LIMITS.length)
  )
    return fail(
      c,
      400,
      `refs is a list of 1 to ${REF_LIMITS.refs} non-empty strings of at most ${REF_LIMITS.length} characters.`,
    );
  const results = await resolveRefs(scopeOf(c), list, cleanContext(body.context));
  // Answers are the viewer's alone: never stored by a shared cache.
  c.header("cache-control", "private, no-store");
  return c.json<ResolveRefsResponse>({ results });
});

refs.get("/go/:ref{.+}", async (c) => {
  const ref = c.req.param("ref");
  if (ref.length > REF_LIMITS.length) return fail(c, 400, "That ref is too long.");
  const context = cleanContext({
    owner: c.req.query("owner"),
    repo: c.req.query("repo"),
    tracker: c.req.query("tracker"),
  });
  const [result] = (await resolveRefs(scopeOf(c), [ref], context)) as [RefResolution];
  c.header("cache-control", "private, no-store");
  const wantsJson =
    c.req.query("format") === "json" || /application\/json/.test(c.req.header("accept") ?? "");
  if (wantsJson) return c.json(result, result.status === "unresolved" ? 404 : 200);
  return c.redirect(result.status === "resolved" ? result.target.path : goPath(ref, context), 302);
});
