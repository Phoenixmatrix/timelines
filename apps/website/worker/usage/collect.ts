// Daily usage snapshots per account and construct (CORE-207), collected by
// the hourly cron, never on a request path. A collection walks the site
// ('' — data no account owns) and then every account, one small step at a
// time: a D1 table group, a page of CI logs, Durable Objects, R2, Artifacts,
// Vectorize, AI Search, then yesterday's AI and CI activity. It stops after a
// step or time budget and the next run carries on from its cursor
// (job_cursors 'usage:collect'), so a large account never times out the cron;
// each step's rows and the cursor are written in one batch, so a step counts
// once. Figures that aren't measured carry estimated = 1 and their method.

import { db, nowIso, type UsageConstruct } from "../schema.ts";
import { DURABLE_CLASS_NAMES } from "../durable/classes.ts";
import { EMBEDDING_DIMENSIONS } from "../knowledge/models.ts";
import { measureUnreachable, type Unreachable, type UnreachableRepo } from "../git/unreachable.ts";
import { instanceSize } from "./containers.ts";
import { MEASURED_TEXT, TABLE_GROUPS, type Database, type TableGroup } from "./tables.ts";

export const USAGE_LIMITS = {
  /** Steps per cron run, and wall time, whichever ends first. */
  steps: 400,
  ms: 20_000,
  /** CI jobs whose logs one step measures. */
  logJobs: 200,
  /** Rows sampled per table for the average row size. */
  sample: 100,
};

const CURSOR = "usage:collect";
/** The account id site-wide figures are filed under. */
export const SITE = "";
/** Knowledge graph node kinds that get a vector (worker/knowledge/indexes.ts). */
const EMBEDDED_KINDS = ["repository", "file", "symbol", "component", "concept"];
/** What an AI Search item is assumed to weigh when none of the account's are measured. */
const DEFAULT_ITEM_BYTES = 8 * 1024;

export interface UsageRow {
  construct: UsageConstruct;
  item: string;
  metric: string;
  kind: "storage" | "activity";
  quantity: number;
  estimated?: boolean;
  method: string;
  /** Activity describes the day before the collection. */
  day?: string;
}

interface StepContext {
  env: Env;
  account: string;
  /** The collection's UTC day (storage) and the day before (activity). */
  day: string;
  yesterday: string;
  limits: typeof USAGE_LIMITS;
}

interface StepResult {
  rows: UsageRow[];
  /** Another page of this step, or null when it's done. */
  next: string | null;
}

interface Step {
  id: string;
  run(ctx: StepContext, page: string | null): Promise<StepResult>;
}

interface Cursor {
  day: string;
  account: string;
  step: number;
  page: string | null;
  done: boolean;
}

function binding(env: Env, database: Database): D1Database {
  return database === "db" ? env.DB : env.REGISTRY_DB;
}

const columnCache = new Map<string, Promise<string[]>>();

async function columns(env: Env, database: Database, table: string): Promise<string[]> {
  const key = `${database}:${table}`;
  let cached = columnCache.get(key);
  if (!cached) {
    cached = binding(env, database)
      .prepare(`PRAGMA table_info("${table}")`)
      .all<{ name: string }>()
      .then(({ results }) => results.map((r) => r.name));
    columnCache.set(key, cached);
    cached.catch(() => columnCache.delete(key));
  }
  return cached;
}

const SAMPLED =
  "rows × the average payload of up to 100 sampled rows (stored column bytes; indexes and page overhead excluded)";

