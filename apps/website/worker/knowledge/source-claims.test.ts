import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { issueToken } from "../api/tokens.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import { KnowledgeCoordinator } from "./coordinator.ts";
import { claimSet, closeSet, queueSet } from "./pages.ts";
import { LEGACY_KNOWLEDGE_POLICY } from "./policy.ts";
import { reconcileExpiredKnowledge } from "./source-claims.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));

const oid = "a".repeat(40);
const ref = "refs/heads/timeline/work";

async function fixture() {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite, env } = fresh;
  onTestFinished(fresh.close);
  sqlite.exec(`
    INSERT INTO accounts (id,kind,slug,display_name) VALUES ('ann','user','ann','Ann');
  `);
  await seedSpaceFixture(d1(sqlite), {
    organization: { id: "org", slug: "org", displayName: "Organization", kind: "company" },
    space: { id: "owner", slug: "orbit", displayName: "Orbit" },
    actorId: "ann",
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  sqlite.exec(`
    INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('repo','owner','app','private','app','https://app');
    INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,space_id,
      artifacts_name,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
      initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
      VALUES('work','repo','timeline','work','owner','work','ready','allocation','canonical',
        '${oid}','${oid}','refs/heads/main','canonical','${oid}','${oid}','refs/heads/main','2025-01-01','2025-01-01');
  `);
  const token = await issueToken(env.DB, "ann", "Knowledge test", "write");
  const authorization = await captureWorkAuthority(env, "repo", {
    id: "ann",
    credential: { kind: "token", id: token.id },
  });
  return { sqlite, env, authorization };
}

describe("knowledge consumer completion", () => {
  test("page attempts retain distinct claims while published output survives source expiry", async () => {
    const { sqlite, env, authorization } = await fixture();
    const database = d1(sqlite);
    const set = { repoId: "repo", sourceId: "work", ref, key: "checkpoint" };
    const states = new Map([
      ["old-build", "running"],
      ["new-build", "running"],
    ]);
    Object.assign(env, {
      DB: database,
      KNOWLEDGE_BUILD: {
        get: async (id: string) => ({ status: async () => ({ status: states.get(id) }) }),
      },
    } as unknown as Env);
    const request = { ...set, commit: oid, checkpoint: null, requestedBy: "ann", authorization };
    const roots = () =>
      sqlite
        .prepare("SELECT consumer_kind,consumer_id FROM timeline_source_roots ORDER BY consumer_id")
        .all();
    try {
      await queueSet(database, request);
      await claimSet(database, set, "old-build", LEGACY_KNOWLEDGE_POLICY);
      await closeSet(database, set, "old-build", "failed");
      await queueSet(database, request);
      await claimSet(database, set, "new-build", LEGACY_KNOWLEDGE_POLICY);
      await closeSet(database, set, "new-build", "succeeded");
      expect(roots()).toEqual([
        { consumer_kind: "knowledge-pages-build", consumer_id: "new-build" },
        { consumer_kind: "knowledge-pages-build", consumer_id: "old-build" },
      ]);
      // Metadata completion does not acknowledge either actual workflow.
      await queueSet(database, { ...request, key: "unstarted" });
      sqlite.exec(`UPDATE timeline_work_sources SET state='archived',
        archive_disposition='landed',archived_at='2025-01-01',expiry_requested_at='2026-10-04'`);
      states.set("old-build", "complete");
      await reconcileExpiredKnowledge(env, "owner", ["timeline"]);
      expect(roots()).toEqual([
        { consumer_kind: "knowledge-pages-build", consumer_id: "new-build" },
      ]);
      await queueSet(database, { ...request, key: "too-late" });
      states.set("new-build", "complete");
      await reconcileExpiredKnowledge(env, "owner", ["timeline"]);
      expect(roots()).toEqual([]);
      expect(
        sqlite.prepare("SELECT set_key,status FROM kg_page_sets ORDER BY set_key").all(),
      ).toEqual([
        { set_key: "checkpoint", status: "succeeded" },
        { set_key: "unstarted", status: "ended" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  test.each([
    ["overlay", "status-unavailable"],
    ["overlay", "stop-unconfirmed"],
    ["pages", "status-unavailable"],
    ["pages", "stop-unconfirmed"],
  ])("%s retains its source claim when %s", async (kind, failure) => {
    const { sqlite, env } = await fixture();
    const consumerKind = kind === "overlay" ? "knowledge-overlay" : "knowledge-pages-build";
    const consumerId = kind === "overlay" ? "repo:work:build" : "build";
    sqlite
      .prepare(`INSERT INTO timeline_source_roots
      (repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
      VALUES('repo','work',?,?,?,'2025-01-01')`)
      .run(consumerKind, consumerId, oid);
    const run = {
      buildId: "build",
      sourceId: "work",
      ref,
      key: "checkpoint",
      commit: oid,
      base: oid,
      startedAt: 0,
    };
    const values = new Map<string, unknown>([
      [
        "state",
        {
          repoId: "repo",
          overlays:
            kind === "overlay"
              ? { [ref]: { running: run, done: null, retries: 0, lastError: null } }
              : {},
          pages: kind === "pages" ? { build: run } : {},
        },
      ],
    ]);
    Object.assign(env, {
      DB: d1(sqlite),
      KNOWLEDGE_BUILD: {
        get: async () => ({
          status: async () => {
            if (failure === "status-unavailable") throw new Error("Workflow status unavailable");
            return { status: "running" };
          },
          terminate: async () => {
            throw new Error("Workflow termination not acknowledged");
          },
        }),
      },
    } as unknown as Env);
    const coordinator = new KnowledgeCoordinator(
      {
        storage: {
          get: async (key: string) => values.get(key),
          put: async (key: string, value: unknown) => {
            values.set(key, value);
          },
          setAlarm: async () => {},
        },
        blockConcurrencyWhile: async (work: () => Promise<unknown>) => work(),
      } as unknown as DurableObjectState,
      env,
    );
    try {
      await expect(coordinator.alarm()).rejects.toThrow(
        failure === "status-unavailable"
          ? "Workflow status unavailable"
          : "Workflow termination not acknowledged",
      );
      expect(sqlite.prepare("SELECT consumer_id FROM timeline_source_roots").all()).toEqual([
        { consumer_id: consumerId },
      ]);
      const state = await coordinator.status();
      if (kind === "overlay") expect(state.overlays[ref]?.running?.buildId).toBe("build");
      else expect(state.pages.map((page) => page.buildId)).toEqual(["build"]);
    } finally {
      sqlite.close();
    }
  });
});
