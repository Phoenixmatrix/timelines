import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";

// Deploy what changed on main since the deployed Worker versions, from CI.
//
// Every deploy tags its Worker version with the commit it was built from
// (`workers/tag`); the next run diffs from that commit. Migrations apply
// before the Worker deploys. The CI image can't be rebuilt here (a Sandbox
// has no Docker), so the deploy reuses the deployed version's image and a
// changed ci/Dockerfile fails the job after everything else has shipped.
//
// The public site (apps/site, CORE-115) is a Worker of its own, assets only,
// on timelines.fward.dev: it deploys the same way, from its own tag.
//
// Each Worker that actually deploys is then recorded as a deployment of this
// repository (CORE-351), as the job, with what ran: the provider version and
// deployment `cf workers deployments list` reports, only once its `workers/tag`
// is the deployed commit. Recording starts once both Workers have deployed and
// has {@link RECORD_BUDGET_MS} in all; the Workers are live by then, so a
// record that fails or runs out of time only warns.

const WORKER = "gitmatrix";
const root = resolve(import.meta.dirname, "../..");
const website = join(root, "apps/website");
/** The website's own cf: pinned, patched, and not on PATH in CI. */
const cf = join(website, "node_modules/.bin/cf");
const SITE_WORKER = "gitmatrix-site";
const site = join(root, "apps/site");
/**
 * Where each Worker answers in production: `PRODUCTION.host` in
 * apps/website/vite/instance.ts and `PRODUCTION_HOST` in
 * apps/site/cloudflare.config.ts (deploy.test.ts keeps them in step).
 */
export const PRODUCTION_URLS: Record<string, string> = {
  [WORKER]: "https://timelinesapp.fward.dev",
  [SITE_WORKER]: "https://timelines.fward.dev",
};

/** Migration directories (relative to apps/website) and the D1 binding they target. */
const MIGRATIONS = [
  { prefix: "apps/website/migrations/", dir: "migrations", binding: "DB" },
  {
    prefix: "apps/website/registry/migrations/",
    dir: "registry/migrations",
    binding: "REGISTRY_DB",
  },
] as const;

/** Tenant ownership transformation is an operator protocol, never a migration
 * that runs while the preceding Worker still admits legacy business writes. */
export function assertOrdinaryOwnershipMigration(filename: string, source: string): void {
  if (filename < "20261011171726") return;
  const sql = source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "");
  const ownership =
    "(?:accounts|org_members|repos|repositories|organizations|spaces|organization_members|space_grants|account_settings|ai_providers)";
  const destructive = new RegExp(
    `\\b(?:DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?[\\"\`\\[]?${ownership}\\b|ALTER\\s+TABLE\\s+[\\"\`\\[]?${ownership}\\b[^;]*\\b(?:RENAME|DROP)\\b)`,
    "i",
  );
  if (destructive.test(sql))
    throw new Error(
      `${filename}: ownership rename/drop requires the approved fenced operator cutover, not ordinary deploy`,
    );
  // Additive preparation may define integrity triggers on the new directory,
  // but must never backfill live ownership as a side effect of ordinary deploy.
  const statements = sql.replace(/CREATE\s+TRIGGER\b[\s\S]*?\bEND\s*;/gi, "");
  const mutation = new RegExp(
    `\\b(?:UPDATE\\s+|DELETE\\s+FROM\\s+|INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+)[\\"\`\\[]?${ownership}\\b`,
    "i",
  );
  if (mutation.test(statements))
    throw new Error(
      `${filename}: ownership data import requires an exact approved manifest and independent fence`,
    );
}

export interface Plan {
  /** The Worker's code, assets or dependencies changed. */
  worker: boolean;
  /** The CI image's build context changed. */
  image: boolean;
  /** Migration directories with new or changed files. */
  migrations: (typeof MIGRATIONS)[number][];
}

/** Changes that never reach the deployed Worker. */
function inert(path: string): boolean {
  return (
    /\.(md|test\.tsx?)$/.test(path) ||
    path.startsWith("apps/website/.impeccable/") ||
    path.startsWith("apps/website/seed/") ||
    path.startsWith("apps/website/scripts/")
  );
}

