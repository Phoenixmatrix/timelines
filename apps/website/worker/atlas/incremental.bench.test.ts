// Atlas projection timings on a synthetic repository (CORE-166). Skipped
// unless ATLAS_BENCH sets the file count:
//   NODE_OPTIONS=--max-old-space-size=8192 ATLAS_BENCH=20000 \
//     vp test --disableConsoleIntercept worker/atlas/incremental.bench.test.ts
// Prints each phase's local time and D1 round trips for a full pass, an
// unchanged rebuild, and pushes touching one and ten files. Local node:sqlite
// has no network, so production adds round trips x D1 latency, plus Workflow
// step overhead per batch.

import { describe, test } from "vite-plus/test";
import { d1 as wrap, migratedDatabase } from "../testing/d1.ts";
import {
  atlasPass,
  changeFiles,
  countingInfer,
  storeGraph,
  syntheticRepo,
} from "../testing/atlas-repo.ts";

const SIZE = Number(process.env.ATLAS_BENCH ?? 0);

/** D1 with a count of round trips (a batch is one). */
function counted(d1: D1Database) {
  const counter = { trips: 0 };
  const statement = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => statement(target.bind(...args));
        if (prop === "all" || prop === "first" || prop === "run" || prop === "raw")
          return (...args: unknown[]) => {
            counter.trips++;
            return (target[prop] as (...a: unknown[]) => unknown)(...args);
          };
        return target[prop as keyof D1PreparedStatement];
      },
    });
  const db = {
    prepare: (sql: string) => statement(d1.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => {
      counter.trips += 1 - statements.length;
      return d1.batch(statements);
    },
    exec: (sql: string) => d1.exec(sql),
  } as unknown as D1Database;
  return { db, counter };
}

async function measure(db: D1Database, counter: { trips: number }, buildId: string) {
  const phases: Record<string, { ms: number; trips: number; steps: number }> = {};
  const calls = { n: 0, hashes: [] };
  const result = await atlasPass(db, "r1", buildId, {
    infer: countingInfer(calls),
    phase: async (name, work) => {
      const start = performance.now();
      const trips = counter.trips;
      const out = await work();
      const p = (phases[name] ??= { ms: 0, trips: 0, steps: 0 });
      p.ms += performance.now() - start;
      p.trips += counter.trips - trips;
      p.steps++;
      return out;
    },
  });
  const total = Object.values(phases).reduce((n, p) => n + p.ms, 0);
  const trips = Object.values(phases).reduce((n, p) => n + p.trips, 0);
  const steps = Object.values(phases).reduce((n, p) => n + p.steps, 0);
  const rows = Object.entries(phases).map(
    ([name, p]) =>
      `  ${name.padEnd(13)} ${p.ms.toFixed(0).padStart(6)} ms ${String(p.trips).padStart(5)} trips ${p.steps} steps`,
  );
  console.log(
    `${buildId}: ${result.start.incremental ? "incremental" : "full"}, regrouped ${result.grouping.regrouped}, ` +
      `${total.toFixed(0)} ms, ${trips} trips, ${steps} steps, ${calls.n} model calls\n${rows.join("\n")}`,
  );
}

describe.skipIf(!SIZE)("Atlas projection timings", () => {
  test(`full pass vs pushes on ${SIZE} files`, { timeout: 3_600_000 }, async () => {
    const sqlite = migratedDatabase();
    sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
    BEGIN;
    INSERT INTO organizations (id, slug, display_name, kind, personal_account_id, default_space_id)
      VALUES ('org-ann', 'personal-ann', 'ann', 'personal', 'ann', 'ann');
    INSERT INTO spaces (id, organization_id, slug, display_name)
      VALUES ('ann', 'org-ann', 'ann', 'ann');
    INSERT INTO organization_members (organization_id, account_id, role, origin, granted_by)
      VALUES ('org-ann', 'ann', 'owner', 'test-fixture', 'ann');
    INSERT INTO space_grants (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by)
      VALUES ('ann', 'org-ann', 'ann', 'admin', 'write', 'write', 'test-fixture', 'ann');
    INSERT INTO space_audit (id, organization_id, space_id, actor_id, action, subject_id, detail)
      VALUES ('audit-ann', 'org-ann', 'ann', 'ann', 'space.grant', 'ann', '{"origin":"test-fixture"}');
    COMMIT;
      INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('r1', 'ann', 'big', 'private', 'art-r1', '');
    `);
    const { db, counter } = counted(wrap(sqlite));
    const repo = syntheticRepo(SIZE);
    await storeGraph(sqlite, db, repo, "r1", "full");
    console.log(
      "graph",
      sqlite
        .prepare(
          `SELECT (SELECT count(*) FROM kg_nodes) AS nodes, (SELECT count(*) FROM kg_edges) AS edges`,
        )
        .get(),
    );
    await measure(db, counter, "full");
    await measure(db, counter, "unchanged");
    for (const n of [1, 10]) {
      changeFiles(repo, n);
      const diff = await storeGraph(sqlite, db, repo, "r1", `push-${n}`);
      console.log(`push-${n} graph diff`, {
        added: diff.added.length,
        changed: diff.changed.length,
        removed: diff.removed.length,
      });
      await measure(db, counter, `push-${n}`);
    }
  });
});
