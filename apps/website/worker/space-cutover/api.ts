import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import { spaceDigest, type SpaceManifest } from "../../shared/space-cutover.ts";
import { applicationInventory, validateApplicationMapping } from "./application.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import type { Actor } from "../db.ts";
import { inspectCutoverDrain } from "../durable/cutover-drain.ts";
import { advanceRefReconciliation, replayRefDivergence } from "./ref-barrier.ts";
import { cutoverHumanSession, operatorAuthApi } from "./operator-auth.ts";

export const spaceCutoverApi = new Hono<AppEnv>();
spaceCutoverApi.use(async (c, next) => {
  c.header("cache-control", "no-store");
  if (c.req.method !== "GET" && c.req.header("origin") !== new URL(c.req.url).origin)
    return c.json({ error: "Same-origin operator request required" }, 403);
  const control = cutoverControl(c.env);
  const run = await control.status();
  const recovery = c.req.header("x-space-cutover-recovery");
  // After Space admission opened, a journaled replay the operator cannot run
  // (no write grant in its Space) is re-triggered by a person who can, with
  // their own session: the replay itself checks that grant.
  const replay =
    c.req.method === "POST" && c.req.path.endsWith("/replay-refs") && run?.phase === "active";
  if (replay && !recovery) {
    const actor = await cutoverHumanSession(c);
    if (!actor?.credential || actor.agent)
      return c.json({ error: "A current human session is required" }, 403);
    c.set("actor", actor);
  } else if (recovery && (await control.authorizeRecovery(recovery))) {
    // The run-scoped credential was enrolled by a human operator. It survives
    // restoration but cannot replace the fresh-session original mapping approval.
    if (
      run!.phase === "prepared" &&
      !(await c.env.DB.prepare(
        "SELECT 1 FROM accounts WHERE id=? AND kind='user' AND is_site_admin=1",
      )
        .bind(run!.operatorId)
        .first())
    )
      return c.json({ error: "Enrolled operator was revoked before fencing" }, 403);
    c.set("actor", { id: run!.operatorId, slug: "", displayName: "", isSiteAdmin: true });
  } else {
    if (run && !["prepared", "legacy-active"].includes(run.phase))
      return c.json(
        { error: "Use the independently enrolled recovery capability while fenced" },
        403,
      );
    const actor = await cutoverHumanSession(c);
    if (!actor?.isSiteAdmin || actor.agent)
      return c.json({ error: "A current human Instance operator session is required" }, 403);
    c.set("actor", actor);
  }
  await next();
});
spaceCutoverApi.route("/operator-auth", operatorAuthApi);
spaceCutoverApi.get("/inventory", async (c) => {
  const state = await cutoverControl(c.env).status();
  if (state && !["prepared", "legacy-active"].includes(state.phase))
    return c.json({ error: "Inventory is already frozen" }, 409);
  return c.json(await applicationInventory(c.env.DB, c.env.REGISTRY_DB));
});
spaceCutoverApi.get("/", async (c) => {
  const control = cutoverControl(c.env);
  const run = await control.status();
  if (!run) return c.json({ run: null, tickets: await control.activeTickets() });
  const { recoveryDigest: _secretDigest, ...safe } = run;
  return c.json({ run: safe, tickets: await control.activeTickets() });
});
spaceCutoverApi.post("/:action", async (c) => {
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: "JSON body required" }, 400);
  // A census lists every instance of each Workflow, of every status.
  const limit = c.req.param("action") === "workflow-census" ? 16 * 1024 * 1024 : 1024 * 1024;
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return c.json({ error: "Operator request is too large" }, 413);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const body = JSON.parse(new TextDecoder().decode(bytes)) as {
    runId: string;
    manifestDigest: string;
    checkpoint: string;
    manifest: SpaceManifest;
    versionId: string;
    mode: "space" | "legacy";
    recoveryToken: string;
    fresh?: boolean;
    census?: unknown;
    replay?: { pass: number; repoId: string; sourceId: string };
  };
  const control = cutoverControl(c.env);
  const action = c.req.param("action");
  const actor = c.get("actor") as Actor;
  if (action === "prepare" || action === "approve") {
    // Recovery capabilities cannot stand in for a fresh human decision.
    const human = await cutoverHumanSession(c);
    if (!human?.isSiteAdmin || human.agent || human.id !== actor.id)
      return c.json({ error: "Human approval session required" }, 403);
    if (action === "prepare") {
      if (body.manifest.source !== new URL(c.req.url).origin)
        return c.json({ error: "Manifest names another installation" }, 400);
      await validateApplicationMapping(c.env.DB, c.env.REGISTRY_DB, body.manifest);
      if (!/^[0-9a-f]{64}$/.test(body.recoveryToken))
        return c.json(
          { error: "Persist a 256-bit recovery capability locally before enrollment" },
          400,
        );
      const run = await control.prepare(
        body.manifest,
        body.checkpoint,
        human.id,
        await spaceDigest(body.recoveryToken),
      );
      return c.json(
        { runId: run.runId, manifestDigest: run.manifestDigest, checkpoint: run.checkpoint },
        201,
      );
    }
    await control.approve(body.runId, body.manifestDigest, body.checkpoint, human.id);
  } else if (action === "fence") {
    await control.fence(body.runId);
    await control.fenceDatabases(body.runId);
  } else if (action === "begin") await control.beginMigration(body.runId);
  else if (action === "advance") await control.advance(body.runId, actor);
  else if (action === "drain") return c.json(await inspectCutoverDrain(c.env, body.runId));
  else if (action === "workflow-census")
    // The provider's own instance lists and deployment history, exported by the
    // enrolled operator; termination of what remains happens in the drain inspection.
    await control.recordWorkflowCensus(body.runId, body.census, actor.id);
  else if (action === "reconcile-refs") {
    // Replayed push effects are new work: their authority is a current human
    // session's own credential, never the recovery capability.
    const human = await cutoverHumanSession(c);
    return c.json(
      await advanceRefReconciliation(c.env, body.runId, {
        actor: human?.isSiteAdmin && !human.agent && human.id === actor.id ? human : null,
        fresh: body.fresh === true,
      }),
    );
  } else if (action === "replay-refs") {
    const human = await cutoverHumanSession(c);
    const key = body.replay;
    if (
      !key ||
      !Number.isInteger(key.pass) ||
      typeof key.repoId !== "string" ||
      typeof key.sourceId !== "string"
    )
      return c.json({ error: "Name the replay: pass, repoId and sourceId" }, 400);
    return c.json(await replayRefDivergence(c.env, body.runId, key, human));
  } else if (action === "recover") await control.recover(body.runId);
  else if (action === "approve-release") {
    const human = await cutoverHumanSession(c);
    if (!human?.isSiteAdmin || human.agent || human.id !== actor.id)
      return c.json({ error: "Fresh human release approval session required" }, 403);
    const run = await control.status();
    if (run?.manifestDigest !== body.manifestDigest || !["space", "legacy"].includes(body.mode))
      return c.json({ error: "Release decision does not match the enrolled manifest" }, 409);
    await control.approveRelease(body.runId, body.checkpoint, body.versionId, body.mode, human.id);
  } else if (action === "open-admission") await control.openWriteAdmission(body.runId);
  else
    return c.json(
      {
        error:
          "Unknown operator action; activation is unavailable until compatible consumers are released",
      },
      400,
    );
  return c.json({ ok: true });
});
spaceCutoverApi.onError((_error, c) =>
  c.json(
    {
      error:
        "Cutover operation rejected; inspect the independent journal status. Checkpoint bytes and credentials are never returned in errors.",
    },
    409,
  ),
);