/** One table group: rows counted, bytes from a sample of each table's rows. */
function groupStep(group: TableGroup): Step {
  return {
    id: `d1:${group.database}:${group.id}`,
    async run(ctx) {
      const d1 = binding(ctx.env, group.database);
      let rows = 0;
      let bytes = 0;
      const statements: D1PreparedStatement[] = [];
      const tables = Object.entries(group.tables);
      for (const [table, owner] of tables) {
        const where = owner ? `WHERE ${owner}` : "";
        const params = owner ? [ctx.account] : [];
        const payload = (await columns(ctx.env, group.database, table))
          .map((c) => `COALESCE(length(CAST("${c}" AS BLOB)), 0)`)
          .join(" + ");
        statements.push(
          d1.prepare(`SELECT COUNT(*) AS n FROM "${table}" ${where}`).bind(...params),
          d1
            .prepare(
              `SELECT COALESCE(AVG(b), 0) AS avg FROM (SELECT ${payload || "0"} AS b FROM "${table}" ${where} LIMIT ${ctx.limits.sample})`,
            )
            .bind(...params),
        );
      }
      const results = await d1.batch<{ n?: number; avg?: number }>(statements);
      tables.forEach((_, i) => {
        const n = Number(results[2 * i]?.results[0]?.n ?? 0);
        const avg = Number(results[2 * i + 1]?.results[0]?.avg ?? 0);
        rows += n;
        bytes += n * avg;
      });
      if (rows === 0) return { rows: [], next: null };
      return {
        rows: [
          d1Row(group.id, "rows", rows, false, "COUNT(*) of the group's tables"),
          d1Row(group.id, "bytes", Math.round(bytes), true, SAMPLED),
        ],
        next: null,
      };
    },
  };
}

function d1Row(
  item: string,
  metric: string,
  quantity: number,
  estimated: boolean,
  method: string,
): UsageRow {
  return { construct: "d1", item, metric, kind: "storage", quantity, estimated, method };
}

/** CI logs: exact text bytes, a page of the account's jobs at a time. */
const ciLogs: Step = {
  id: "d1:db:ci-logs",
  async run(ctx, page) {
    const jobs = await db(ctx.env.DB)
      .selectFrom("ci_jobs as j")
      .innerJoin("repos as r", "r.id", "j.repo_id")
      .select("j.id")
      .where("r.owner_id", "=", ctx.account)
      .where("j.id", ">", page ?? "")
      .orderBy("j.id")
      .limit(ctx.limits.logJobs)
      .execute();
    if (jobs.length === 0) return { rows: [], next: null };
    const column = MEASURED_TEXT.ci_logs!;
    const totals = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST("${column}" AS BLOB))), 0) AS bytes
       FROM ci_logs WHERE job_id IN (${jobs.map(() => "?").join(",")})`,
    )
      .bind(...jobs.map((j) => j.id))
      .first<{ n: number; bytes: number }>();
    const next = jobs.length < ctx.limits.logJobs ? null : jobs.at(-1)!.id;
    const n = Number(totals?.n ?? 0);
    return {
      rows:
        n === 0
          ? []
          : [
              d1Row("ci-logs", "rows", n, false, "COUNT(*) of the account's log chunks"),
              d1Row(
                "ci-logs",
                "bytes",
                Number(totals?.bytes ?? 0),
                false,
                "exact UTF-8 bytes of the log text (row overhead excluded)",
              ),
            ],
      next,
    };
  },
};

/** Durable Objects by class, from the instance registry's reported sizes. */
const durableObjects: Step = {
  id: "durable_objects",
  async run(ctx) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT class, COUNT(*) AS n, COALESCE(SUM(storage_bytes), 0) AS bytes,
              SUM(storage_bytes IS NULL) AS unsized
       FROM do_instances
       WHERE ${ctx.account === SITE ? "account_id IS NULL" : "account_id = ?1"} AND purged_at IS NULL
       GROUP BY class`,
    )
      .bind(...(ctx.account === SITE ? [] : [ctx.account]))
      .all<{ class: string; n: number; bytes: number; unsized: number }>();
    return {
      rows: results
        .filter((r) => DURABLE_CLASS_NAMES.includes(r.class as never))
        .flatMap((r): UsageRow[] => [
          {
            construct: "durable_objects",
            item: r.class,
            metric: "instances",
            kind: "storage",
            quantity: Number(r.n),
            method: "live instances in the registry (do_instances)",
          },
          {
            construct: "durable_objects",
            item: r.class,
            metric: "bytes",
            kind: "storage",
            quantity: Number(r.bytes),
            estimated: Number(r.unsized) > 0,
            method:
              Number(r.unsized) > 0
                ? `sum of each instance's reported ctx.storage.sql.databaseSize; ${r.unsized} not yet sized count as 0`
                : "sum of each instance's reported ctx.storage.sql.databaseSize",
          },
        ]),
      next: null,
    };
  },
};