/** What a set of changed paths (relative to the repository root) needs deployed. */
export function plan(changed: string[]): Plan {
  const migrations = MIGRATIONS.filter((m) => changed.some((path) => path.startsWith(m.prefix)));
  const preparesCutover = changed.some((path) =>
    /(?:organization_space_prepare|space_ownership_prepare)\.sql$/.test(path),
  );
  const image = changed.some((path) => path.startsWith("apps/website/ci/"));
  const worker =
    preparesCutover ||
    changed.some(
      (path) =>
        !inert(path) &&
        !path.startsWith("apps/website/ci/") &&
        !MIGRATIONS.some((m) => path.startsWith(m.prefix)) &&
        (path.startsWith("apps/website/") || path.startsWith("packages/") || shared(path)),
    );
  return { worker, image, migrations };
}

/** Shared inputs: a change here can change any Worker's build. */
function shared(path: string): boolean {
  return (
    path.startsWith("patches/") ||
    ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(path)
  );
}

/** Whether changed paths reach the public site: its sources (docs included) or shared inputs. */
export function sitePlan(changed: string[]): boolean {
  return changed.some(
    (path) =>
      (path.startsWith("apps/site/") &&
        !/\.test\.tsx?$/.test(path) &&
        path !== "apps/site/README.md") ||
      shared(path),
  );
}

function run(command: string, args: string[], cwd = root, env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

/** Run with output streamed into the job log. */
function stream(command: string, args: string[], cwd = root, env?: NodeJS.ProcessEnv): void {
  execFileSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
}

interface Deployed {
  tag: string | null;
  /** The version serving most traffic. */
  versionId: string;
  image: string;
  databases: Record<string, string>;
}

/** The version serving traffic: its commit tag, CI image and D1 ids. */
function deployed(): Deployed {
  const { deployments } = JSON.parse(
    run(cf, ["workers", "deployments", "list", "--worker", WORKER], website),
  ) as { deployments: { versions: { version_id: string; percentage: number }[] }[] };
  const current = deployments[0]?.versions.toSorted((a, b) => b.percentage - a.percentage)[0];
  if (!current) throw new Error(`${WORKER} has no deployment to compare with.`);
  const version = JSON.parse(
    run(cf, ["workers", "versions", "get", current.version_id, "--worker-id", WORKER], website),
  ) as {
    annotations?: Record<string, string>;
    bindings: { type: string; name: string; id?: string }[];
    containers?: { images: Record<string, string> }[];
  };
  const image = version.containers?.[0]?.images.default;
  if (!image) throw new Error(`Deployed version ${current.version_id} has no CI image.`);
  const tag = version.annotations?.["workers/tag"] ?? null;
  return {
    tag,
    versionId: current.version_id,
    image,
    databases: Object.fromEntries(
      version.bindings.filter((b) => b.type === "d1" && b.id).map((b) => [b.name, b.id!]),
    ),
  };
}

function knownCommit(sha: string | null): sha is string {
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return false;
  try {
    run("git", ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** `--plan` prints what would deploy and changes nothing, from any checkout. */
async function deploy(planOnly: boolean): Promise<void> {
  if (!planOnly && process.env.GITMATRIX_BRANCH !== "main") {
    console.log(JSON.stringify({ event: "deploy.skipped", reason: "not-main" }));
    return;
  }
  // CI's checkout is shallow (the last 50 commits), and the deployed commit is
  // almost always among them; if it isn't, knownCommit fails and everything deploys.
  const head = run("git", ["rev-parse", "HEAD"]);
  const workers: WorkerDeploy[] = [
    { worker: WORKER, cwd: website, deploy: () => deployWebsite(head, planOnly) },
    { worker: SITE_WORKER, cwd: site, deploy: () => deploySite(head, planOnly) },
  ];
  if (planOnly) {
    for (const worker of workers) worker.deploy();
    return;
  }
  let recorder: LiveRecorder | undefined;
  try {
    await deployAndRecord(workers, head, (signal) => (recorder = liveRecorder(signal)));
  } finally {
    await recorder?.close();
  }
}

/** How long recording may take in all, after both deploys, within the job's budget. */
export const RECORD_BUDGET_MS = 3 * 60_000;
/** How long one cf read or gm call may take while recording. */
const RECORD_CALL_MS = 60_000;

/** One Worker's deploy: whether a new version went out, and the one that served before. */
export interface WorkerDeploy {
  worker: string;
  cwd: string;
  deploy(): { deployed: boolean; previous: string | null };
}

/** What recording needs: cf's reads, gm, a clock and a log. */
export interface Recorder {
  /** `cf workers deployments list` for a Worker, parsed. */
  deployments(worker: string, cwd: string): WorkerDeployments;
  /** The version's `workers/tag` annotation: the commit it was built from. */
  versionTag(worker: string, versionId: string, cwd: string): string | null;
  /** `gm` with these arguments, as the CI job. */
  gm(args: string[]): Promise<string>;
  now(): string;
  log(event: Record<string, unknown>): void;
}

export interface WorkerDeployments {
  deployments: {
    id?: string;
    created_on?: string;
    versions: { version_id: string; percentage: number }[];
  }[];
}

/**
 * Deploy every Worker in turn, then record each one that actually deployed,
 * so recording can never hold up a deploy. A deploy that fails stops the
 * rest, as before, after recording what did go out, and is then rethrown.
 * Recording has `budgetMs` in all: past it, the recorder's signal aborts and
 * each Worker not yet recorded is logged as skipped. Never fails on its own.
 */
export async function deployAndRecord(
  workers: WorkerDeploy[],
  head: string,
  recorderFor: (signal: AbortSignal) => Recorder,
  budgetMs = RECORD_BUDGET_MS,
): Promise<void> {
  const done: (WorkerDeploy & { previous: string | null })[] = [];
  let failure: unknown;
  for (const worker of workers) {
    try {
      const { deployed, previous } = worker.deploy();
      if (deployed) done.push({ ...worker, previous });
    } catch (error) {
      failure = error;
      break;
    }
  }
  if (done.length) {
    const controller = new AbortController();
    const live = recorderFor(controller.signal);
    // Past the budget each unrecorded Worker is reported once, here; what the
    // abandoned attempt logs after that is dropped.
    const recorder: Recorder = {
      ...live,
      log: (event) => {
        if (!controller.signal.aborted) live.log(event);
      },
    };
    const settled = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    const outOfTime = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), budgetMs);
    });
    const recording = (async () => {
      for (const worker of done) {
        if (controller.signal.aborted) return;
        await recordDeployed(recorder, { ...worker, head });
        settled.add(worker.worker);
      }
    })();
    try {
      if ((await Promise.race([recording, outOfTime])) === "timeout") {
        controller.abort(new Error(`recording took longer than ${budgetMs / 1000}s`));
        for (const worker of done)
          if (!settled.has(worker.worker))
            live.log({
              event: "deploy.record.skipped",
              worker: worker.worker,
              head,
              reason: `recording ran out of its ${budgetMs / 1000}s; the deploy stands`,
            });
      }
    } finally {
      clearTimeout(timer);
    }
  }
  if (failure !== undefined) throw failure;
}

