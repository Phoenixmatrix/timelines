// A richly seeded deployment for the retention safety suite (CORE-211,
// worker/retention/safety.test.ts): main D1 (with the dev seed's accounts),
// REGISTRY_DB, the registry's R2 bucket, Orbit's Tracker Durable Object (the
// real class over node:sqlite) and Marco's assistant chats (stand-ins with
// the purgeIfIdle contract; the Agents SDK needs workerd).
//
// For every category with a cleanup, FIXTURES says whose data it covers,
// what a run of it may change, and what must survive it ("never" cases and
// data inside the thresholds). Each category's data has records past its
// default thresholds (at least two, so a run takes several batches) and
// records it must keep. Ages are relative to NOW, 400 days from today: the
// Tracker stamps its events with the real clock and R2 its uploads, so both
// are about 400 days old at NOW.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { FakeR2Bucket } from "@gitmatrix/testing";
import { ANALYZER } from "../../knowledge/analyze.ts";
import { d1, migratedDatabase, migratedRegistryDatabase } from "../../testing/d1.ts";
import { fakeDurableState } from "../../testing/durable-state.ts";
import { Tracker } from "../../tracker/object.ts";
import type { Access } from "../../tracker/store.ts";
import type { CategoryId } from "../categories.ts";
import type { RetentionTarget } from "../policies.ts";

export const DAY = 86_400_000;
/** Midday, 400 days from today. */
export const NOW = new Date(Math.floor(Date.now() / DAY) * DAY + 400 * DAY + DAY / 2);
export const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const dayOf = (days: number) => ago(days).slice(0, 10);
const oid = (n: number) => n.toString(16).padStart(40, "0");

export const ORBIT: RetentionTarget = { scope: "account", accountId: "acc_orbit" };
export const MARCO: RetentionTarget = { scope: "account", accountId: "acc_marco" };
export const SITE: RetentionTarget = { scope: "site" };

/** An assistant chat's Durable Object, as the stand-in holds it. */
export interface ChatObject {
  messages: number;
  busy: boolean;
}

/** Shared with the test's `agents` mock: chat objects by name. */
export const chatObjects = new Map<string, ChatObject>();

export const trackerAccess: Access = {
  actorId: "acc_marco",
  principalId: "acc_marco",
  agents: [],
  owner: { id: "acc_orbit", slug: "orbit", displayName: "Orbit" },
  canAdmin: true,
  members: [{ id: "acc_marco", slug: "marco", displayName: "Marco" }],
  repos: [],
};

export type Rich = ReturnType<typeof richSeed>;

export function richSeed() {
  chatObjects.clear();
  const sqlite = migratedDatabase();
  sqlite.exec(
    readFileSync(
      fileURLToPath(new URL("../../../seed/0001_dev.sql", import.meta.url).href),
      "utf8",
    ),
  );
  const registry = migratedRegistryDatabase();
  const bucket = new FakeR2Bucket();
  const tracker = fakeDurableState({ name: "acc_orbit" });
  const sent: unknown[] = [];
  const env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(registry),
    REGISTRY_BLOBS: bucket,
    JOBS: { send: async (body: unknown) => void sent.push(body) },
  } as unknown as Env;
  const trackerObject = new Tracker(tracker.ctx, env);
  Object.assign(env, { TRACKER: { getByName: () => trackerObject } });

  seedMain(sqlite);
  seedRegistry(registry);
  seedTracker(trackerObject);
  seedChats(sqlite);
  return {
    sqlite,
    registry,
    bucket,
    env,
    sent,
    tracker: { db: tracker.db, ctx: tracker.ctx, object: trackerObject, alarm: tracker.alarm },
    ready: seedBucket(bucket),
  };
}

