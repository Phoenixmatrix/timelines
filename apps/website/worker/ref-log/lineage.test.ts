import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { RepoRow } from "../db.ts";
import { findRepo } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeHistory } from "../testing/history.ts";
import { ancestorSet, sourceLineage } from "./lineage.ts";

const graph = vi.hoisted(() => ({ head: "", commits: new Map<string, ArtifactsCommitMetadata>() }));
vi.mock("../artifacts.ts", () => ({
  lsRefs: async () => [{ name: "refs/heads/main", oid: graph.head }],
}));
vi.mock("../objects.ts", () => ({
  RepoReader: class {
    async commit(oid: string) {
      return graph.commits.get(oid) ?? null;
    }
    async close() {}
  },
}));
const closers: { close(): void }[] = [];
afterEach(() => {
  for (const closer of closers.splice(0)) closer.close();
  graph.commits.clear();
});

async function setup() {
  const sqlite = migratedDatabase();
  closers.push(sqlite);
  sqlite.exec(`
    INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote) VALUES('repo','owner','app','public','canonical-physical','https://canonical');
    INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,initial_token_revoked,created_at,updated_at)
    VALUES('work_a','repo','timeline','topic','owner','work-physical','https://work','ready','allocate','canonical','base','tree','refs/heads/main','canonical','base','tree','refs/heads/main',1,'now','now');
    INSERT INTO source_progress_members(repo_id,source_id,commit_oid,operation_id,created_at) VALUES('repo','work_a','wip','push','now');
  `);
  const env = { DB: d1(sqlite) } as Env;
  const repo = (await findRepo(env.DB, null, "owner", "app")) as RepoRow;
  const history = fakeHistory();
  const base = history.commit({ files: { file: "base" } });
  const landed = history.commit({ parents: [base], files: { file: "landed" } });
  const main = history.commit({ parents: [landed], files: { file: "later" } });
  graph.head = main;
  for (const [oid, commit] of history.commits) graph.commits.set(oid, commit);
  const receipt = (id: string, canonical = landed) => {
    sqlite
      .prepare(`INSERT INTO source_integration_receipts(id,landing_id,checkpoint_id,repo_id,source_id,source_commit,source_tree,logical_base_json,dependencies_json,canonical_base,canonical_commit,canonical_tree,noop,status,created_at,completed_at)
      VALUES(?,?,?,'repo','work_a','approved','work-tree',?,'[]',?,?,?,0,'complete','now','now')`)
      .run(
        id,
        id,
        `checkpoint-${id}`,
        JSON.stringify({
          sourceId: "canonical",
          repoId: "repo",
          kind: "canonical",
          timelineId: null,
          ref: "refs/heads/main",
          commit: base,
          tree: "base-tree",
        }),
        base,
        canonical,
        history.commits.get(canonical)!.treeHash,
      );
    sqlite
      .prepare(
        "INSERT INTO source_integration_members(receipt_id,repo_id,source_id,commit_oid) VALUES(?,'repo','work_a','wip')",
      )
      .run(id);
  };
  return { sqlite, env, repo, history, base, landed, main, receipt };
}

describe("exact source lineage", () => {
  test("pending and unrelated OIDs never borrow another source or change-id's admission", async () => {
    const t = await setup();
    expect((await sourceLineage(t.env, t.repo, "work_a", "wip"))?.status).toBe("pending");
    t.receipt("landing");
    const integrated = await sourceLineage(t.env, t.repo, "work_a", "wip");
    expect(integrated).toMatchObject({
      status: "integrated",
      members: ["wip"],
      integration: { source: { commit: "approved" }, canonical: { commit: t.landed } },
      canonical: { commit: t.main },
    });
    expect((await sourceLineage(t.env, t.repo, "work_a", "rewritten-same-change"))?.status).toBe(
      "unknown",
    );
    expect(await sourceLineage(t.env, t.repo, "foreign-source", "wip")).toBeNull();
  });

  test("rewritten canonical history and competing anchors block instead of selecting latest", async () => {
    const t = await setup();
    t.receipt("first");
    t.receipt("second", t.main);
    expect((await sourceLineage(t.env, t.repo, "work_a", "wip"))?.status).toBe("ambiguous");
    t.sqlite.exec("DELETE FROM source_integration_receipts WHERE id='second'");
    graph.head = t.base;
    const rewritten = await sourceLineage(t.env, t.repo, "work_a", "wip");
    expect(rewritten).toMatchObject({ status: "ambiguous", integration: null, members: [] });
  });

  test("expired work reports expiry but keeps truthful durable receipt metadata", async () => {
    const t = await setup();
    t.receipt("landing");
    t.sqlite.exec(
      "UPDATE timeline_work_sources SET state='purged', artifacts_remote=NULL WHERE source_id='work_a'",
    );
    expect(await sourceLineage(t.env, t.repo, "work_a", "wip")).toMatchObject({
      status: "expired",
      integration: { canonical: { commit: t.landed } },
      source: { sourceId: "work_a" },
    });
  });

  test("ancestry proof does not stop at the bounded push-log depth and missing history remains unknown", async () => {
    const history = fakeHistory();
    let head = history.commit({ files: { file: "root" } });
    const root = head;
    for (let n = 0; n < 600; n++)
      head = history.commit({ parents: [head], files: { file: String(n) } });
    expect((await ancestorSet(history.reader, head))?.has(root)).toBe(true);
    history.commits.delete(root);
    expect(await ancestorSet(history.reader, head)).toBeNull();
  });
});