/**
 * Record a Worker's new production deployment: its active version (most
 * traffic) in the newest provider deployment, only when that version's tag is
 * the deployed commit; the version that served before as `--replaces` when it
 * differs. Never throws: the Worker is already live.
 */
export async function recordDeployed(
  recorder: Recorder,
  target: { worker: string; cwd: string; head: string; previous: string | null },
): Promise<boolean> {
  const { worker, cwd, head, previous } = target;
  const warn = (reason: string, extra: Record<string, unknown> = {}) => {
    recorder.log({ event: "deploy.record.skipped", worker, head, reason, ...extra });
    return false;
  };
  const url = PRODUCTION_URLS[worker];
  if (!url) return warn("no production URL is known for it");
  try {
    const newest = recorder.deployments(worker, cwd).deployments[0];
    const active = newest?.versions.toSorted((a, b) => b.percentage - a.percentage)[0];
    if (!newest?.id || !active) return warn("cf lists no deployment with an id and a version");
    const tag = recorder.versionTag(worker, active.version_id, cwd);
    if (tag !== head)
      return warn("the active version wasn't built from the deployed commit", {
        version: active.version_id,
        tag,
      });
    const created = newest.created_on ? Date.parse(newest.created_on) : Number.NaN;
    const at = Number.isNaN(created) ? recorder.now() : new Date(created).toISOString();
    const args = [
      "deploy",
      "record",
      "--url",
      url,
      "--environment",
      "production",
      "--commit",
      head,
      "--service",
      worker,
      "--provider-version",
      active.version_id,
      "--provider-deployment",
      newest.id,
      "--percentage",
      String(active.percentage),
      "--deployed-at",
      at,
      "--exposed-from",
      at,
      ...(previous && previous !== active.version_id ? ["--replaces", previous] : []),
    ];
    const output = await recorder.gm(args);
    const id = /"id"\s*:\s*(\d+)/.exec(output)?.[1];
    recorder.log({
      event: "deploy.recorded",
      worker,
      version: active.version_id,
      deployment: id ? Number(id) : null,
    });
    return true;
  } catch (error) {
    return warn("recording failed; the deploy stands", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** What {@link liveRecorder} runs; tests replace it. */
export interface RecorderDeps {
  env: NodeJS.ProcessEnv;
  /** cf's stdout, synchronously, within `timeout`. */
  cf(args: string[], cwd: string, timeout: number): string;
  /** A directory for gm, made on first use. */
  tempDir(): Promise<string>;
  removeDir(path: string): Promise<void>;
  /** gm's binary, installed into `directory`: loaded only when first needed. */
  install(env: NodeJS.ProcessEnv, directory: string): Promise<string>;
  /** A binary's stdout. */
  exec(
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; signal: AbortSignal; timeout: number },
  ): Promise<string>;
}

export interface LiveRecorder extends Recorder {
  /** Remove gm's directory, if one was made. */
  close(): Promise<void>;
}

const liveDeps: RecorderDeps = {
  env: process.env,
  cf: (args, cwd, timeout) =>
    execFileSync(cf, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      timeout,
    }).trim(),
  tempDir: () => mkdtemp(join(tmpdir(), "gitmatrix-deploy-")),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
  // Loaded lazily, so neither its import nor the install can fail a deploy.
  install: async (env, directory) =>
    (await import("../preview/preview.ts")).installGm(env, directory),
  exec: async (file, args, options) =>
    (await promisify(execFile)(file, args, { ...options, maxBuffer: 16 * 1024 * 1024 })).stdout,
};

/**
 * The job's cf and gm for {@link recordDeployed}. gm is installed once, on
 * first use (lazily loaded, into a directory made then), and runs as the job
 * (GITMATRIX_TOKEN) without Cloudflare's credentials. Once `signal` aborts,
 * nothing more starts and a running gm is stopped.
 */
export function liveRecorder(
  signal: AbortSignal,
  overrides: Partial<RecorderDeps> = {},
): LiveRecorder {
  const deps = { ...liveDeps, ...overrides };
  const env = { ...deps.env };
  delete env.CLOUDFLARE_API_TOKEN;
  let directory: string | undefined;
  let gm: Promise<string> | undefined;
  const cfJson = <T>(args: string[], cwd: string): T => {
    signal.throwIfAborted();
    return JSON.parse(deps.cf(args, cwd, RECORD_CALL_MS)) as T;
  };
  return {
    deployments: (worker, cwd) =>
      cfJson(["workers", "deployments", "list", "--worker", worker], cwd),
    versionTag: (worker, versionId, cwd) =>
      cfJson<{ annotations?: Record<string, string> }>(
        ["workers", "versions", "get", versionId, "--worker-id", worker],
        cwd,
      ).annotations?.["workers/tag"] ?? null,
    gm: async (args) => {
      signal.throwIfAborted();
      gm ??= (async () => {
        directory = await deps.tempDir();
        return deps.install(deps.env, directory);
      })();
      const binary = await gm;
      signal.throwIfAborted();
      return deps.exec(binary, args, { env, signal, timeout: RECORD_CALL_MS });
    },
    now: () => new Date().toISOString(),
    // A warning in the job's log, never a failure.
    log: (event) =>
      (String(event.event).endsWith("skipped") ? console.warn : console.log)(JSON.stringify(event)),
    close: async () => {
      if (directory) await deps.removeDir(directory);
    },
  };
}

/** The site's live version and the commit it was built from; null when it has never deployed. */
function siteCurrent(): { tag: string | null; versionId: string } | null {
  let listed: string;
  try {
    listed = execFileSync(cf, ["workers", "deployments", "list", "--worker", SITE_WORKER], {
      cwd: site,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output = String((error as { stdout?: string; stderr?: string }).stderr ?? "");
    if (/does not exist|\[10007\]/.test(output)) return null;
    throw error;
  }
  const { deployments } = JSON.parse(listed) as {
    deployments: { versions: { version_id: string; percentage: number }[] }[];
  };
  const current = deployments[0]?.versions.toSorted((a, b) => b.percentage - a.percentage)[0];
  if (!current) return null;
  const version = JSON.parse(
    run(cf, ["workers", "versions", "get", current.version_id, "--worker-id", SITE_WORKER], site),
  ) as { annotations?: Record<string, string> };
  return { tag: version.annotations?.["workers/tag"] ?? null, versionId: current.version_id };
}

/** Build the site and deploy its assets-only Worker when anything it's built from changed. */
function deploySite(
  head: string,
  planOnly: boolean,
): { deployed: boolean; previous: string | null } {
  const current = siteCurrent();
  const tag = current?.tag ?? null;
  const previous = current?.versionId ?? null;
  if (tag === head) {
    console.log(JSON.stringify({ event: "deploy.site.skipped", reason: "already-deployed", head }));
    return { deployed: false, previous };
  }
  const base = knownCommit(tag) ? tag : null;
  const todo = base
    ? sitePlan(run("git", ["diff", "--name-only", base, head]).split("\n").filter(Boolean))
    : true;
  console.log(JSON.stringify({ event: "deploy.site.plan", base, head, site: todo }));
  if (planOnly || !todo) return { deployed: false, previous };
  stream("vp", ["run", "--no-cache", "site#build"]);
  const subject = run("git", ["log", "-1", "--format=%s", head]);
  stream(
    join(site, "node_modules/.bin/cf"),
    ["deploy", "--prebuilt", "--tag", head, "--message", subject.slice(0, 100)],
    site,
  );
  console.log(JSON.stringify({ event: "deploy.site", head }));
  return { deployed: true, previous };
}

function deployWebsite(
  head: string,
  planOnly: boolean,
): { deployed: boolean; previous: string | null } {
  const current = deployed();
  const previous = current.versionId;
  if (current.tag === head) {
    console.log(JSON.stringify({ event: "deploy.skipped", reason: "already-deployed", head }));
    return { deployed: false, previous };
  }
  // Without a known base, ship everything but the image, which only a Docker host can build.
  const base = knownCommit(current.tag) ? current.tag : null;
  const todo = base
    ? plan(run("git", ["diff", "--name-only", base, head]).split("\n").filter(Boolean))
    : { worker: true, image: false, migrations: [...MIGRATIONS] };
  console.log(
    JSON.stringify({
      event: "deploy.plan",
      base,
      head,
      worker: todo.worker,
      image: todo.image,
      migrations: todo.migrations.map((m) => m.dir),
    }),
  );

  // Validate ALL prospective ownership migrations before applying either D1.
  // Preparation remains additive; mapping/import runs only through the journal
  // after this tagged fence-aware Worker and every consumer are deployed/drained.
  for (const migration of todo.migrations) {
    for (const filename of readdirSync(join(website, migration.dir)).filter((name) =>
      name.endsWith(".sql"),
    )) {
      assertOrdinaryOwnershipMigration(
        filename,
        readFileSync(join(website, migration.dir, filename), "utf8"),
      );
    }
  }
  if (planOnly) return { deployed: false, previous };

  for (const migration of todo.migrations) {
    const id = current.databases[migration.binding];
    if (!id) throw new Error(`The deployed Worker has no ${migration.binding} binding.`);
    stream(cf, ["d1", "migrations", "apply", id, "--dir", migration.dir], website);
  }
  if (todo.worker) {
    const subject = run("git", ["log", "-1", "--format=%s", head]);
    stream(
      cf,
      ["deploy", "--tag", head, "--message", subject.slice(0, 100), "--containers-rollout", "none"],
      website,
      { GITMATRIX_CI_IMAGE: current.image, GITMATRIX_CUTOVER_CHECKPOINT: head },
    );
    console.log(JSON.stringify({ event: "deploy.worker", head }));
  }
  if (todo.image) {
    console.error(
      "apps/website/ci/ changed, and CI can't build the CI image (no Docker in a Sandbox). " +
        "Everything else is deployed; deploy the image from a machine with Docker: " +
        "`vp run deploy` in apps/website.",
    );
    process.exitCode = 1;
  }
  return { deployed: todo.worker, previous };
}

if (import.meta.main) {
  try {
    await deploy(process.argv.includes("--plan"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
