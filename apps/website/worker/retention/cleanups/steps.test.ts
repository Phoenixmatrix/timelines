// Work context retention (CORE-244): what trimming leaves of a step.

import { expect, test } from "vite-plus/test";
import { TRIMMED_TEXT } from "../../../shared/steps.ts";
import { d1, migratedDatabase } from "../../testing/d1.ts";
import type { CleanupContext } from "../engine.ts";
import { stepSteering } from "./steps.ts";

test("trimming keeps a step's why, tests, coverage and each entry's source", async () => {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc', 'org', 'orbit', 'Orbit');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('r', 'acc', 'app', 'private', 'a', 'https://a');
  `);
  const context = {
    why: "Recency matters.",
    instructions: [{ text: "Rank by recency", source: "hook", at: "2025-01-01T00:00:00.000Z" }],
    steering: [
      { text: "Keep score as the tie-breaker", source: "hook" },
      { text: "Noted", source: "agent" },
    ],
    tests: [{ command: "vp test", exit: 0, summary: "ok", origin: "local" }],
    coverage: { instructions: "hook:claude-code", steering: "hook:claude-code" },
  };
  sqlite
    .prepare(
      `INSERT INTO step_contexts (repo_id, change_id, commit_oid, author_id, accountable_id,
         summary, context, committed_at) VALUES ('r', 'c1', ?, 'acc', 'acc', 'Step', ?, ?)`,
    )
    .run("a".repeat(40), JSON.stringify(context), "2025-01-01T00:00:00.000Z");
  const ctx: CleanupContext = {
    env: { DB: d1(sqlite) } as unknown as Env,
    target: { scope: "account", accountId: "acc" },
    thresholds: { days: 365 },
    now: new Date("2026-10-04T00:00:00.000Z"),
    limit: 10,
  };
  const selected = await stepSteering.select(ctx, null);
  expect(selected.items).toHaveLength(1);
  expect(await stepSteering.remove(ctx, selected.items)).toMatchObject({ count: 1 });
  const row = sqlite.prepare("SELECT context FROM step_contexts").get() as { context: string };
  const after = JSON.parse(row.context) as typeof context & { trimmedAt: string };
  expect(after).toMatchObject({
    why: "Recency matters.",
    tests: context.tests,
    coverage: context.coverage,
    trimmedAt: "2026-10-04T00:00:00.000Z",
  });
  expect(after.instructions).toEqual([
    { text: TRIMMED_TEXT, source: "hook", at: "2025-01-01T00:00:00.000Z" },
  ]);
  expect(after.steering).toEqual([
    { text: TRIMMED_TEXT, source: "hook" },
    { text: TRIMMED_TEXT, source: "agent" },
  ]);
  // Done once: nothing left to select.
  expect((await stepSteering.select(ctx, null)).items).toEqual([]);
});