const FEED_DIGESTS = `
  WITH feeds AS (SELECT id FROM repositories WHERE owner_id = ?1),
  digests AS (
    SELECT digest FROM files WHERE repo_id IN (SELECT id FROM feeds)
    UNION SELECT digest FROM oci_blob_links WHERE repo_id IN (SELECT id FROM feeds)
    UNION SELECT digest FROM oci_manifests WHERE repo_id IN (SELECT id FROM feeds)
    UNION SELECT a.digest FROM release_assets a JOIN releases rl ON rl.id = a.release_id
      WHERE rl.repo_id IN (SELECT id FROM feeds)
    UNION SELECT digest FROM remote_entries
      WHERE repo_id IN (SELECT id FROM feeds) AND digest IS NOT NULL
  )`;

/** R2: registry blobs and derived files from catalog sizes; profile pictures by HEAD. */
const r2: Step = {
  id: "r2",
  async run(ctx) {
    const rows: UsageRow[] = [];
    const push = (item: string, objects: number, bytes: number, method: string) => {
      if (objects === 0) return;
      rows.push(
        { construct: "r2", item, metric: "objects", kind: "storage", quantity: objects, method },
        { construct: "r2", item, metric: "bytes", kind: "storage", quantity: bytes, method },
      );
    };
    if (ctx.account === SITE) {
      const all = await ctx.env.REGISTRY_DB.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs",
      ).first<{ n: number; bytes: number }>();
      push(
        "registry_blobs_all",
        Number(all?.n ?? 0),
        Number(all?.bytes ?? 0),
        "every blob in the registry catalog, once (the bucket's logical total; accounts' figures overlap where they share blobs)",
      );
      return { rows, next: null };
    }
    const [blobs, derived] = await ctx.env.REGISTRY_DB.batch<{ n: number; bytes: number }>([
      ctx.env.REGISTRY_DB.prepare(
        `${FEED_DIGESTS} SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE digest IN (SELECT digest FROM digests)`,
      ).bind(ctx.account),
      ctx.env.REGISTRY_DB.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM derived_files WHERE repo_id IN (SELECT id FROM repositories WHERE owner_id = ?1)",
      ).bind(ctx.account),
    ]);
    push(
      "registry_blobs",
      Number(blobs?.results[0]?.n ?? 0),
      Number(blobs?.results[0]?.bytes ?? 0),
      "catalog sizes of the distinct blobs the account's feeds reference (a blob shared with another account counts for both)",
    );
    push(
      "registry_derived",
      Number(derived?.results[0]?.n ?? 0),
      Number(derived?.results[0]?.bytes ?? 0),
      "catalog sizes of the feeds' generated index files",
    );
    const account = await db(ctx.env.DB)
      .selectFrom("accounts")
      .select("avatar_key")
      .where("id", "=", ctx.account)
      .executeTakeFirst();
    const avatars = Reflect.get(ctx.env, "AVATARS") as R2Bucket | undefined;
    if (account?.avatar_key && avatars) {
      const head = await avatars.head(account.avatar_key).catch(() => null);
      if (head) push("avatars", 1, head.size, "the profile picture's object size (HEAD)");
    }
    return { rows, next: null };
  },
};

/** Artifacts: no size API, so pack bytes pushed through the proxy. */
const artifacts: Step = {
  id: "artifacts",
  async run(ctx) {
    const row = await ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(pushed_bytes), 0) AS bytes FROM repos WHERE owner_id = ?1",
    )
      .bind(ctx.account)
      .first<{ n: number; bytes: number }>();
    const n = Number(row?.n ?? 0);
    if (n === 0) return { rows: [], next: null };
    return {
      rows: [
        {
          construct: "artifacts",
          item: "repositories",
          metric: "repositories",
          kind: "storage",
          quantity: n,
          method: "the account's repositories",
        },
        {
          construct: "artifacts",
          item: "repositories",
          metric: "bytes",
          kind: "storage",
          quantity: Number(row?.bytes ?? 0),
          estimated: true,
          method:
            "pack bytes pushed through Gitmatrix since 2026-10-04 (Artifacts reports no repository sizes): an upper bound for that history, nothing for earlier pushes",
        },
      ],
      next: null,
    };
  },
};

