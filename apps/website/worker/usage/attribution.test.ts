// Costs by person, agent and timeline (CORE-222): CI through each job's run,
// Workers AI through who asked, both at the report's prices over its window;
// what no one caused is listed with its reason, and the parts add up.

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { UsageScope } from "../../shared/usage.ts";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { attributionReport, type AttributionInput } from "./attribution.ts";
import { instanceSize } from "./containers.ts";
import { priceTimeline } from "./prices.ts";
import { priceLines, pricing, WINDOW_DAYS, windowOf } from "./report.ts";

const FLASH = "@cf/zai-org/glm-5.3-flash";
const EMBED = "@cf/qwen/qwen3-embedding-0.6b";
const ASOF = "2026-10-20";
const { from, to } = windowOf(ASOF);
const IN = "2026-10-10";

/** A sandbox job's seconds at Containers' per-second list prices (standard-1, the default). */
const ciUsd = (seconds: number) => {
  const size = instanceSize(null);
  return seconds * (size.vcpu * 0.00002 + size.memoryGib * 0.0000025 + size.diskGb * 0.00000007);
};

let sqlite: DatabaseSync;
let close: () => void;

afterEach(() => close?.());

beforeEach(async () => {
  const fresh = await createFreshSpaceTestEnvironment();
  ({ sqlite, close } = fresh);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('acc_ann', 'user', 'ann', 'Ann'), ('acc_bob', 'user', 'bob', 'Bob'),
      ('acc_cat', 'user', 'cat', 'Cat'), ('acc_dan', 'user', 'dan', 'Dan');
    BEGIN;
    INSERT INTO organizations (id, slug, display_name, kind, default_space_id) VALUES
      ('org_orbit', 'orbit-company', 'Orbit Company', 'company', 'acc_o'),
      ('org_other', 'other-company', 'Other Company', 'company', 'acc_x');
    INSERT INTO spaces (id, organization_id, slug, display_name) VALUES
      ('acc_o', 'org_orbit', 'orbit', 'Orbit'), ('acc_x', 'org_other', 'other', 'Other');
    -- Dan owns the Organization but has no grant to its Space: no one names him.
    INSERT INTO organization_members (organization_id, account_id, role, origin, granted_by) VALUES
      ('org_orbit', 'acc_ann', 'owner', 'test', 'acc_ann'),
      ('org_orbit', 'acc_bob', 'member', 'test', 'acc_ann'),
      ('org_orbit', 'acc_dan', 'owner', 'test', 'acc_ann');
    INSERT INTO space_grants (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by) VALUES
      ('acc_o', 'org_orbit', 'acc_ann', 'admin', 'write', 'write', 'test', 'acc_ann'),
      ('acc_o', 'org_orbit', 'acc_bob', 'member', 'write', 'read', 'test', 'acc_ann');
    COMMIT;
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_bot', 'ann-bot', 'acc_ann');
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('repo_1', 'acc_o', 'engine', 'private', 'n1', 'https://x'),
      ('repo_x', 'acc_x', 'elsewhere', 'private', 'nx', 'https://x');
    INSERT INTO timeline_work_sources (source_id, repo_id, timeline_id, timeline_slug, space_id,
      artifacts_name, state, allocation_operation_id, fork_source_id, fork_commit, fork_tree,
      fork_ref, initial_source_id, initial_commit, initial_tree, initial_ref, created_at, updated_at)
      VALUES ('src_t', 'repo_1', 'tl_1', 'search-v2', 'acc_o', 'w1', 'ready', 'op1', 'canonical',
        'c', 't', 'refs/heads/main', 'canonical', 'c', 't', 'refs/heads/main', 'now', 'now');
    INSERT INTO source_integration_receipts (id, landing_id, checkpoint_id, repo_id, source_id,
      source_commit, source_tree, logical_base_json, dependencies_json, canonical_base,
      canonical_commit, canonical_tree, noop, status, created_at)
      VALUES ('rc1', 'land_1', 'cp1', 'repo_1', 'src_t', 'c', 't', '{}', '[]', 'c', 'c', 't', 0, 'done', 'now');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, actor_id, agent_id, source_id, landing_id) VALUES
      ('run_ann', 'repo_1', 1, 'c', 'refs/heads/main', 'push', 'succeeded', 'acc_ann', NULL, 'canonical', NULL),
      ('run_bot', 'repo_1', 2, 'c', 'refs/heads/work', 'push', 'succeeded', 'acc_ann', 'agt_bot', 'src_t', NULL),
      ('run_land', 'repo_1', 3, 'c', 'refs/heads/main', 'manual', 'succeeded', 'acc_bob', NULL, 'canonical', 'land_1'),
      ('run_sys', 'repo_1', 4, 'c', 'refs/heads/main', 'manual', 'succeeded', NULL, NULL, 'canonical', NULL),
      ('run_x', 'repo_x', 1, 'c', 'refs/heads/main', 'push', 'succeeded', 'acc_bob', NULL, 'canonical', NULL);
    INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, started_at, finished_at) VALUES
      ('j_ann', 'run_ann', 'repo_1', 'a', '{}', 'succeeded', 'sandbox', '${IN}T10:00:00.000Z', '${IN}T10:10:00.000Z'),
      ('j_bot', 'run_bot', 'repo_1', 'a', '{}', 'succeeded', 'sandbox', '${IN}T11:00:00.000Z', '${IN}T11:20:00.000Z'),
      ('j_land', 'run_land', 'repo_1', 'a', '{}', 'succeeded', 'sandbox', '${IN}T12:00:00.000Z', '${IN}T12:05:00.000Z'),
      ('j_sys', 'run_sys', 'repo_1', 'a', '{}', 'succeeded', 'sandbox', '${IN}T13:00:00.000Z', '${IN}T13:05:00.000Z'),
      -- Not counted: a local runner, a job before the window, another Space's.
      ('j_local', 'run_ann', 'repo_1', 'b', '{}', 'succeeded', 'local', '${IN}T10:00:00.000Z', '${IN}T11:00:00.000Z'),
      ('j_old', 'run_ann', 'repo_1', 'c', '{}', 'succeeded', 'sandbox', '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z'),
      ('j_x', 'run_x', 'repo_x', 'a', '{}', 'succeeded', 'sandbox', '${IN}T10:00:00.000Z', '${IN}T10:30:00.000Z'),
      -- The window starts at midnight on its first day and ends before the report's day.
      ('j_first', 'run_sys', 'repo_1', 'd', '{}', 'succeeded', 'sandbox', '${from}T00:00:00.000Z', '${from}T00:00:00.000Z'),
      ('j_asof', 'run_sys', 'repo_1', 'e', '{}', 'succeeded', 'sandbox', '${to}T23:00:00.000Z', '${ASOF}T00:00:00.000Z');
    INSERT INTO ai_usage (day, scope_kind, scope_id, feature, model, actor_id, agent_id, timeline, calls, input_tokens, output_tokens, total_tokens) VALUES
      ('${IN}', 'person', 'acc_ann', 'assistant', '${FLASH}', 'acc_ann', '', '', 4, 1000000, 500000, 1500000),
      ('${IN}', 'space', 'acc_o', 'search', '${EMBED}', 'acc_ann', 'agt_bot', 'search-v2', 6, 0, 0, 2000000),
      ('${IN}', 'space', 'acc_o', 'knowledge', '${FLASH}', '', '', '', 10, 2000000, 0, 2000000),
      ('${IN}', 'space', 'acc_o', 'release_notes', '${FLASH}', '', '', '', 1, 0, 1000000, 1000000),
      ('${IN}', 'space', 'acc_o', 'avatars', '@cf/black-forest-labs/flux-1-schnell', '', '', '', 2, 0, 0, 0),
      -- Cat has no grant to Orbit: she searched one of its public repositories.
      ('${IN}', 'space', 'acc_o', 'search', '${EMBED}', 'acc_cat', '', '', 3, 0, 0, 1000000),
      -- The window's last day counts; the report's own day doesn't yet.
      ('${to}', 'space', 'acc_o', 'assistant', '${FLASH}', 'acc_bob', '', '', 1, 0, 0, 0),
      ('${ASOF}', 'space', 'acc_o', 'assistant', '${FLASH}', 'acc_bob', '', '', 7, 0, 0, 0),
      -- Not counted: before the window, a Space's own provider, another Space's,
      -- and a person scope whose id matches the Space's (an id is not a grant).
      ('2026-09-01', 'space', 'acc_o', 'knowledge', '${FLASH}', '', '', '', 50, 9000000, 0, 9000000),
      ('${IN}', 'space', 'acc_o', 'knowledge', 'openrouter:google/gemini-3-flash', '', '', '', 5, 500, 50, 550),
      ('${IN}', 'space', 'acc_x', 'assistant', '${FLASH}', 'acc_bob', '', '', 1, 1000000, 0, 1000000),
      ('${IN}', 'person', 'acc_o', 'assistant', '${FLASH}', 'acc_dan', '', '', 9, 1000000, 0, 1000000);
  `);
});

const space = (id: string): UsageScope => ({ kind: "space", id });
const person = (id: string): UsageScope => ({ kind: "person", id });

async function attribution(scope: UsageScope | null) {
  const db = d1(sqlite);
  const p = pricing(await priceTimeline(db), ASOF, WINDOW_DAYS);
  const input: AttributionInput = {
    scope,
    from,
    to,
    asOf: ASOF,
    storageUsd: 5,
    price: (rows) => priceLines(rows, scope?.kind ?? "instance", p, from),
  };
  return attributionReport(db, input);
}

describe("costs by person, agent and timeline", () => {
  test("CI follows each job's run, AI who asked; an agent's work is the agent's", async () => {
    // The assistant's calls are recorded under the person's own scope.
    const orbit = await attribution(space("acc_o"));
    const ann = await attribution(person("acc_ann"));
    expect(ann.people).toEqual([
      expect.objectContaining({ id: "acc_ann", name: "Ann", aiCalls: 4, ciJobs: 0 }),
    ]);
    // 1M input × $0.15/M + 0.5M output × $0.50/M, the total not priced again.
    expect(ann.people[0]!.aiUsd).toBeCloseTo(0.4, 10);

    const people = Object.fromEntries(orbit.people.map((p) => [p.id, p]));
    expect(Object.keys(people).sort()).toEqual(["acc_ann", "acc_bob", "outside"]);
    expect(people.acc_ann).toMatchObject({ name: "Ann", ciJobs: 1, ciMinutes: 10, aiUsd: 0 });
    expect(people.acc_ann!.ciUsd).toBeCloseTo(ciUsd(600), 8);
    // Bob's assistant call on the window's last day counts; the one on the report's day doesn't.
    expect(people.acc_bob).toMatchObject({ name: "Bob", ciJobs: 1, ciMinutes: 5, aiCalls: 1 });

    expect(orbit.agents).toEqual([
      expect.objectContaining({
        id: "agt_bot",
        name: "ann-bot",
        accountable: { id: "acc_ann", name: "Ann" },
        ciJobs: 1,
        ciMinutes: 20,
        aiCalls: 6,
      }),
    ]);
    const bot = orbit.agents[0]!;
    expect(bot.ciUsd).toBeCloseTo(ciUsd(1200), 8);
    // An embedding model reports only totals: 2M × $0.012/M.
    expect(bot.aiUsd).toBeCloseTo(0.024, 10);
    expect(bot.totalUsd).toBeCloseTo(bot.ciUsd + bot.aiUsd, 10);
  });

  test("a timeline counts its work source's runs, the runs that land it, and AI asked for it", async () => {
    const { timelines } = await attribution(space("acc_o"));
    expect(timelines).toEqual([
      expect.objectContaining({ id: "acc_o/search-v2", name: "search-v2", ciJobs: 2, aiCalls: 6 }),
    ]);
    expect(timelines[0]!.ciUsd).toBeCloseTo(ciUsd(1200 + 300), 8);
    expect(timelines[0]!.aiUsd).toBeCloseTo(0.024, 10);
  });

  test("what no one caused is listed with its reason, and the parts add up", async () => {
    const orbit = await attribution(space("acc_o"));
    expect(orbit.unattributed.map((u) => u.id)).toEqual([
      "storage",
      "ci-system",
      "ai-builds",
      "ai-background",
      "ai-unknown",
    ]);
    const cost = Object.fromEntries(orbit.unattributed.map((u) => [u.id, u.costUsd]));
    expect(cost.storage).toBe(5);
    expect(cost["ci-system"]).toBeCloseTo(ciUsd(300), 8);
    // Knowledge: 2M input × $0.15/M. Release notes: 1M output × $0.50/M.
    expect(cost["ai-builds"]).toBeCloseTo(0.3, 10);
    expect(cost["ai-background"]).toBeCloseTo(0.5, 10);
    for (const u of orbit.unattributed) expect(u.reason.length).toBeGreaterThan(20);

    const people = orbit.people.reduce((sum, p) => sum + p.totalUsd, 0);
    const agents = orbit.agents.reduce((sum, a) => sum + a.totalUsd, 0);
    expect(orbit.attributedUsd).toBeCloseTo(people + agents, 10);
    const unattributedActivity = orbit.unattributed
      .filter((u) => u.id !== "storage")
      .reduce((sum, u) => sum + u.costUsd, 0);
    expect(orbit.activityUsd).toBeCloseTo(orbit.attributedUsd + unattributedActivity, 10);
    expect({ from: orbit.from, to: orbit.to }).toEqual({ from, to });
  });

  test("people without a grant to the Space are counted together, not named", async () => {
    const orbit = await attribution(space("acc_o"));
    const outside = orbit.people.find((p) => p.id === "outside")!;
    expect(outside).toMatchObject({ name: "People outside this Space", aiCalls: 3 });
    // 1M tokens of an embedding model, priced as input ($0.012/M).
    expect(outside.aiUsd).toBeCloseTo(0.012, 10);
    expect(JSON.stringify(orbit)).not.toContain("Cat");
    // Organization ownership grants nothing: Dan's person-scope calls stay out.
    expect(JSON.stringify(orbit)).not.toContain("Dan");
  });

  test("revoking a Space grant moves its person outside", async () => {
    sqlite.exec("DELETE FROM space_grants WHERE space_id = 'acc_o' AND account_id = 'acc_bob'");
    const orbit = await attribution(space("acc_o"));
    expect(orbit.people.map((p) => p.id).sort()).toEqual(["acc_ann", "outside"]);
    expect(JSON.stringify(orbit)).not.toContain("Bob");
  });

  test("the Instance's view names everyone and tells same-named timelines apart", async () => {
    sqlite.exec(`
      INSERT INTO ai_usage (day, scope_kind, scope_id, feature, model, actor_id, agent_id, timeline, calls, total_tokens)
        VALUES ('${IN}', 'space', 'acc_x', 'assistant', '${EMBED}', 'acc_bob', '', 'search-v2', 1, 10);
    `);
    const site = await attribution(null);
    const bob = site.people.find((p) => p.id === "acc_bob")!;
    // Bob's landing run in Orbit and his run in Other; his assistant calls in Other and Orbit.
    expect(bob).toMatchObject({ ciJobs: 2, aiCalls: 3 });
    expect(bob.ciUsd).toBeCloseTo(ciUsd(300 + 1800), 8);
    expect(site.people.find((p) => p.id === "acc_cat")).toMatchObject({ name: "Cat" });
    expect(
      site.timelines.map((t) => [t.id, t.name]).toSorted((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ["acc_o/search-v2", "search-v2 (@orbit)"],
      ["acc_x/search-v2", "search-v2 (@other)"],
    ]);
  });
});
