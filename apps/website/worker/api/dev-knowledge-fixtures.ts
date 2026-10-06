import type { Context } from "hono";
import type { AppEnv } from "../auth.ts";
import { fail, readJson } from "./http.ts";
import { db } from "../schema.ts";
import { knowledgeFixtureEnabled } from "../knowledge/fixture-barrier.ts";
import { vectorId } from "../knowledge/indexes.ts";
import { notifyReleaseNotes } from "../release-notes/queue.ts";

/** Requires the /api/dev named-agent secret middleware as well as this fixture scope. */
export async function knowledgeFixtures(c: Context<AppEnv>) {
  if (!knowledgeFixtureEnabled(c.env)) return fail(c, 404, "Not found.");
  const input = await readJson<{
    repo: string;
    sourceId: string;
    action: "arm" | "inspect" | "release" | "delete" | "regenerate";
    landing?: string;
  }>(c);
  if (
    typeof input.repo !== "string" ||
    typeof input.sourceId !== "string" ||
    typeof input.action !== "string" ||
    !/^orbit\/provider-[a-f0-9]{10}$/.test(input.repo ?? "") ||
    !/^work_[a-f0-9-]+$/.test(input.sourceId ?? "") ||
    !["arm", "inspect", "release", "delete", "regenerate"].includes(input.action)
  )
    return fail(c, 400, "An owned AI acceptance fixture is required.");
  const store = db(c.env.DB);
  const repo = await store
    .selectFrom("repos as r")
    .innerJoin("accounts as a", "a.id", "r.owner_id")
    .select("r.id")
    .where("a.slug", "=", "orbit")
    .where("r.name", "=", input.repo.split("/")[1]!)
    .where("r.deleted_at", "is", null)
    .executeTakeFirst();
  if (!repo) return fail(c, 404, "Fixture repository missing.");
  const source = await store
    .selectFrom("timeline_work_sources")
    .selectAll()
    .where("repo_id", "=", repo.id)
    .where("source_id", "=", input.sourceId)
    .executeTakeFirst();
  if (!source || !["copper-pages", "copper-limits"].includes(source.timeline_slug))
    return fail(c, 400, "Fixture source missing.");
  await c.env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS dev_knowledge_barriers(source_id TEXT PRIMARY KEY,build_id TEXT,released INTEGER NOT NULL DEFAULT 0)",
  ).run();
  if (input.action === "arm") {
    if (source.state !== "ready") return fail(c, 409, "Source is not active.");
    await c.env.DB.prepare(
      "INSERT INTO dev_knowledge_barriers(source_id) VALUES(?) ON CONFLICT(source_id) DO UPDATE SET build_id=NULL,released=0",
    )
      .bind(source.source_id)
      .run();
  } else if (input.action === "release") {
    await c.env.DB.prepare("UPDATE dev_knowledge_barriers SET released=1 WHERE source_id=?")
      .bind(source.source_id)
      .run();
  } else if (input.action === "delete") {
    await c.env.DB.prepare("DELETE FROM dev_knowledge_barriers WHERE source_id=?")
      .bind(source.source_id)
      .run();
  } else if (input.action === "regenerate") {
    const receipt = await store
      .selectFrom("source_integration_receipts")
      .select("id")
      .where("repo_id", "=", repo.id)
      .where("source_id", "=", source.source_id)
      .where("canonical_commit", "=", input.landing ?? "")
      .where("status", "=", "complete")
      .executeTakeFirst();
    if (!receipt || source.state !== "purged")
      return fail(c, 409, "Purge and canonical receipt required.");
    // Remove only generated outputs, not the authoritative receipt/regeneration metadata.
    const removed = await store
      .deleteFrom("release_note_entries")
      .where("repo_id", "=", repo.id)
      .where("landing_oid", "=", input.landing!)
      .returning("id")
      .execute();
    if (!removed.length) return fail(c, 409, "Generated landing notes required.");
    await notifyReleaseNotes(c.env, repo.id);
    return c.json({ removed: removed.length, receiptId: receipt.id });
  }
  const barrier = await c.env.DB.prepare(
    "SELECT build_id,released FROM dev_knowledge_barriers WHERE source_id=?",
  )
    .bind(source.source_id)
    .first<{ build_id: string | null; released: number }>();
  const workflow = barrier?.build_id
    ? await (await c.env.KNOWLEDGE_BUILD.get(barrier.build_id)).status()
    : null;
  const output = workflow?.output;
  const outcome = output && typeof output === "object" ? Reflect.get(output, "status") : null;
  const commit = output && typeof output === "object" ? Reflect.get(output, "commit") : null;
  const vectorIds = await Promise.all(
    ["sym:checksum.ts#copperFinchChecksum", "sym:limits.ts#copperFinchBatchLimit"].map((id) =>
      vectorId(repo.id, id),
    ),
  );
  const vectors = c.env.VECTORS ? await c.env.VECTORS.getByIds(vectorIds) : [];
  const roots = barrier?.build_id
    ? await store
        .selectFrom("timeline_source_roots")
        .select("commit_oid")
        .where("repo_id", "=", repo.id)
        .where("source_id", "=", source.source_id)
        .where("consumer_kind", "=", "knowledge-overlay")
        .where("consumer_id", "=", `${repo.id}:${source.source_id}:${barrier.build_id}`)
        .execute()
    : [];
  return c.json({
    barrier,
    workflow: workflow?.status ?? null,
    outcome: typeof outcome === "string" ? outcome : null,
    commit: typeof commit === "string" ? commit : null,
    roots: roots.map((root) => root.commit_oid),
    vectors: vectors.map(({ id, metadata }) => ({ id, metadata })),
  });
}