/**
 * Artifacts' unreachable data (CORE-202): per repository whose push log saw a
 * ref leave a commit, one fetch of what only those commits reach
 * (worker/git/unreachable.ts). A page per repository; Artifacts can't prune it.
 */
const artifactsUnreachable: Step = {
  id: "artifacts:unreachable",
  async run(ctx, page) {
    const repo = await ctx.env.DB.prepare(
      `SELECT r.id, r.artifacts_name, r.artifacts_remote FROM repos r
        WHERE r.owner_id = ?1 AND r.id > ?2 AND r.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM ref_updates u WHERE u.repo_id = r.id AND u.old_oid IS NOT NULL
                        AND (u.new_oid IS NULL OR u.forced = 1))
        ORDER BY r.id LIMIT 1`,
    )
      .bind(ctx.account, page ?? "")
      .first<UnreachableRepo>();
    if (!repo && page !== null) return { rows: [], next: null };
    // The first page writes the day's figure, zero when nothing left a ref
    // (and nothing when the account has no repositories).
    if (!repo) {
      const any = await ctx.env.DB.prepare("SELECT 1 AS n FROM repos WHERE owner_id = ?1 LIMIT 1")
        .bind(ctx.account)
        .first();
      if (!any) return { rows: [], next: null };
    }
    let found: Unreachable = { commits: 0, objects: 0, bytes: 0, truncated: false };
    if (repo)
      try {
        found = await measureUnreachable(ctx.env, repo);
      } catch (error) {
        // One repository's failure leaves it out of the figure, not the rest.
        console.error("Usage: measuring unreachable git data failed", repo.id, error);
      }
    const method = `packed bytes of the objects only commits that left a ref reach (deleted branches and bookmarks, force pushes), fetched from Artifacts with every ref as a have: Artifacts keeps them and can't prune them. Commits that left a ref before the push log began (2026-10-03) or whose push log entries were cleaned up aren't seen${found.truncated ? "; a lower bound (a pack was cut at 512 MiB or 15 s)" : ""}`;
    return {
      rows: [
        {
          construct: "artifacts",
          item: "repositories",
          metric: "unreachable_bytes",
          kind: "storage",
          quantity: found.bytes,
          estimated: true,
          method,
        },
        {
          construct: "artifacts",
          item: "repositories",
          metric: "unreachable_objects",
          kind: "storage",
          quantity: found.objects,
          estimated: true,
          method,
        },
      ],
      next: repo ? repo.id : null,
    };
  },
};

const OWNED_REPOS = "repo_id IN (SELECT id FROM repos WHERE owner_id = ?1)";

/** Vectorize: one vector per embedded graph node. */
const vectorize: Step = {
  id: "vectorize",
  async run(ctx) {
    const row = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM kg_nodes WHERE ${OWNED_REPOS}
         AND kind IN (${EMBEDDED_KINDS.map(() => "?").join(",")}) AND summary != ''`,
    )
      .bind(ctx.account, ...EMBEDDED_KINDS)
      .first<{ n: number }>();
    const vectors = Number(row?.n ?? 0);
    if (vectors === 0) return { rows: [], next: null };
    const method = `knowledge graph nodes that are embedded (kinds ${EMBEDDED_KINDS.join(", ")}, with a summary), assuming the index is in step with the graph`;
    return {
      rows: [
        {
          construct: "vectorize",
          item: "knowledge",
          metric: "vectors",
          kind: "storage",
          quantity: vectors,
          estimated: true,
          method,
        },
        {
          construct: "vectorize",
          item: "knowledge",
          metric: "dimensions",
          kind: "storage",
          quantity: vectors * EMBEDDING_DIMENSIONS,
          estimated: true,
          method: `${method}, × ${EMBEDDING_DIMENSIONS} dimensions`,
        },
      ],
      next: null,
    };
  },
};

/** AI Search: the items the account's repositories indexed, and their uploaded sizes. */
const aiSearch: Step = {
  id: "ai_search",
  async run(ctx) {
    const row = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS n, COUNT(bytes) AS known, COALESCE(SUM(bytes), 0) AS bytes
       FROM kg_search_items WHERE ${OWNED_REPOS}`,
    )
      .bind(ctx.account)
      .first<{ n: number; known: number; bytes: number }>();
    const n = Number(row?.n ?? 0);
    if (n === 0) return { rows: [], next: null };
    const known = Number(row?.known ?? 0);
    const measured = Number(row?.bytes ?? 0);
    const unknown = n - known;
    const average = known > 0 ? measured / known : DEFAULT_ITEM_BYTES;
    return {
      rows: [
        {
          construct: "ai_search",
          item: "knowledge",
          metric: "items",
          kind: "storage",
          quantity: n,
          method: "indexed items (kg_search_items)",
        },
        {
          construct: "ai_search",
          item: "knowledge",
          metric: "bytes",
          kind: "storage",
          quantity: Math.round(measured + unknown * average),
          estimated: unknown > 0,
          method:
            unknown > 0
              ? `uploaded sizes; ${unknown} items uploaded before sizes were recorded count at ${known > 0 ? "the measured items' average" : `${DEFAULT_ITEM_BYTES} bytes`}`
              : "uploaded sizes of the indexed items",
        },
      ],
      next: null,
    };
  },
};

