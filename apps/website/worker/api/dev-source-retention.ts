import type { Context } from "hono";
import type { AppEnv } from "../auth.ts";
import { findAccountBySlug, selectRepos } from "../db.ts";
import { db } from "../schema.ts";
import { isArtifactsError } from "../artifacts.ts";
import { trackerObject } from "../tracker/stub.ts";
import { canonicalSource, ensureWorkSource } from "../timelines/sources.ts";
import {
  expireArchivedSources,
  pinSourceRoot,
  releaseSourceRoots,
} from "../retention/work-sources.ts";
import { fail, readJson } from "./http.ts";

/** Fault-state fixture only; never available outside the disposable agent namespace. */
export async function sourceRetentionFixture(c: Context<AppEnv>) {
  const agentId = Reflect.get(c.env, "AGENT_ID");
  if (Reflect.get(c.env, "DEV_MODE") !== "true" || typeof agentId !== "string" || !agentId.trim())
    return fail(c, 404, "Not found.");
  const body = await readJson<{
    action: "inspect" | "reserve" | "initialize" | "pin" | "release" | "expire";
    repo: string;
    sourceId?: string;
    timeline?: string;
    commit?: string;
    consumerId?: string;
    observed?: { sourceId: string; artifactsName: string }[];
  }>(c);
  if (body.action === "inspect" && body.observed) {
    if (body.observed.length > 100) return fail(c, 400, "At most 100 owned source observations.");
    const sources = [];
    for (const item of body.observed) {
      if (!/^work_[a-f0-9-]+$/.test(item.sourceId) || !/^w-[a-f0-9]+$/.test(item.artifactsName))
        return fail(c, 400, "Invalid owned source observation.");
      let exists = true;
      try {
        using provider = await c.env.ARTIFACTS.get(item.artifactsName);
        await provider.info();
      } catch (error) {
        if (!isArtifactsError(error, "NOT_FOUND")) throw error;
        exists = false;
      }
      sources.push({ sourceId: item.sourceId, exists });
    }
    return c.json({ sources });
  }
  if (typeof body.repo !== "string")
    return fail(c, 400, "An owned fixture repository is required.");
  const [owner, name] = body.repo.split("/");
  const account = await findAccountBySlug(c.env.DB, owner ?? "");
  const providerId = /^provider-([a-f0-9]{10})$/.exec(name ?? "")?.[1];
  const scopedExpiry =
    body.action === "expire" &&
    ((owner === "orbit" &&
      ((/^queue-[a-f0-9]{8}$/.test(name ?? "") &&
        /^source-sync-[a-f0-9]{8}(?:-[a-z0-9-]+)?$/.test(body.timeline ?? "")) ||
        (providerId !== undefined && body.timeline === "copper-pages"))) ||
      (owner === "priya" &&
        providerId !== undefined &&
        body.timeline === `mirror-work-${providerId}`));
  if (!account || !name || (!name.startsWith("source-retention-") && !scopedExpiry))
    return fail(c, 400, "An owned source-retention fixture is required.");
  const repo = await selectRepos(c.env.DB, account.id)
    .where("r.owner_id", "=", account.id)
    .where("r.name", "=", name)
    .executeTakeFirst();
  if (!repo) return fail(c, 404, "No live fixture repository.");
  const store = db(c.env.DB);
  if (body.action === "expire") {
    if (!body.timeline) return fail(c, 400, "An exact ended fixture timeline is required.");
    const detail = await trackerObject(c.env, account.id).timeline(body.timeline, 0, 1);
    if (!detail.ok) return fail(c, detail.status, detail.error);
    const timeline = detail.value.timeline;
    const source = timeline.repos[0]?.source;
    if (
      !["landed", "abandoned"].includes(timeline.status) ||
      timeline.repos.length !== 1 ||
      timeline.repos[0]?.id !== repo.id ||
      source?.kind !== "timeline-work" ||
      (body.sourceId && source.sourceId !== body.sourceId)
    )
      return fail(c, 409, "Only this repository's ended owned fixture source may expire.");
    // Age only this ended fixture past both disposition-specific boundaries.
    // Keep the exact timeline fence: never expire unrelated owned resources.
    const cutoff = new Date(Date.now() + 86_400_000).toISOString();
    await expireArchivedSources(c.env, account.id, { landed: cutoff, abandoned: cutoff }, [
      timeline.id,
    ]);
    const current = await store
      .selectFrom("timeline_work_sources")
      .select(["source_id", "state"])
      .where("repo_id", "=", repo.id)
      .where("source_id", "=", source.sourceId)
      .executeTakeFirstOrThrow();
    return c.json({ sourceId: current.source_id, state: current.state, cutoff });
  }
  if (body.action === "reserve") {
    if (!body.commit) return fail(c, 400, "Pinned commit required.");
    using provider = await c.env.ARTIFACTS.get(repo.artifacts_name);
    const commit = await provider.readCommit(body.commit);
    if (!commit) return fail(c, 404, "Pinned commit missing.");
    const timelineId = `retention_${crypto.randomUUID()}`;
    const input = {
      timelineId,
      timelineSlug: timelineId,
      base: { ...canonicalSource(repo), commit: body.commit, tree: commit.treeHash },
    };
    const reserved = await trackerObject(c.env, account.id).reserveWorkSource(repo, input);
    if (!reserved.ok) return fail(c, reserved.status, reserved.error);
    await store.insertInto("timeline_work_sources").values(reserved.value).execute();
    // Deliberately stop after provider success. The authoritative reservation and
    // exact snapshot remain resumable by the normal initializer, not a fake row.
    await provider.fork(reserved.value.artifacts_name, { readOnly: false });
    return c.json({ sourceId: reserved.value.source_id, state: reserved.value.state });
  }
  if (body.action === "inspect") {
    const rows = await store
      .selectFrom("timeline_work_sources")
      .select(["source_id", "artifacts_name", "state", "archived_at"])
      .where("repo_id", "=", repo.id)
      .execute();
    const sources = [];
    for (const row of rows) {
      let exists = true;
      try {
        using provider = await c.env.ARTIFACTS.get(row.artifacts_name);
        await provider.info();
      } catch (error) {
        if (!isArtifactsError(error, "NOT_FOUND")) throw error;
        exists = false;
      }
      const [roots, operations] = await Promise.all([
        store
          .selectFrom("timeline_source_roots")
          .select([
            "consumer_kind as consumerKind",
            "consumer_id as consumerId",
            "commit_oid as commit",
          ])
          .where("repo_id", "=", repo.id)
          .where("source_id", "=", row.source_id)
          .execute(),
        store
          .selectFrom("source_operations")
          .select(["id", "kind", "state"])
          .where("repo_id", "=", repo.id)
          .where("source_id", "=", row.source_id)
          .where("state", "in", ["admitted", "ambiguous"])
          .execute(),
      ]);
      sources.push({
        sourceId: row.source_id,
        artifactsName: row.artifacts_name,
        state: row.state,
        archivedAt: row.archived_at,
        roots,
        operations,
        exists,
      });
    }
    return c.json({ sources });
  }
  const source = await store
    .selectFrom("timeline_work_sources")
    .selectAll()
    .where("repo_id", "=", repo.id)
    .where("source_id", "=", body.sourceId ?? "")
    .executeTakeFirst();
  if (!source) return fail(c, 404, "No owned fixture source.");
  if (body.action === "initialize") {
    const initialized = await ensureWorkSource(c.env, repo, {
      timelineId: source.timeline_id,
      timelineSlug: source.timeline_slug,
      base: { ...canonicalSource(repo), commit: source.fork_commit, tree: source.fork_tree },
    });
    return c.json({ sourceId: initialized.source.sourceId, state: "ready" });
  }
  if (!body.consumerId?.startsWith("source-retention-"))
    return fail(c, 400, "Fixture consumer ID required.");
  if (body.action === "pin") {
    await pinSourceRoot(c.env, {
      repoId: repo.id,
      sourceId: source.source_id,
      consumerKind: "retention-fixture",
      consumerId: body.consumerId,
      commit: source.initial_commit,
    });
    return c.json({ pinned: true });
  }
  if (body.action === "release") {
    await releaseSourceRoots(c.env, "retention-fixture", body.consumerId);
    return c.json({ released: true });
  }
  return fail(c, 400, "Unknown fixture action.");
}
