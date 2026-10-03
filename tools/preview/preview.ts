// Gitmatrix's own timeline previews (CORE-80): the reference implementation of
// the preview contract (apps/website/README.md, "Gitmatrix's own previews").
// .gitmatrix/ci.yml runs `create` in preview runs at each checkpoint (and on
// revival), and `teardown` when the previews expire. It uses only what any
// project has: the job's variables and credential, `cf`, and `gm deploy record`.
//
//   create    fresh D1s (migrations, then seed/), an R2 bucket and an Artifacts
//             namespace for the timeline; `cf previews deploy timeline-<slug>`
//             in preview mode (cloudflare.config.ts); the agent fixtures,
//             seeded through the preview's own API; then `gm deploy record`.
//   teardown  delete the Preview and every resource create made.
//
// Names derive from the timeline's slug alone, so a create after a teardown, a
// revival or a retry finds and replaces what an earlier one left. Each create
// starts with a teardown: a preview shows a checkpoint's code on migrations
// plus seed, never data (D1, R2, Artifacts or the Preview's own Durable
// Objects) carried over from an earlier checkpoint.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  previewKey,
  previewVariables,
  type PreviewResources,
} from "../../apps/website/vite/preview.ts";
import { seedFixtures } from "../agent/seed.ts";

/** The Worker the previews belong to. */
export const WORKER = "gitmatrix";
const root = resolve(import.meta.dirname, "../..");
const website = join(root, "apps/website");
/** The website's own cf: pinned, patched, and not on PATH in CI (as tools/agent/deploy.ts). */
const CF = join(website, "node_modules/.bin/cf");
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Everything one timeline's preview is made of. */
export interface Names {
  /** The Worker Preview: `timeline-<slug>`. */
  preview: string;
  db: string;
  registryDb: string;
  bucket: string;
  artifacts: string;
}

/**
 * `prefix + slug`, or, when that is longer than `max`, the slug shortened and
 * followed by a hash of the whole slug, so every slug keeps its own name.
 */
export function bounded(prefix: string, slug: string, max: number): string {
  const whole = `${prefix}${slug}`;
  if (whole.length <= max) return whole;
  const hash = createHash("sha256").update(slug).digest("hex").slice(0, 8);
  const room = max - prefix.length - hash.length - 1;
  return `${prefix}${slug.slice(0, room).replace(/-+$/, "")}-${hash}`;
}

/** The resources of a timeline's preview, from its slug. */
export function names(slug: string): Names {
  if (!SLUG.test(slug) || slug.length > 64)
    throw new Error(`"${slug}" isn't a timeline slug (lowercase letters and digits, hyphens).`);
  // R2 buckets allow 63 characters; a Preview's name becomes part of a host
  // name (<preview>-gitmatrix.<subdomain>.workers.dev), whose labels allow 63.
  const own = bounded("gitmatrix-preview-", slug, 63);
  return {
    preview: bounded("timeline-", slug, 63 - WORKER.length - 1),
    db: own,
    registryDb: bounded("gitmatrix-preview-registry-", slug, 63),
    bucket: own,
    artifacts: own,
  };
}

/** How the script reaches Cloudflare, injected so tests can stand in for it. */
export interface Cloudflare {
  /** Run `cf` in apps/website and return its stdout; rejects with its stderr. */
  cf(args: string[], env?: Record<string, string>): Promise<string>;
  /** A Cloudflare API request, for what `cf` has no command for. */
  api(method: string, path: string): Promise<{ status: number; body: unknown }>;
}

/** Only an explicit "not there" is idempotent; permission and network errors fail. */
export function absent(error: unknown): boolean {
  return /\b404\b|not found|does not exist|no such|10025|10007/i.test(String(error));
}