/** Yesterday's Workers AI calls and tokens, by model. */
const workersAi: Step = {
  id: "workers_ai",
  async run(ctx) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT model, SUM(calls) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(total_tokens) AS total, SUM(failed_calls) AS failed
       FROM ai_usage WHERE day = ?1 AND account_id = ?2 GROUP BY model`,
    )
      .bind(ctx.yesterday, ctx.account)
      .all<{
        model: string;
        calls: number;
        input: number;
        output: number;
        total: number;
        failed: number;
      }>();
    const method = "calls and tokens recorded as each model call returned (ai_usage)";
    return {
      rows: results.flatMap((r) =>
        (
          [
            ["calls", r.calls],
            ["input_tokens", r.input],
            ["output_tokens", r.output],
            ["total_tokens", r.total],
            // Attempts that failed or were cut off (CORE-285), when there were any.
            ...(r.failed ? ([["failed_calls", r.failed]] as const) : []),
          ] as const
        ).map(([metric, quantity]): UsageRow => ({
          construct: "workers_ai",
          item: r.model,
          metric,
          kind: "activity",
          quantity: Number(quantity ?? 0),
          method,
          day: ctx.yesterday,
        })),
      ),
      next: null,
    };
  },
};

/**
 * Yesterday's CI: sandbox jobs, their container minutes, and what those
 * minutes provision by each job's instance type (worker/usage/containers.ts),
 * in the units Cloudflare bills Containers in.
 */
const ci: Step = {
  id: "ci",
  async run(ctx) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT json_extract(j.spec, '$.instance') AS instance, COUNT(*) AS jobs,
              COALESCE(SUM((julianday(j.finished_at) - julianday(j.started_at)) * 86400), 0) AS seconds
       FROM ci_jobs j JOIN repos r ON r.id = j.repo_id
       WHERE r.owner_id = ?1 AND j.runner = 'sandbox' AND j.started_at IS NOT NULL
         AND j.finished_at >= ?2 AND j.finished_at < ?3
       GROUP BY 1`,
    )
      .bind(ctx.account, ctx.yesterday, ctx.day)
      .all<{ instance: string | null; jobs: number; seconds: number }>();
    const jobs = results.reduce((sum, r) => sum + Number(r.jobs), 0);
    if (jobs === 0) return { rows: [], next: null };
    let seconds = 0;
    let vcpu = 0;
    let memory = 0;
    let disk = 0;
    for (const r of results) {
      const s = Math.max(0, Number(r.seconds));
      const size = instanceSize(r.instance);
      seconds += s;
      vcpu += s * size.vcpu;
      memory += s * size.memoryGib;
      disk += s * size.diskGb;
    }
    const method = "sandbox jobs that finished that day, from their start and finish times";
    const provisioned =
      "each job's wall time × its instance type's provisioned size (the container runs a little longer than the job's steps)";
    const row = (metric: string, quantity: number, how: string, estimated = false) => ({
      construct: "ci" as const,
      item: "sandbox",
      metric,
      kind: "activity" as const,
      quantity,
      method: how,
      day: ctx.yesterday,
      estimated,
    });
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      rows: [
        row("jobs", jobs, method),
        row("minutes", round(seconds / 60), method),
        row(
          "vcpu_seconds",
          round(vcpu),
          `${provisioned}; Cloudflare bills only active CPU, so this is an upper bound`,
          true,
        ),
        row("memory_gib_seconds", round(memory), provisioned, true),
        row("disk_gb_seconds", round(disk), provisioned, true),
      ],
      next: null,
    };
  },
};