function seedMain(sqlite: DatabaseSync) {
  sqlite.exec(`
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r_app', 'acc_orbit', 'app', 'private', 'a', 'https://a'),
      ('r_lib', 'acc_orbit', 'lib', 'private', 'b', 'https://b'),
      ('r_sam', 'acc_sam', 'mine', 'private', 'c', 'https://c');
  `);

  // ---- ci-logs, ci-runs: r_app's main has 25 old runs, a recent one and a
  // running one, so runs 1 to 7 are past the latest 20; run_3 has a
  // deployment, run_4 a package publish (REGISTRY_DB): both kept. Sam's old
  // run is another account's.
  const run = sqlite.prepare(`
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, title, created_at, finished_at)
    VALUES (?, ?, ?, ?, 'main', 'push', ?, 'Run', ?, ?)`);
  const job = sqlite.prepare(`
    INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, finished_at)
    VALUES (?, ?, ?, 'build', '{"needs":[]}', ?, 'sandbox', ?)`);
  const step = sqlite.prepare(
    "INSERT INTO ci_steps (job_id, position, name, status) VALUES (?, 0, 'test', 'succeeded')",
  );
  const log = sqlite.prepare("INSERT INTO ci_logs (job_id, seq, step, text) VALUES (?, ?, 0, ?)");
  const addRun = (
    id: string,
    repo: string,
    n: number,
    days: number | null,
    status = "succeeded",
  ) => {
    run.run(id, repo, n, oid(n), status, ago(days ?? 1), days === null ? null : ago(days));
    job.run(
      `job_${id}`,
      id,
      repo,
      status === "running" ? "running" : "succeeded",
      days === null ? null : ago(days),
    );
    step.run(`job_${id}`);
    log.run(`job_${id}`, 1, `log of ${id}\n`);
    log.run(`job_${id}`, 2, "more\n");
  };
  for (let n = 1; n <= 25; n++) addRun(`run_${n}`, "r_app", n, 230 - n);
  addRun("run_recent", "r_app", 26, 1);
  addRun("run_live", "r_app", 27, null, "running");
  addRun("run_sam", "r_sam", 1, 300);

  // ---- preview-records: expired records past 30 days (selected), and kept:
  // recent, live, failed, production, a run's, another account's.
  const deployment = sqlite.prepare(`
    INSERT INTO deployments (id, repo_id, environment, timeline_slug, commit_oid, url, status,
                             expires_at, torn_down_at, updated_at, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const addDeployment = (
    id: number,
    repo: string,
    status: string,
    expired: string | null,
    extra: { environment?: string; run?: string; tornDown?: string | null } = {},
  ) =>
    deployment.run(
      id,
      repo,
      extra.environment ?? `timeline/t${id}`,
      extra.environment ? null : `t${id}`,
      oid(id),
      `https://p${id}.example.com`,
      status,
      expired,
      extra.tornDown === undefined ? expired : extra.tornDown,
      expired ?? ago(1),
      extra.run ?? null,
    );
  for (let id = 1; id <= 3; id++)
    addDeployment(id, id % 2 ? "r_app" : "r_lib", "expired", ago(40 + id));
  addDeployment(20, "r_app", "expired", ago(10));
  addDeployment(21, "r_app", "active", ago(-5), { tornDown: null, run: "run_3" });
  addDeployment(22, "r_app", "failed", ago(90), { tornDown: null });
  addDeployment(23, "r_app", "active", null, { tornDown: null, environment: "production" });
  addDeployment(24, "r_sam", "expired", ago(90));

  // ---- knowledge-builds (days 90, keepLatest 20): r_app's 25 builds, 199 to
  // 175 days old; b01 is behind the current graph, b02 a kept Atlas
  // snapshot, b04 still runs; b03 (only an expired snapshot's) and b05 go.
  const build = sqlite.prepare(`
    INSERT INTO kg_builds (id, repo_id, to_commit, status, stats, started_at, finished_at)
    VALUES (?, ?, 'c', ?, '{"files":1}', ?, ?)`);
  const change = sqlite.prepare(`
    INSERT INTO kg_changes (repo_id, build_id, node_id, kind, change) VALUES (?, ?, ?, 'file', 'changed')`);
  const addBuild = (id: string, repo: string, days: number, status = "succeeded") => {
    build.run(id, repo, status, ago(days), status === "running" ? null : ago(days - 0.01));
    for (const node of ["file:a.ts", "file:b.ts"]) change.run(repo, id, node);
  };
  for (let i = 1; i <= 25; i++) addBuild(`b${String(i).padStart(2, "0")}`, "r_app", 200 - i);
  addBuild("s1", "r_sam", 400);
  addBuild("s2", "r_sam", 399);
  sqlite.exec(`
    UPDATE kg_builds SET status = 'running', finished_at = NULL WHERE id = 'b04';
    INSERT INTO kg_state (repo_id, indexed_commit, last_build_id) VALUES ('r_app', 'c', 'b01');
    INSERT INTO kg_nodes (repo_id, id, kind, name, summary, data, content_hash, changed_in)
      VALUES ('r_app', 'file:a.ts', 'file', 'a.ts', 'A', '{}', 'h', 'b01');
    INSERT INTO atlas_scopes (scope, kind, repo_id) VALUES ('repo:r_app', 'repo', 'r_app');
    INSERT INTO atlas_snapshots (id, scope, seq, status, projection_version, vector)
      VALUES ('snap1', 'repo:r_app', 1, 'expired', 1, '[{"repoId":"r_app","commit":"c","buildId":"b03"}]'),
             ('snap2', 'repo:r_app', 2, 'published', 1, '[{"repoId":"r_app","commit":"c","buildId":"b02"}]');
  `);

  // ---- ended-timeline-data (days 90): two timelines that ended long ago go;
  // a recent one, an open one and Sam's stay; main's wiki is never touched.
  const overlay = sqlite.prepare(`
    INSERT INTO kg_overlays (repo_id, ref, overlay_id, head_commit, base_commit, stats,
                             updated_at, status, attempted_commit, ended_at, ended_reason)
    VALUES (?, ?, ?, 'tip', 'base', '{"stored":2}', ?, 'succeeded', 'tip', ?, ?)`);
  const overlayChange = sqlite.prepare(`
    INSERT INTO kg_overlay_changes (repo_id, overlay_id, node_id, kind, change, name, path, summary)
    VALUES (?, ?, ?, 'file', 'added', ?, ?, 'new')`);
  const regrouping = sqlite.prepare(`
    INSERT INTO atlas_timeline_regroupings (repo_id, overlay_id, version, grouping_version, state, data, created_at)
    VALUES (?, ?, 1, 1, 'ready', '{"groups":[]}', ?)`);
  const pageSet = sqlite.prepare(`
    INSERT INTO kg_page_sets (repo_id, ref, set_key, commit_oid, status, stats)
    VALUES (?, ?, 'k1', 'tip', 'succeeded', '{}')`);
  const page = sqlite.prepare(`
    INSERT INTO kg_page_set_pages (repo_id, ref, set_key, slug, title, section, position, kind,
                                   change, outcome, body, inputs_hash)
    VALUES (?, ?, 'k1', ?, 'Page', 'Components', 0, 'component', 'added', 'written', 'Body', 'h')`);
  const addOverlay = (repo: string, slug: string, ended: number | null) => {
    const ref = `refs/heads/timeline/${slug}`;
    const id = `ov-${repo}-${slug}`;
    overlay.run(
      repo,
      ref,
      id,
      ago(200),
      ended === null ? null : ago(ended),
      ended === null ? null : "landed",
    );
    for (const n of ["a", "b"]) overlayChange.run(repo, id, `file:${n}.ts`, `${n}.ts`, `${n}.ts`);
    regrouping.run(repo, id, ago(200));
    pageSet.run(repo, ref);
    for (const s of ["one", "two"]) page.run(repo, ref, s);
  };
  addOverlay("r_app", "old", 100);
  addOverlay("r_lib", "older", 300);
  addOverlay("r_app", "recent", 30);
  addOverlay("r_app", "live", null);
  addOverlay("r_sam", "theirs", 300);
  sqlite.exec(`
    INSERT INTO wiki_pages (repo_id, slug, title, section, position, body, sources, inputs_hash, generated_in)
      VALUES ('r_app', 'overview', 'Overview', 'Overview', 0, 'Main', '[]', 'h', 'b01');
  `);

  // ---- analysis-caches (site, days 30): analyses unused long ago and in no
  // current build go, as do syntheses older than the current build; an
  // analysis of a current file, and fresh entries, stay.
  const analysis = sqlite.prepare(`
    INSERT INTO kg_blob_analysis (blob_oid, analyzer, language, data, used_at)
    VALUES (?, ?, 'ts', '{"summary":"s"}', ?)`);
  analysis.run("current", ANALYZER, ago(100));
  analysis.run("stale", ANALYZER, ago(100));
  analysis.run("current", "v0", ago(100));
  analysis.run("fresh", ANALYZER, ago(10));
  const synthesis = sqlite.prepare(
    "INSERT INTO kg_synthesis (key, data, used_at) VALUES (?, '\"x\"', ?)",
  );
  synthesis.run("s-ancient", ago(300));
  synthesis.run("s-unstamped", null);
  synthesis.run("s-fresh", ago(10));
  sqlite.exec(`
    INSERT INTO kg_files (repo_id, snapshot, path, blob_oid, mode)
      VALUES ('r_app', 'current', 'a.ts', 'current', '100644');
  `);

  // ---- ai-spend (site, days 90): per-call rows of old days roll up; a
  // reservation in flight and a recent day stay.
  const spend = sqlite.prepare(`
    INSERT INTO atlas_spend (id, account_id, day, scope, run_id, repo_id, purpose, model, status,
                             input_tokens, output_tokens, cost_micro_usd, reserved_input_tokens,
                             reserved_output_tokens, reserved_micro_usd, created_at)
    VALUES (?, ?, ?, 'build', ?, ?, 'capability_summary', 'test/model', ?, 10, 100, 1000, 10, 1000, 1000000, ?)`);
  const addSpend = (id: string, account: string, days: number, status: string) =>
    spend.run(
      id,
      account,
      dayOf(days),
      `run-${days}`,
      account === "acc_orbit" ? "r_app" : "r_sam",
      status,
      `${dayOf(days)}T12:00:00.000Z`,
    );
  addSpend("o1", "acc_orbit", 100, "settled");
  addSpend("o2", "acc_orbit", 100, "failed");
  addSpend("o3", "acc_orbit", 120, "settled");
  addSpend("o4", "acc_orbit", 120, "reserved");
  addSpend("o5", "acc_orbit", 10, "settled");
  addSpend("s1", "acc_sam", 100, "settled");

  // ---- push-log (days 365): main and live exist; a deleted bookmark's
  // entries and an old gone ref's go; each live ref's latest entry, a kept
  // change ref's first entry and recent entries stay.
  sqlite.exec(`
    INSERT INTO repo_refs (repo_id, ref, oid) VALUES
      ('r_app', 'refs/heads/main', '${oid(3)}'), ('r_app', 'refs/heads/live', '${oid(20)}'),
      ('r_sam', 'refs/heads/main', '${oid(31)}');
  `);
  const update = sqlite.prepare(
    "INSERT INTO ref_updates (id, repo_id, ref, old_oid, new_oid, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const changeRef = sqlite.prepare(`
    INSERT INTO change_refs (repo_id, change_id, ref, first_commit_oid, first_update_id, first_seen_at, last_commit_oid, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  update.run(1, "r_app", "refs/heads/main", null, oid(1), ago(900));
  update.run(2, "r_app", "refs/heads/main", oid(1), oid(2), ago(800));
  update.run(3, "r_app", "refs/heads/main", oid(2), oid(3), ago(700));
  update.run(20, "r_app", "refs/heads/live", null, oid(20), ago(600));
  update.run(10, "r_app", "refs/heads/timeline/old", null, oid(10), ago(500));
  update.run(11, "r_app", "refs/heads/timeline/old", oid(10), null, ago(499));
  update.run(12, "r_app", "refs/heads/timeline/new", null, oid(12), ago(10));
  update.run(14, "r_lib", "refs/heads/gone", null, oid(14), ago(400));
  update.run(30, "r_sam", "refs/heads/old", null, oid(30), ago(900));
  update.run(31, "r_sam", "refs/heads/main", null, oid(31), ago(900));
  changeRef.run("r_app", "ch_main", "refs/heads/main", oid(2), 2, ago(800), oid(2), ago(800));
  changeRef.run(
    "r_app",
    "ch_old",
    "refs/heads/timeline/old",
    oid(10),
    10,
    ago(500),
    oid(10),
    ago(500),
  );
  changeRef.run(
    "r_app",
    "ch_new",
    "refs/heads/timeline/new",
    oid(12),
    12,
    ago(10),
    oid(12),
    ago(10),
  );
  changeRef.run("r_sam", "ch_sam", "refs/heads/old", oid(30), 30, ago(900), oid(30), ago(900));

  // ---- release-notes (days 730): old dailies and an old tag go; each
  // kind's latest release and Sam's stay.
  const note = sqlite.prepare(`
    INSERT INTO release_notes (repo_id, release, to_oid, intro, released_at, updated_at)
    VALUES (?, ?, 'c', 'Intro', ?, ?)`);
  const entry = sqlite.prepare(`
    INSERT INTO release_note_entries (id, repo_id, release, subject, kind, category, title, summary,
                                      issue_key, shipped_at, inputs_hash, updated_at)
    VALUES (?, ?, ?, ?, 'issue', 'feature', 'Title', 'Summary', ?, ?, 'h', ?)`);
  const mention = sqlite.prepare(
    "INSERT INTO release_note_mentions (repo_id, issue_key) VALUES (?, ?)",
  );
  const addNote = (repo: string, release: string, days: number, key: string) => {
    note.run(repo, release, ago(days), ago(days));
    entry.run(
      `${repo}-${release}`,
      repo,
      release,
      `issue:acc_orbit:${key}`,
      key,
      ago(days),
      ago(days),
    );
    mention.run(repo, key);
  };
  addNote("r_app", "@day:1", 800, "ENG-1");
  addNote("r_app", "@day:2", 790, "ENG-2");
  addNote("r_app", "@day:3", 780, "ENG-3");
  addNote("r_app", "v0", 900, "ENG-4");
  addNote("r_app", "v1", 850, "ENG-5");
  addNote("r_sam", "v0", 900, "SAM-1");
  sqlite.exec("INSERT INTO release_note_state (repo_id) VALUES ('r_app')");

  // ---- auth-hygiene (site, days 7): sign-in state that ended over a week
  // ago goes; live sessions, valid tokens, active lockouts stay.
  sqlite.exec(`
    INSERT INTO auth_sessions (id, expiresAt, token, createdAt, updatedAt, userId) VALUES
      ('s_old', '${ago(30)}', 't_old', '${ago(60)}', '${ago(60)}', 'acc_fward'),
      ('s_recent', '${ago(2)}', 't_recent', '${ago(9)}', '${ago(9)}', 'acc_fward'),
      ('s_live', '${ago(-10)}', 't_live', '${ago(1)}', '${ago(1)}', 'acc_fward');
    INSERT INTO auth_verifications (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES
      ('v_old', 'sign-in-otp-x', 'code', '${ago(8)}', '${ago(8)}', '${ago(8)}');
    INSERT INTO auth_device_codes (id, deviceCode, userCode, expiresAt, status) VALUES
      ('d_old', 'dc', 'UC', '${ago(10)}', 'pending'), ('d_live', 'dc2', 'UC2', '${ago(-1)}', 'pending');
    INSERT INTO auth_lockouts (key, until) VALUES ('ip:old', '${ago(20)}'), ('ip:active', '${ago(-0.01)}');
    INSERT INTO ssh_keys (id, user_id, title, key_type, public_key, fingerprint, scope)
      VALUES ('k1', 'acc_marco', 'laptop', 'ssh-ed25519', 'ssh-ed25519 AAAA', 'SHA256:x', 'read');
    INSERT INTO ssh_challenges (nonce, key_id, origin, expires_at) VALUES
      ('n_old', 'k1', 'http://gitmatrix.test', '${ago(7.5)}'), ('n_live', 'k1', 'http://gitmatrix.test', '${ago(-0.01)}');
    INSERT INTO access_tokens (id, user_id, name, scope, token_hash, last_four, expires_at) VALUES
      ('tok_old', 'acc_marco', 'old', 'read', 'h_old', 'aaaa', '${ago(100)}'),
      ('tok_week', 'acc_marco', 'week', 'read', 'h_week', 'bbbb', '${ago(6)}'),
      ('tok_forever', 'acc_marco', 'forever', 'read', 'h_forever', 'cccc', NULL);
    INSERT INTO ci_job_tokens (token_hash, job_id, expires_at) VALUES
      ('cj_old', 'job_run_1', '${ago(30)}'), ('cj_live', 'job_run_recent', '${ago(-1)}');
  `);

  // ---- usage-history (site, days 90, months 24), ai-usage (site, days 90):
  // 120 days of figures; the latest day of each account and construct and
  // the recent days stay, older days roll up into months.
  const snapshot = sqlite.prepare(`
    INSERT INTO usage_snapshots (day, account_id, construct, item, metric, kind, quantity, estimated, method, collected_at)
    VALUES (?, ?, 'd1', 'repositories', ?, 'storage', ?, 0, 'seeded', ?)`);
  const ai = sqlite.prepare(`
    INSERT INTO ai_usage (day, account_id, feature, model, calls, input_tokens, output_tokens, total_tokens)
    VALUES (?, ?, 'assistant', '@cf/model', ?, ?, ?, ?)`);
  for (let days = 120; days >= 1; days--) {
    for (const account of ["acc_orbit", ""]) {
      snapshot.run(dayOf(days), account, "rows", 1000 + days, ago(days - 1));
      snapshot.run(dayOf(days), account, "bytes", 4096 * days, ago(days - 1));
    }
    ai.run(dayOf(days), "acc_orbit", days % 5, days * 10, days * 3, days * 13);
  }
  // An account whose collection stopped long ago: its latest day stays.
  for (let days = 200; days >= 150; days -= 10)
    snapshot.run(dayOf(days), "acc_jun", "rows", days, ago(days));
  sqlite.exec(`
    INSERT INTO usage_monthly (month, account_id, construct, item, metric, kind, quantity, days, last_day, last_quantity, method)
    VALUES ('${dayOf(1200).slice(0, 7)}', 'acc_orbit', 'd1', 'repositories', 'rows', 'storage', 31000, 31, '${dayOf(1200)}', 1000, 'seeded'),
           ('${dayOf(1300).slice(0, 7)}', 'acc_orbit', 'd1', 'repositories', 'rows', 'storage', 31000, 31, '${dayOf(1300)}', 1000, 'seeded');
  `);

  // ---- durable-registry (site, days 30): rows of instances purged long
  // ago go; recently purged, live ones and Orbit's Tracker stay.
  sqlite.exec(`
    INSERT INTO do_instances (class, name, account_id, created_at, last_active_at, purged_at, purge_reason) VALUES
      ('Assistant', 'acc_marco:gone-1', 'acc_marco', '${ago(100)}', '${ago(60)}', '${ago(40)}', 'chat deleted'),
      ('Assistant', 'acc_marco:gone-2', 'acc_marco', '${ago(100)}', '${ago(60)}', '${ago(50)}', 'chat deleted'),
      ('Assistant', 'acc_marco:gone-recent', 'acc_marco', '${ago(100)}', '${ago(20)}', '${ago(10)}', 'chat deleted'),
      ('Tracker', 'acc_orbit', 'acc_orbit', '${ago(500)}', '${ago(1)}', NULL, NULL);
  `);
}

function seedChats(sqlite: DatabaseSync) {
  // assistant-chats (Marco's, days 90): two idle chats go; a recent one, an
  // idle one with a turn in progress and Jun's idle chat stay.
  const chat = sqlite.prepare(
    "INSERT INTO assistant_chats (id, user_id, title, source, created_at, updated_at) VALUES (?, ?, ?, 'web', ?, ?)",
  );
  const instance = sqlite.prepare(
    "INSERT INTO do_instances (class, name, account_id, created_at, last_active_at, storage_bytes) VALUES ('Assistant', ?, ?, ?, ?, 4096)",
  );
  for (const [user, id, days, busy] of [
    ["acc_marco", "chat-old-1", 200, false],
    ["acc_marco", "chat-old-2", 120, false],
    ["acc_marco", "chat-recent", 10, false],
    ["acc_marco", "chat-busy", 150, true],
    ["acc_jun", "chat-jun", 200, false],
  ] as const) {
    chat.run(id, user, `Chat ${id}`, ago(days + 1), ago(days));
    instance.run(`${user}:${id}`, user, ago(days + 1), ago(days));
    chatObjects.set(`${user}:${id}`, { messages: 12, busy });
  }
}

function seedRegistry(registry: DatabaseSync) {
  registry.exec(`
    INSERT INTO repositories (id, key, format, owner_id, kind, visibility, created_at, updated_at) VALUES
      ('feed_local', 'js-local', 'npm', 'acc_orbit', 'local', 'public', '${ago(900)}', '${ago(900)}'),
      ('feed_remote', 'npmjs', 'npm', 'acc_orbit', 'remote', 'public', '${ago(900)}', '${ago(900)}');
    INSERT INTO blobs (digest, r2_key, size, created_at) VALUES
      ('sha256:aa', 'b/aa', 1000, '${ago(900)}'), ('sha256:bb', 'b/bb', 2000, '${ago(900)}'),
      ('sha256:cc', 'b/cc', 3000, '${ago(900)}');
    -- registry-proxy-cache (days 30): artifact entries unused for 60 and 90
    -- days go; a recently used one stays.
    INSERT INTO remote_entries (repo_id, path, status, digest, fetched_at, expires_at, used_at) VALUES
      ('feed_remote', 'artifact/a/-/a-1.0.0.tgz', 200, 'sha256:aa', '${ago(120)}', '${ago(119)}', '${ago(60)}'),
      ('feed_remote', 'artifact/b/-/b-1.0.0.tgz', 200, 'sha256:bb', '${ago(90)}', '${ago(89)}', NULL),
      ('feed_remote', 'artifact/c/-/c-1.0.0.tgz', 200, 'sha256:cc', '${ago(120)}', '${ago(119)}', '${ago(5)}');
    INSERT INTO derived_files (repo_id, path, r2_key, size, sha256, content_type, updated_at) VALUES
      ('feed_local', 'index/@test/kept', 'd/feed_local/kept', 5, 'x', 'application/json', '${ago(900)}');
    INSERT INTO packages (id, repo_id, name, normalized_name, created_at, updated_at) VALUES
      ('pkg_1', 'feed_local', '@test/kept', '@test/kept', '${ago(900)}', '${ago(900)}');
    -- registry-audit (days 365): old audit entries, an old superseded record
    -- and an old deleted version's record go; the newest record of a
    -- published version (it names run_4), an off-default-branch record and
    -- recent entries stay.
    INSERT INTO audit_log (id, at, actor, action, repo_id, target, detail) VALUES
      ('a1', '${ago(500)}', 'user:acc_marco', 'repo.create', 'feed_local', 'js-local', '{}'),
      ('a2', '${ago(400)}', 'user:acc_marco', 'token.create', NULL, NULL, '{}'),
      ('a3', '${ago(10)}', 'user:acc_marco', 'token.create', NULL, NULL, '{}');
    INSERT INTO publishes (id, feed_id, format, package_id, version, action, status, actor, actor_label, via, at, ci_run_id, off_default_branch) VALUES
      ('pub1', 'feed_local', 'npm', 'pkg_1', '1.0.0', 'publish', 'active', 'user:acc_marco', 'marco', 'token', '${ago(500)}', NULL, 0),
      ('pub2', 'feed_local', 'npm', 'pkg_1', '1.0.0', 'publish', 'active', 'job:job_run_4', 'CI', 'ci', '${ago(450)}', 'run_4', 0),
      ('pub3', 'feed_local', 'npm', 'pkg_1', '0.9.0', 'publish', 'deleted', 'user:acc_marco', 'marco', 'token', '${ago(600)}', NULL, 0),
      ('pub4', 'feed_local', 'npm', 'pkg_1', '2.0.0', 'publish', 'active', 'user:acc_marco', 'marco', 'token', '${ago(600)}', NULL, 1),
      ('pub5', 'feed_local', 'npm', 'pkg_1', '2.0.0', 'publish', 'active', 'user:acc_marco', 'marco', 'token', '${ago(500)}', NULL, 0);
  `);
}

/** R2: orphaned derived objects (go), a referenced one and blobs (stay). */
async function seedBucket(bucket: FakeR2Bucket) {
  for (const key of ["d/feed_local/kept", "d/orphan/1", "d/orphan/2", "b/aa", "b/bb", "b/cc"])
    await bucket.put(key, `object ${key}`);
}

function seedTracker(tracker: Tracker) {
  let operation = 0;
  const mutate = (mutations: object[]) => {
    const reply = tracker.mutate(trackerAccess, {
      operationId: `op-${++operation}`,
      mutations: mutations as never,
    });
    if (!reply.ok) throw new Error(reply.error);
  };
  // closed-issues (days 365), tracker-activity (365, 180): two closed issues
  // go (and their activity), the open one and its history stay.
  mutate([{ kind: "team.create", id: "team", data: { key: "ORB", name: "Orbit" } }]);
  for (const id of ["done-1", "done-2", "open"])
    mutate([{ kind: "issue.create", id, data: { teamId: "team", title: id } }]);
  for (const id of ["done-1", "done-2"])
    mutate([{ kind: "issue.update", id, expectedVersion: 1, data: { status: "done" } }]);
}

// ---- what each category covers, may change and must keep ---------------------

export type Store = `db:${string}` | `registry:${string}` | "tracker" | "r2" | "chats";

export interface Fixture {
  target: RetentionTarget;
  /** What a run of it may change; everything else must stay exactly as it was. */
  touches: Store[];
  /** What it must keep (never cases, data inside the thresholds), as sorted keys. */
  kept(t: Rich): Promise<string[]>;
  /**
   * Records its dry run lists that are in use when the run reaches them, so
   * the run leaves them (its "never" list says so): a chat with a turn in
   * progress. The dry run can't see a turn; only the object can.
   */
  inUse?: number;
}

const keys = (sqlite: DatabaseSync, sql: string) =>
  (sqlite.prepare(sql).all() as { k: unknown }[]).map((r) => String(r.k)).sort();
const db = (t: Rich, sql: string) => Promise.resolve(keys(t.sqlite, sql));

export const FIXTURES: Record<string, Fixture> = {
  "ci-logs": {
    target: ORBIT,
    touches: ["db:ci_logs", "db:ci_jobs"],
    kept: (t) =>
      db(
        t,
        "SELECT DISTINCT job_id AS k FROM ci_logs WHERE job_id IN ('job_run_recent', 'job_run_live', 'job_run_sam')",
      ),
  },
  "ci-runs": {
    target: ORBIT,
    touches: ["db:ci_runs", "db:ci_jobs", "db:ci_steps", "db:ci_logs", "db:ci_job_tokens"],
    kept: (t) =>
      db(
        t,
        "SELECT id AS k FROM ci_runs WHERE id NOT IN ('run_1', 'run_2', 'run_5', 'run_6', 'run_7')",
      ),
  },
  "preview-records": {
    target: ORBIT,
    touches: ["db:deployments"],
    kept: (t) => db(t, "SELECT id AS k FROM deployments WHERE id >= 20"),
  },
  "knowledge-builds": {
    target: ORBIT,
    touches: ["db:kg_builds", "db:kg_changes"],
    kept: (t) =>
      db(
        t,
        `SELECT id AS k FROM kg_builds WHERE id IN ('b01', 'b02', 'b04', 's1', 's2')
           OR id >= 'b06' UNION ALL SELECT 'node ' || id FROM kg_nodes
         UNION ALL SELECT 'snapshot ' || id FROM atlas_snapshots`,
      ),
  },
  "ended-timeline-data": {
    target: ORBIT,
    touches: [
      "db:kg_overlays",
      "db:kg_overlay_changes",
      "db:atlas_timeline_regroupings",
      "db:kg_page_sets",
      "db:kg_page_set_pages",
    ],
    kept: (t) =>
      db(
        t,
        `SELECT o.overlay_id || ' ' || (SELECT count(*) FROM kg_overlay_changes c WHERE c.overlay_id = o.overlay_id)
           || ' ' || (SELECT count(*) FROM kg_page_set_pages p WHERE p.repo_id = o.repo_id AND p.ref = o.ref) AS k
         FROM kg_overlays o WHERE o.ended_at IS NULL OR o.ended_at > '${ago(90)}' OR o.repo_id = 'r_sam'
         UNION ALL SELECT 'wiki ' || slug FROM wiki_pages`,
      ),
  },
  "push-log": {
    target: ORBIT,
    touches: ["db:ref_updates", "db:change_refs"],
    kept: (t) =>
      db(
        t,
        `SELECT 'u ' || id AS k FROM ref_updates WHERE id IN (2, 3, 20, 12, 30, 31)
         UNION ALL SELECT 'c ' || change_id || ' ' || ref FROM change_refs WHERE change_id <> 'ch_old'
         UNION ALL SELECT 'r ' || repo_id || ' ' || ref FROM repo_refs`,
      ),
  },
  "release-notes": {
    target: ORBIT,
    touches: [
      "db:release_notes",
      "db:release_note_entries",
      "db:release_note_mentions",
      "db:release_note_state",
    ],
    kept: (t) =>
      db(
        t,
        `SELECT repo_id || ' ' || release AS k FROM release_notes
           WHERE (repo_id, release) IN (('r_app', '@day:3'), ('r_app', 'v1'), ('r_sam', 'v0'))
         UNION ALL SELECT 'entry ' || id FROM release_note_entries WHERE release IN ('@day:3', 'v1') OR repo_id = 'r_sam'
         UNION ALL SELECT 'mention ' || issue_key FROM release_note_mentions WHERE issue_key IN ('ENG-3', 'ENG-5', 'SAM-1')`,
      ),
  },
  "closed-issues": {
    target: ORBIT,
    touches: ["tracker"],
    kept: async (t) => {
      const snapshot = t.tracker.object.snapshot(trackerAccess);
      if (!snapshot.ok) throw new Error("No tracker snapshot");
      return [
        ...snapshot.value.issues.filter((i) => i.status !== "done").map((i) => `issue ${i.id}`),
        ...snapshot.value.teams.map((team) => `team ${team.id}`),
      ].sort();
    },
  },
  "tracker-activity": {
    target: ORBIT,
    touches: ["tracker"],
    kept: async (t) => {
      const snapshot = t.tracker.object.snapshot(trackerAccess);
      if (!snapshot.ok) throw new Error("No tracker snapshot");
      // Every issue and team stays; only old activity goes.
      return [
        ...snapshot.value.issues.map((i) => `issue ${i.id} ${i.status}`),
        ...snapshot.value.teams.map((team) => `team ${team.id}`),
      ].sort();
    },
  },
  "assistant-chats": {
    target: MARCO,
    inUse: 1,
    touches: ["db:assistant_chats", "db:do_instances", "chats"],
    kept: async (t) =>
      [
        ...keys(
          t.sqlite,
          "SELECT id AS k FROM assistant_chats WHERE id IN ('chat-recent', 'chat-busy', 'chat-jun')",
        ),
        ...[...chatObjects]
          .filter(([name]) => !name.includes("chat-old"))
          .map(([name, chat]) => `${name} ${chat.messages}`),
      ].sort(),
  },
  "analysis-caches": {
    target: SITE,
    touches: ["db:kg_blob_analysis", "db:kg_synthesis"],
    kept: (t) =>
      db(
        t,
        `SELECT 'a ' || blob_oid || ' ' || analyzer AS k FROM kg_blob_analysis
           WHERE (blob_oid = 'current' AND analyzer = '${ANALYZER}') OR blob_oid = 'fresh'
         UNION ALL SELECT 's ' || key FROM kg_synthesis WHERE key = 's-fresh'`,
      ),
  },
  "ai-spend": {
    target: SITE,
    touches: ["db:atlas_spend", "db:atlas_spend_daily"],
    kept: (t) => db(t, "SELECT id AS k FROM atlas_spend WHERE id IN ('o4', 'o5')"),
  },
  "auth-hygiene": {
    target: SITE,
    touches: [
      "db:auth_sessions",
      "db:auth_verifications",
      "db:auth_device_codes",
      "db:auth_lockouts",
      "db:ssh_challenges",
      "db:access_tokens",
      "db:ci_job_tokens",
    ],
    kept: (t) =>
      db(
        t,
        `SELECT 'session ' || id AS k FROM auth_sessions WHERE id IN ('s_recent', 's_live')
         UNION ALL SELECT 'device ' || id FROM auth_device_codes WHERE id = 'd_live'
         UNION ALL SELECT 'lockout ' || key FROM auth_lockouts WHERE key = 'ip:active'
         UNION ALL SELECT 'challenge ' || nonce FROM ssh_challenges WHERE nonce = 'n_live'
         UNION ALL SELECT 'token ' || id FROM access_tokens WHERE id IN ('tok_week', 'tok_forever')
         UNION ALL SELECT 'job token ' || token_hash FROM ci_job_tokens WHERE token_hash = 'cj_live'`,
      ),
  },
  "usage-history": {
    target: SITE,
    touches: ["db:usage_snapshots", "db:usage_monthly"],
    kept: (t) =>
      db(
        t,
        `SELECT day || ' ' || account_id || ' ' || metric AS k FROM usage_snapshots
           WHERE day >= '${dayOf(89)}' OR (account_id = 'acc_jun' AND day = '${dayOf(150)}')`,
      ),
  },
  "ai-usage": {
    target: SITE,
    touches: ["db:ai_usage", "db:ai_usage_monthly"],
    kept: (t) => db(t, `SELECT day AS k FROM ai_usage WHERE day >= '${dayOf(89)}'`),
  },
  "durable-registry": {
    target: SITE,
    touches: ["db:do_instances"],
    kept: (t) =>
      db(
        t,
        "SELECT class || ' ' || name AS k FROM do_instances WHERE name NOT IN ('acc_marco:gone-1', 'acc_marco:gone-2')",
      ),
  },
  "registry-proxy-cache": {
    target: SITE,
    touches: ["registry:remote_entries", "registry:derived_files", "r2"],
    kept: async (t) =>
      [
        ...keys(t.registry, "SELECT path AS k FROM remote_entries WHERE path LIKE 'artifact/c/%'"),
        ...keys(t.registry, "SELECT 'derived ' || r2_key AS k FROM derived_files"),
        ...(await t.bucket.list({})).objects
          .map((o) => `r2 ${o.key}`)
          .filter((k) => !k.includes("orphan")),
      ].sort(),
  },
  "registry-audit": {
    target: SITE,
    touches: ["registry:audit_log", "registry:publishes"],
    kept: (t) =>
      Promise.resolve(
        keys(
          t.registry,
          `SELECT 'audit ' || id AS k FROM audit_log WHERE id = 'a3'
           UNION ALL SELECT 'publish ' || id FROM publishes WHERE id IN ('pub2', 'pub4', 'pub5')`,
        ),
      ),
  },
} satisfies Partial<Record<CategoryId, Fixture>>;