async function ignoringAbsent(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

function json<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** A D1 database's id by its exact name, or null. */
export async function findDatabase(cloudflare: Cloudflare, name: string): Promise<string | null> {
  const found = json<{ uuid: string; name: string }[]>(
    await cloudflare.cf(["d1", "list", "--name", name, "--per-page", "100"]),
  );
  return found.find((database) => database.name === name)?.uuid ?? null;
}

async function deleteDatabase(cloudflare: Cloudflare, name: string): Promise<void> {
  const id = await findDatabase(cloudflare, name);
  if (id) await ignoringAbsent(cloudflare.cf(["d1", "delete", id, "--force"]));
}

async function createDatabase(cloudflare: Cloudflare, name: string): Promise<string> {
  const created = json<{ uuid?: string }>(await cloudflare.cf(["d1", "create", "--name", name]));
  if (!created.uuid) throw new Error(`cf d1 create returned no id for ${name}.`);
  return created.uuid;
}

/** Empty a bucket page by page (deleting what each listing shows), then delete it. */
async function deleteBucket(cloudflare: Cloudflare, name: string): Promise<void> {
  for (;;) {
    let listed: unknown;
    try {
      listed = json(
        await cloudflare.cf(["r2", "objects", "list", "--bucket-name", name, "--per-page", "1000"]),
      );
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    const objects = (
      Array.isArray(listed) ? listed : ((listed as { objects?: unknown[] }).objects ?? [])
    ) as { key: string }[];
    if (!objects.length) break;
    await cloudflare.cf([
      "r2",
      "objects",
      "bulk-delete",
      "--bucket-name",
      name,
      "--body",
      JSON.stringify(objects.map((object) => object.key)),
      "--force",
    ]);
  }
  await ignoringAbsent(cloudflare.cf(["r2", "buckets", "delete", name, "--force"]));
}

/** Delete a namespace's repositories, then the namespace (as tools/agent/environment.ts). */
async function deleteNamespace(cloudflare: Cloudflare, name: string): Promise<void> {
  for (;;) {
    let repos: { name: string }[];
    try {
      repos = json(
        await cloudflare.cf([
          "artifacts",
          "namespaces",
          "repos",
          "list",
          "--namespace",
          name,
          "--limit",
          "100",
        ]),
      );
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    if (!repos.length) break;
    for (const repo of repos)
      await ignoringAbsent(
        cloudflare.cf([
          "artifacts",
          "namespaces",
          "repos",
          "delete",
          repo.name,
          "--namespace",
          name,
          "--force",
        ]),
      );
  }
  await ignoringAbsent(cloudflare.cf(["artifacts", "namespaces", "delete", name, "--force"]));
}

/**
 * Delete the Worker Preview and its deployments. `cf previews` can only
 * deploy, so this is the API call cf's own (unexposed) delete makes.
 */
export async function deletePreview(
  cloudflare: Cloudflare,
  account: string,
  name: string,
): Promise<void> {
  const { status, body } = await cloudflare.api(
    "DELETE",
    `/accounts/${account}/workers/workers/${WORKER}/previews/${encodeURIComponent(name)}`,
  );
  if (status === 404 || (status >= 200 && status < 300)) return;
  if (absent(JSON.stringify(body))) return;
  throw new Error(`Deleting Preview ${name} returned HTTP ${status}: ${JSON.stringify(body)}`);
}

/** Delete the data resources a create made (all of them, whether or not they exist). */
export async function deleteData(cloudflare: Cloudflare, names: Names): Promise<void> {
  const failures: string[] = [];
  // Independent: one failing doesn't keep the others.
  for (const [what, work] of [
    ["database", () => deleteDatabase(cloudflare, names.db)],
    ["registry database", () => deleteDatabase(cloudflare, names.registryDb)],
    ["bucket", () => deleteBucket(cloudflare, names.bucket)],
    ["Artifacts namespace", () => deleteNamespace(cloudflare, names.artifacts)],
  ] as const) {
    try {
      await work();
    } catch (error) {
      failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(`Couldn't delete everything:\n${failures.join("\n")}`);
}

/** teardown: the Preview first (so nothing serves from half-deleted data), then its data. */
export async function teardown(cloudflare: Cloudflare, account: string, slug: string) {
  const all = names(slug);
  await deletePreview(cloudflare, account, all.preview);
  await deleteData(cloudflare, all);
  return all;
}

/** Fresh databases (migrations, then seed/), a bucket and a namespace for one create. */
export async function provision(
  cloudflare: Cloudflare,
  all: Names,
  secret: string,
): Promise<PreviewResources> {
  const db = await createDatabase(cloudflare, all.db);
  const registryDb = await createDatabase(cloudflare, all.registryDb);
  await cloudflare.cf(["d1", "migrations", "apply", db, "--dir", "migrations"]);
  await cloudflare.cf(["d1", "migrations", "apply", registryDb, "--dir", "registry/migrations"]);
  // Personas and Orbit Labs: the SQL half of `agent seed` (the API half follows the deploy).
  await cloudflare.cf(["d1", "migrations", "apply", db, "--dir", "seed"]);
  await cloudflare.cf(["r2", "buckets", "create", "--name", all.bucket]);
  await cloudflare.cf(["artifacts", "namespaces", "create", "--namespace", all.artifacts]);
  return {
    name: all.preview,
    db,
    registryDb,
    bucket: all.bucket,
    artifacts: all.artifacts,
    secret,
  };
}

/** Every top-level JSON object in some output, in order (cf may log one before its result). */
export function jsonObjects(output: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  for (let i = 0; i < output.length; i++) {
    const char = output[i];
    if (quoted) {
      if (char === "\\") i++;
      else if (char === '"') quoted = false;
    } else if (char === '"' && depth > 0) quoted = true;
    else if (char === "{" && depth++ === 0) start = i;
    else if (char === "}" && depth > 0 && --depth === 0) {
      try {
        found.push(JSON.parse(output.slice(start, i + 1)) as Record<string, unknown>);
      } catch {
        // Not JSON after all (a log line with braces): skip it.
      }
    }
  }
  return found;
}

/**
 * The Preview's URL from `cf previews deploy`: its stable, per-timeline
 * address (`preview_urls`), else this deployment's own.
 */
export function previewUrl(output: string): string {
  const results = jsonObjects(output);
  if (!results.length) throw new Error("cf previews deploy printed no result.");
  const urls = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(urls)
        : value && typeof value === "object"
          ? Object.values(value).flatMap(urls)
          : [];
  const field = (object: unknown, key: string) =>
    object && typeof object === "object" ? Reflect.get(object, key) : undefined;
  for (const result of results.reverse()) {
    const candidates = [
      ...urls(result.preview_urls ?? field(result.preview, "urls")),
      ...urls(result.deployment_urls ?? field(result.deployment, "urls")),
    ].map((url) => (/^https?:\/\//.test(url) ? url : `https://${url}`));
    const url = candidates.find((candidate) => candidate.startsWith("https://")) ?? candidates[0];
    if (url) return url.replace(/\/+$/, "");
  }
  throw new Error("cf previews deploy reported no URL.");
}

type Fetch = typeof fetch;

/** The secret and access key of this run: never printed, so never in the job's log. */
const hidden = new Set<string>();

export function hide(value: string): void {
  if (value) hidden.add(value);
}

/** Text with every hidden value replaced, for anything the script prints. */
export function redact(text: string): string {
  let out = text;
  for (const value of hidden) out = out.replaceAll(value, "[hidden]");
  return out;
}

/**
 * The link Gitmatrix records: the preview with its access key, which the
 * preview trades for a cookie (worker/preview-gate.ts). Whoever can read the
 * repository's deployment records can open it.
 */
export function accessLink(url: string, key: string): string {
  return `${url}/?preview_key=${key}`;
}

/** Wait until the new deployment answers as this preview, with its database ready. */
export async function waitForPreview(
  origin: string,
  resources: Pick<PreviewResources, "name" | "secret">,
  { request = fetch as Fetch, tries = 60, delayMs = 5000 } = {},
): Promise<void> {
  let last = "no answer";
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await request(`${origin}/api/dev/environment`, {
        headers: {
          Authorization: `Bearer ${resources.secret}`,
          "x-preview-key": previewKey(resources.secret),
        },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (response.ok) {
        const identity = (await response.json()) as { id: string | null; ready: boolean };
        // Only this create's deployment knows its secret.
        if (identity.id === resources.name && identity.ready) return;
        last = `id ${identity.id}, ready ${identity.ready}`;
      } else last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt + 1 < tries) await new Promise((done) => setTimeout(done, delayMs));
  }
  throw new Error(`The preview at ${origin} never came up (${last}).`);
}

/**
 * gm for `gm deploy record` and the fixture pushes: GITMATRIX_PREVIEW_GM when
 * given, else the newest gm main published to the job owner's generic
 * registry (README: "Gitmatrix publishes Linux x86-64 and ARM64 release
 * binaries from main"), checked against its SHA-256 as `gm pkg install` does.
 */
export async function installGm(
  env: NodeJS.ProcessEnv,
  directory: string,
  { request = fetch as Fetch, arch = process.arch } = {},
): Promise<string> {
  if (env.GITMATRIX_PREVIEW_GM) return resolve(env.GITMATRIX_PREVIEW_GM);
  const server = env.GITMATRIX_URL?.replace(/\/+$/, "");
  const owner = env.GITMATRIX_OWNER;
  const token = env.GITMATRIX_TOKEN;
  if (!server || !owner || !token)
    throw new Error("Installing gm needs a CI job's GITMATRIX_URL, GITMATRIX_OWNER and token.");
  const headers = { Authorization: `Bearer ${token}` };
  const owned = encodeURIComponent(owner);
  const detail = await request(`${server}/api/packages/${owned}/generic/gm`, { headers });
  if (!detail.ok) throw new Error(`Looking up gm returned HTTP ${detail.status}.`);
  const latest = ((await detail.json()) as { package?: { latest?: string } }).package?.latest;
  if (!latest || !/^[\w.-]+$/.test(latest)) throw new Error("gm has no published version.");
  const platform = `linux-${arch === "arm64" ? "aarch64" : "x86_64"}`;
  const response = await request(`${server}/generic/${owned}/gm/${latest}/${platform}/gm`, {
    headers,
  });
  if (!response.ok) throw new Error(`Downloading gm ${latest} returned HTTP ${response.status}.`);
  const expected = response.headers.get("x-checksum-sha256")?.toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!expected || createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(`gm ${latest} doesn't match its checksum.`);
  const path = join(directory, "gm");
  await writeFile(path, bytes);
  await chmod(path, 0o755);
  return path;
}

export interface Job {
  slug: string;
  account: string;
  env: NodeJS.ProcessEnv;
}

/** What `create` needs besides Cloudflare: injected so tests run none of it. */
export interface CreateDeps {
  cloudflare: Cloudflare;
  /** Seed the deployed preview through its API (tools/agent's fixtures). */
  seed(origin: string, resources: PreviewResources): Promise<void>;
  /** `gm deploy record`, with the job's variables. */
  record(args: string[]): Promise<void>;
  wait(origin: string, resources: PreviewResources): Promise<void>;
  secret?: string;
}

/** create: tear down, provision, deploy in preview mode, seed, record. Returns the URL. */
export async function create(deps: CreateDeps, job: Job): Promise<string> {
  const all = await teardown(deps.cloudflare, job.account, job.slug);
  const secret = deps.secret ?? randomBytes(32).toString("hex");
  const key = previewKey(secret);
  hide(secret);
  hide(key);
  const resources = await provision(deps.cloudflare, all, secret);
  // isPreview builds cloudflare.config.ts's preview mode, bound to these resources.
  const output = await deps.cloudflare.cf(
    ["previews", "deploy", all.preview],
    previewVariables(resources),
  );
  const url = previewUrl(output);
  await deps.wait(url, resources);
  await deps.seed(url, resources);
  // GITMATRIX_TIMELINE and GITMATRIX_CHECKPOINT file it under timeline/<slug>.
  // The recorded link carries the access key; nothing prints it.
  await deps.record(["deploy", "record", "--url", accessLink(url, key)]);
  return url;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; inherit?: boolean } = {},
): Promise<string> {
  return new Promise((done, fail) => {
    // Builds and migrations log to stderr: keep it in the job's log, line by
    // line so a hidden value is never split across writes.
    let pending = "";
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd ?? root,
        env: options.env ?? process.env,
        timeout: options.timeout ?? 600_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (pending) process.stderr.write(redact(pending));
        if (error)
          fail(new Error(redact(`${command} ${args.slice(0, 3).join(" ")} failed: ${stderr}`)));
        else done(stdout);
      },
    );
    child.stderr?.on("data", (chunk: string) => {
      pending += chunk;
      const end = pending.lastIndexOf("\n");
      if (end < 0) return;
      process.stderr.write(redact(pending.slice(0, end + 1)));
      pending = pending.slice(end + 1);
    });
  });
}

/** The real Cloudflare: the website's cf, and the API with the job's token. */
export function liveCloudflare(env: NodeJS.ProcessEnv): Cloudflare {
  const token = env.CLOUDFLARE_API_TOKEN;
  return {
    cf: (args, extra = {}) =>
      run(CF, args, { cwd: website, env: { ...env, ...extra }, timeout: 1_800_000 }),
    async api(method, path) {
      if (!token) throw new Error("The Cloudflare API needs CLOUDFLARE_API_TOKEN.");
      const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: keep the text for the error.
      }
      return { status: response.status, body };
    },
  };
}

/** The job's own variables: what any project's preview job gets (CORE-79). */
export function jobFrom(env: NodeJS.ProcessEnv): Job & { action: "create" | "teardown" } {
  const action = env.GITMATRIX_PREVIEW_ACTION;
  if (action !== "create" && action !== "teardown")
    throw new Error("Run from a preview job: GITMATRIX_PREVIEW_ACTION is create or teardown.");
  const slug = env.GITMATRIX_TIMELINE;
  if (!slug) throw new Error("A preview job names its timeline in GITMATRIX_TIMELINE.");
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) throw new Error("Set CLOUDFLARE_ACCOUNT_ID for the job.");
  return { action, slug, account, env };
}

/** The job's environment for gm, which needs none of Cloudflare's credentials. */
function withoutCloudflare(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest.CLOUDFLARE_API_TOKEN;
  return rest;
}

async function main(argv: string[]): Promise<void> {
  const job = jobFrom(process.env);
  if (argv[0] !== job.action)
    throw new Error(`Asked to ${argv[0]}, but this preview run is a ${job.action}.`);
  const cloudflare = liveCloudflare(job.env);
  if (job.action === "teardown") {
    const all = await teardown(cloudflare, job.account, job.slug);
    console.log(JSON.stringify({ event: "preview.teardown", ...all }));
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), "gitmatrix-preview-"));
  try {
    const gm = await installGm(job.env, scratch);
    const gmEnv = withoutCloudflare(job.env);
    const record = async (args: string[]) => {
      // gm prints the record, link and all: say only that it's done.
      const output = await run(gm, args, { env: gmEnv, timeout: 120_000 });
      const id = /"id"\s*:\s*(\d+)/.exec(output)?.[1];
      console.log(
        JSON.stringify({ event: "preview.recorded", deployment: id ? Number(id) : null }),
      );
    };
    try {
      const url = await create(
        {
          cloudflare,
          record,
          wait: (origin, resources) => waitForPreview(origin, resources),
          seed: async (origin, resources) => {
            await seedFixtures({
              id: resources.name,
              secret: resources.secret,
              origin,
              gm,
              dir: join(scratch, "seed"),
              work: scratch,
              env: gmEnv,
              headers: { "x-preview-key": previewKey(resources.secret) },
            });
          },
        },
        job,
      );
      console.log(JSON.stringify({ event: "preview.created", url, ...names(job.slug) }));
    } catch (error) {
      // The checkpoint shows a failed preview rather than none; the job still fails.
      await record(["deploy", "record", "--status", "failed"]).catch(() => {});
      throw error;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