/** The steps for the site, or for an account. */
export function stepsFor(account: string): Step[] {
  const scope = account === SITE ? "site" : "account";
  const groups = TABLE_GROUPS.filter((g) => g.scope === scope).map((g) =>
    g.id === "ci-logs" ? ciLogs : groupStep(g),
  );
  return account === SITE
    ? [...groups, durableObjects, r2, workersAi]
    : [
        ...groups,
        durableObjects,
        r2,
        artifacts,
        artifactsUnreachable,
        vectorize,
        aiSearch,
        workersAi,
        ci,
      ];
}

async function loadCursor(env: Env): Promise<Cursor | null> {
  const row = await db(env.DB)
    .selectFrom("job_cursors")
    .select("cursor")
    .where("name", "=", CURSOR)
    .executeTakeFirst();
  return row ? (JSON.parse(row.cursor) as Cursor) : null;
}

function saveCursor(env: Env, cursor: Cursor): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO job_cursors (name, cursor, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
  ).bind(CURSOR, JSON.stringify(cursor), nowIso());
}

/** A step's rows: the first page replaces the day's figure, later pages add to it. */
function writeRow(
  env: Env,
  cursor: Cursor,
  row: UsageRow,
  add: boolean,
  at: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO usage_snapshots (day, account_id, construct, item, metric, kind, quantity, estimated, method, collected_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (day, account_id, construct, item, metric) DO UPDATE SET
       quantity = ${add ? "usage_snapshots.quantity + excluded.quantity" : "excluded.quantity"},
       estimated = ${add ? "MAX(usage_snapshots.estimated, excluded.estimated)" : "excluded.estimated"},
       kind = excluded.kind, method = excluded.method, collected_at = excluded.collected_at`,
  ).bind(
    row.day ?? cursor.day,
    cursor.account,
    row.construct,
    row.item,
    row.metric,
    row.kind,
    row.quantity,
    row.estimated ? 1 : 0,
    row.method,
    at,
  );
}

async function nextAccount(env: Env, after: string): Promise<string | null> {
  const row = await db(env.DB)
    .selectFrom("accounts")
    .select("id")
    .where("id", ">", after)
    .orderBy("id")
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

export interface UsageCollection {
  day: string;
  steps: number;
  failed: number;
  done: boolean;
}

/**
 * Carry today's collection on from its cursor, within the limits. Returns
 * whether the day is done.
 */
export async function collectUsage(
  env: Env,
  now = new Date(),
  limits = USAGE_LIMITS,
): Promise<UsageCollection> {
  const started = Date.now();
  const day = now.toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const saved = await loadCursor(env);
  let cursor: Cursor =
    saved && saved.day === day ? saved : { day, account: SITE, step: 0, page: null, done: false };
  let steps = 0;
  let failed = 0;
  while (!cursor.done && steps < limits.steps && Date.now() - started < limits.ms) {
    const plan = stepsFor(cursor.account);
    const step = plan[cursor.step];
    let next: Cursor;
    let statements: D1PreparedStatement[] = [];
    if (!step) {
      const account = await nextAccount(env, cursor.account);
      next = account
        ? { day, account, step: 0, page: null, done: false }
        : { ...cursor, done: true };
    } else {
      steps++;
      const at = nowIso();
      try {
        const result = await step.run(
          { env, account: cursor.account, day, yesterday, limits },
          cursor.page,
        );
        statements = result.rows.map((row) => writeRow(env, cursor, row, cursor.page !== null, at));
        next = result.next
          ? { ...cursor, page: result.next }
          : { ...cursor, step: cursor.step + 1, page: null };
      } catch (error) {
        // One failing step mustn't stall the day: note it and move on.
        failed++;
        console.error("Usage: a collection step failed", step.id, cursor.account, error);
        next = { ...cursor, step: cursor.step + 1, page: null };
      }
    }
    await env.DB.batch([...statements, saveCursor(env, next)]);
    cursor = next;
  }
  return { day, steps, failed, done: cursor.done };
}
