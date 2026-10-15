// Gitmatrix's own timeline previews (CORE-80): the reference implementation of
// the preview contract (apps/website/README.md, "Gitmatrix's own previews").
// .gitmatrix/ci.yml runs `create` in preview runs at each checkpoint (and on
// revival), `teardown` when the previews expire, and `reconcile` after each
// teardown. It uses only what any project has: the job's variables and
// credential, `cf`, `gm deploy record` and the deployments API (read only).
//
//   create    fresh D1s (migrations, then seed/), an R2 bucket and an Artifacts
//             namespace for the timeline; `cf previews deploy timeline-<slug>`
//             in preview mode (cloudflare.config.ts); the agent fixtures,
//             seeded through the preview's own API; then `gm deploy record`.
//   teardown  delete the Preview and every resource create made.
//   reconcile delete gitmatrix-preview-* resources no live preview owns
//             (CORE-372).
//
// A create that fails once it has started provisioning records a failed
// deployment, then deletes what it made (unless its live record may have been
// stored). A killed job or a failed cleanup can still leave resources behind:
// preview.create.rollback-failed names them.
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
import { loadEnvFile } from "node:process";
import {
  CONTENT_CONTRACT_HEADER,
  CONTENT_CONTRACT_VERSION,
} from "../../apps/website/shared/spaces.ts";
import {
  previewAccess,
  previewVariables,
  type PreviewAccess,
  type PreviewResources,
} from "../../apps/website/vite/preview.ts";
import {
  absent,
  deleteArtifactsNamespace,
  ignoringAbsent,
  listArtifactsRepos,
  refusedNotEmpty,
} from "../agent/cloudflare-delete.ts";
import { seedFixtures } from "../agent/seed.ts";

/** Shared with tools/agent (CORE-371): what counts as "not there", and the CORE-302 refusal. */
export { absent, refusedNotEmpty };

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

/** What may stop a reconcile's deletion part way: a time, and whether it's still the resource listed. */
interface Guard {
  /** No further cf call starts after this time (by `clock`). */
  deadline?: number;
  clock?: () => number;
  /** Pauses between repeat deletes of a namespace's repositories (tests inject a no-op). */
  wait?: (ms: number) => Promise<unknown>;
  /** Whether the bucket is still the one listed (not a create's new one). */
  unchanged?: () => Promise<boolean>;
}

function outOfTime(guard: Guard, what: string): void {
  if (guard.deadline !== undefined && (guard.clock ?? Date.now)() >= guard.deadline)
    throw new Error(`Deleting ${what} ran out of time.`);
}

/**
 * Empty a bucket page by page (deleting what each listing shows), then delete
 * it. "changed": the guard found it isn't the bucket listed, and it stopped.
 */
async function deleteBucket(
  cloudflare: Cloudflare,
  name: string,
  guard: Guard = {},
): Promise<"deleted" | "absent" | "changed"> {
  const ours = async () => !guard.unchanged || (await guard.unchanged());
  for (;;) {
    outOfTime(guard, `bucket ${name}`);
    if (!(await ours())) return "changed";
    let listed: unknown;
    try {
      listed = json(
        await cloudflare.cf(["r2", "objects", "list", "--bucket-name", name, "--per-page", "1000"]),
      );
    } catch (error) {
      if (absent(error)) return "absent";
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
  outOfTime(guard, `bucket ${name}`);
  // The bucket's own counterpart of deleting a D1 by uuid.
  if (!(await ours())) return "changed";
  await ignoringAbsent(cloudflare.cf(["r2", "buckets", "delete", name, "--force"]));
  return "deleted";
}

/** Delete a namespace's repositories, then the namespace (shared with tools/agent). */
async function deleteNamespace(
  cloudflare: Cloudflare,
  name: string,
  guard: Pick<Guard, "deadline" | "clock" | "wait"> = {},
): Promise<"deleted" | "absent" | "orphaned"> {
  return await deleteArtifactsNamespace((args) => cloudflare.cf(args), name, {
    ...guard,
    // A known Artifacts bug: the namespace counts a repository that no list
    // shows. Names come from the slug alone, so provision reuses the namespace
    // rather than failing every later create, revival and teardown.
    onOrphan: () =>
      console.error(
        JSON.stringify({
          event: "preview.namespace.orphaned",
          namespace: name,
          message:
            "Cloudflare refuses to delete this Artifacts namespace although it lists no repositories; create reuses it.",
        }),
      ),
  });
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/** A Cloudflare API error code (10007: no such Worker), or null. */
function errorCode(body: unknown): number | null {
  const errors = (body as { errors?: { code?: unknown }[] } | null)?.errors;
  const code = Array.isArray(errors) ? errors[0]?.code : undefined;
  return typeof code === "number" ? code : null;
}

/** The Worker's id, or null when there is no such Worker (so it has no Previews). */
async function workerId(cloudflare: Cloudflare, account: string): Promise<string | null> {
  const { status, body } = await cloudflare.api(
    "GET",
    `/accounts/${account}/workers/workers/${WORKER}`,
  );
  if (status === 404 && errorCode(body) === 10007) return null;
  const id = (body as { result?: { id?: unknown } } | null)?.result?.id;
  if (!ok(status) || typeof id !== "string")
    throw new Error(`Looking up Worker ${WORKER} returned HTTP ${status}: ${JSON.stringify(body)}`);
  return id;
}

interface Preview {
  id: string;
  name: string;
}

/** Every Preview of the Worker, page by page. */
async function listPreviews(
  cloudflare: Cloudflare,
  account: string,
  worker: string,
): Promise<Preview[]> {
  const all: Preview[] = [];
  const pages = new Pages(`${WORKER}'s Previews`);
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { status, body } = await cloudflare.api(
      "GET",
      `/accounts/${account}/workers/workers/${worker}/previews?per_page=100&page=${page}`,
    );
    const listed = body as {
      result?: Preview[] | null;
      result_info?: { per_page?: unknown; total_count?: unknown };
    } | null;
    if (!ok(status) || !Array.isArray(listed?.result)) {
      // A full last page makes us ask for one more; a server that refuses a
      // page past the end has already shown everything it counted.
      if (page > 1 && pages.pastTotal) return all;
      throw new Error(
        `Listing ${WORKER}'s Previews returned HTTP ${status}: ${JSON.stringify(body)}`,
      );
    }
    all.push(...listed.result);
    if (
      pages.ended(
        listed.result.map((preview) => String(preview.id)),
        listed.result_info,
      )
    )
      return all;
  }
  throw new Error(`Listing ${WORKER}'s Previews ran past ${MAX_PAGES} pages.`);
}

/**
 * Follows a page-numbered listing (Previews, D1s). Reconcile keeps what these
 * list, so a listing must not end early: it ends at an empty page, or at a
 * page shorter than the size the server says it used once total_count (when
 * given; a page may lack it or undercount) is reached. A page that repeats the
 * previous page's ids would loop: it throws, unless total_count was already
 * reached (a server answering past the last page with that page again).
 */
class Pages {
  #seen = 0;
  #total: number | undefined;
  #previous = "";
  readonly what: string;
  constructor(what: string) {
    this.what = what;
  }
  /** Whether the pages so far cover the total the server last reported. */
  get pastTotal(): boolean {
    return this.#total !== undefined && this.#seen >= this.#total;
  }
  /** Whether the listing ended with this page. */
  ended(ids: string[], info: { per_page?: unknown; total_count?: unknown } | undefined): boolean {
    const key = ids.join("\0");
    if (ids.length && key === this.#previous) {
      if (this.pastTotal) return true;
      throw new Error(`Listing ${this.what} repeated a page.`);
    }
    this.#previous = key;
    this.#seen += ids.length;
    const { per_page: perPage, total_count: total } = info ?? {};
    if (typeof total === "number") this.#total = total;
    return (
      !ids.length ||
      (typeof perPage === "number" &&
        ids.length < perPage &&
        (typeof total !== "number" || this.#seen >= total))
    );
  }
}

/**
 * Ask for exactly the Preview listed to go, by its id. A success or a 404
 * proves nothing: only a fresh list says it's gone (reconcile checks one).
 */
async function deletePreviewById(
  cloudflare: Cloudflare,
  account: string,
  worker: string,
  preview: Preview,
): Promise<void> {
  const { status, body } = await cloudflare.api(
    "DELETE",
    `/accounts/${account}/workers/workers/${worker}/previews/${encodeURIComponent(preview.id)}`,
  );
  if (!ok(status) && status !== 404)
    throw new Error(
      `Deleting Preview ${preview.name} returned HTTP ${status}: ${JSON.stringify(body)}`,
    );
}

/**
 * Delete the Worker Preview and its deployments. `cf previews` can only
 * deploy, so this calls the API (as cf's own unexposed delete does): find the
 * Preview by name in the Worker's list, delete it by id, and confirm it's gone.
 * Only the list says a Preview is absent; a 404 from the delete itself is an
 * error unless a fresh list agrees.
 */
export async function deletePreview(
  cloudflare: Cloudflare,
  account: string,
  name: string,
): Promise<void> {
  const worker = await workerId(cloudflare, account);
  if (!worker) return;
  const find = async () =>
    (await listPreviews(cloudflare, account, worker)).find((preview) => preview.name === name);
  const preview = await find();
  if (!preview) return;
  const { status, body } = await cloudflare.api(
    "DELETE",
    `/accounts/${account}/workers/workers/${worker}/previews/${encodeURIComponent(preview.id)}`,
  );
  if (!ok(status) && status !== 404)
    throw new Error(`Deleting Preview ${name} returned HTTP ${status}: ${JSON.stringify(body)}`);
  if (await find())
    throw new Error(
      `Preview ${name} (${preview.id}) is still listed after its delete returned HTTP ${status}: ${JSON.stringify(body)}`,
    );
}

/** Delete the data resources a create made (all of them, whether or not they exist). */
export async function deleteData(
  cloudflare: Cloudflare,
  names: Names,
  guard: Pick<Guard, "deadline" | "clock" | "wait"> = {},
): Promise<void> {
  const failures: string[] = [];
  // Independent: one failing doesn't keep the others.
  for (const [what, work] of [
    ["database", () => deleteDatabase(cloudflare, names.db)],
    ["registry database", () => deleteDatabase(cloudflare, names.registryDb)],
    ["bucket", () => deleteBucket(cloudflare, names.bucket, guard)],
    ["Artifacts namespace", () => deleteNamespace(cloudflare, names.artifacts, guard)],
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
export async function teardown(
  cloudflare: Cloudflare,
  account: string,
  slug: string,
  guard: Pick<Guard, "deadline" | "clock" | "wait"> = {},
) {
  const all = names(slug);
  await deletePreview(cloudflare, account, all.preview);
  await deleteData(cloudflare, all, guard);
  return all;
}

// reconcile (CORE-372): delete what no live preview owns. Data outlives its
// record when a create fails and can't record the failure (main's `.catch`),
// under a failed record, which never expires (the sweep tears down only
// active, sleeping and expired records), and in a namespace Cloudflare won't
// delete (CORE-302), retried here every run. A Preview outlives its record
// when a create is killed, or its cleanup fails, after deploying (CORE-385):
// a timeline-* Preview no live record explains goes once every D1 it may own
// is a day old (CORE-388), and its data with it. Which timelines are live comes
// from every source of the repository (deployments/live-timelines): since
// CORE-255 a timeline's records live in its own work source. A live timeline
// whose Preview isn't listed (Cloudflare deletes the oldest at its
// 500-Preview cap) is only reported: a Preview can drop out of the API while
// it still serves (CORE-216), and the records' own expiry tears it down.
//
// A teardown runs the reconcile code of the checkpoint it tears down, as a
// create runs the timeline's code with the same credentials: inherent in the
// preview contract. The server's kill switch is live-timelines: anything but
// a 200 there, and reconcile deletes nothing.
//
// Nothing serializes reconcile with creates (it holds no concurrency group,
// so a teardown never supersedes a waiting create). What protects a create in
// flight is age: its job times out after 40 minutes, and reconcile leaves
// anything younger than two hours, and anything sharing a name with something
// that young (a create makes its D1 before its bucket and namespace, which
// share the D1's name). Just before a bucket or namespace goes, a D1 of its
// exact name keeps it; and a D1 goes only by the uuid listed, never one made
// since.

/** What every preview resource's name starts with (names()). */
const PREFIX = "gitmatrix-preview-";
const REGISTRY_PREFIX = "gitmatrix-preview-registry-";
/** A resource younger than this may belong to a create still in flight (its job times out after 40 minutes). */
export const RECONCILE_MIN_AGE_MS = 2 * 60 * 60 * 1000;
/** Deletions per run. */
export const RECONCILE_MAX = 20;
/** A Preview no live record explains goes once every D1 it may own is this old (CORE-388). */
export const STALE_PREVIEW_MS = 24 * 60 * 60 * 1000;
/**
 * No deletion starts after this long: the job (15 minutes, pnpm install
 * included) must end, or the teardown run it's part of fails and the sweep
 * starts another.
 */
export const RECONCILE_BUDGET_MS = 8 * 60 * 1000;
/** Listing pages before a listing that never ends is an error. */
const MAX_PAGES = 100;

export type ResourceKind = "database" | "bucket" | "namespace";

export interface Resource {
  kind: ResourceKind;
  name: string;
  /** A D1's uuid: reconcile deletes exactly the database it listed, never one made since. */
  id?: string;
  /** When Cloudflare created it (ms), or null when its listing doesn't say. */
  created: number | null;
}

/** The repository's live timelines, read through the job's credential. */
export interface Deployments {
  /**
   * The slugs of the timelines with an active or sleeping record in any
   * source (GET …/deployments/live-timelines). Rejects on any failure.
   */
  liveTimelines(): Promise<string[]>;
}

/** How long one request to Gitmatrix may take. */
const GITMATRIX_TIMEOUT_MS = 30_000;

/**
 * The deployments API (worker/deployments/api.ts) with the job's credential.
 * Since CORE-255 a timeline's records live in its own work source, which the
 * job's other reads can't see: live-timelines is the one route that answers
 * across sources (slugs only). A server without it answers 404: an error.
 */
export function liveDeployments(env: NodeJS.ProcessEnv, request: Fetch = fetch): Deployments {
  const server = env.GITMATRIX_URL?.replace(/\/+$/, "");
  const repository = env.GITMATRIX_REPOSITORY ?? "";
  const token = env.GITMATRIX_TOKEN;
  if (!server || !token || !/^[^/]+\/[^/]+$/.test(repository))
    throw new Error(
      "Reconciling needs a CI job's GITMATRIX_URL, GITMATRIX_REPOSITORY and GITMATRIX_TOKEN.",
    );
  const url = `${server}/api/repos/${repository.split("/").map(encodeURIComponent).join("/")}/deployments/live-timelines`;
  return {
    async liveTimelines() {
      const response = await request(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(GITMATRIX_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Listing live timelines returned HTTP ${response.status}.`);
      const body = (await response.json()) as { timelines?: unknown };
      if (
        !Array.isArray(body.timelines) ||
        !body.timelines.every((slug) => typeof slug === "string")
      )
        throw new Error("The live timelines answer isn't a list of slugs.");
      return body.timelines as string[];
    },
  };
}

/** One page of a Cloudflare API listing: the envelope's result and result_info. */
async function listing(
  cloudflare: Cloudflare,
  path: string,
  what: string,
): Promise<{ result: unknown; info: Record<string, unknown> }> {
  const { status, body } = await cloudflare.api("GET", path);
  const envelope = body as { result?: unknown; result_info?: Record<string, unknown> } | null;
  if (!ok(status) || envelope?.result == null)
    throw new Error(`Listing ${what} returned HTTP ${status}: ${JSON.stringify(body)}`);
  return { result: envelope.result, info: envelope.result_info ?? {} };
}

function time(value: unknown): number | null {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(at) ? null : at;
}

function named(
  entry: unknown,
  what: string,
  ...keys: string[]
): Record<string, unknown> & { name: string } {
  const record = (entry ?? {}) as Record<string, unknown>;
  const name = keys.map((key) => record[key]).find((value) => typeof value === "string");
  if (typeof name !== "string") throw new Error(`A ${what} listing entry has no name.`);
  return { ...record, name };
}

/** Every D1 the API lists for a `name` filter (a substring match), page by page. */
async function databasesMatching(
  cloudflare: Cloudflare,
  account: string,
  name: string,
): Promise<Resource[]> {
  const found: Resource[] = [];
  const pages = new Pages("D1 databases");
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { result, info } = await listing(
      cloudflare,
      `/accounts/${account}/d1/database?name=${encodeURIComponent(name)}&per_page=100&page=${page}`,
      "D1 databases",
    );
    if (!Array.isArray(result)) throw new Error("The D1 listing isn't a list.");
    for (const entry of result) {
      const database = named(entry, "D1", "name");
      if (typeof database.uuid !== "string" || !database.uuid)
        throw new Error(`D1 ${database.name} is listed without a uuid.`);
      found.push({
        kind: "database",
        name: database.name,
        id: database.uuid,
        created: time(database.created_at),
      });
    }
    if (
      pages.ended(
        found.slice(found.length - result.length).map((d) => d.id!),
        info,
      )
    )
      return found;
  }
  throw new Error(`The D1 listing ran past ${MAX_PAGES} pages.`);
}

/** The preview D1s, through the API: cf's `d1 list` drops the envelope's paging. */
export async function listDatabases(cloudflare: Cloudflare, account: string): Promise<Resource[]> {
  return await databasesMatching(cloudflare, account, PREFIX);
}

/** Follow a cursor-paged listing to its end. */
async function cursorPages(
  cloudflare: Cloudflare,
  path: (cursor: string | null) => string,
  what: string,
  entries: (result: unknown) => unknown[],
): Promise<unknown[]> {
  const all: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { result, info } = await listing(cloudflare, path(cursor), what);
    const listed = entries(result);
    all.push(...listed);
    const next = typeof info.cursor === "string" && info.cursor ? info.cursor : null;
    if (!listed.length || !next) return all;
    if (next === cursor) throw new Error(`The ${what} listing repeated its cursor.`);
    cursor = next;
  }
  throw new Error(`The ${what} listing ran past ${MAX_PAGES} pages.`);
}

/** The preview buckets (`creation_date`). */
export async function listBuckets(cloudflare: Cloudflare, account: string): Promise<Resource[]> {
  const listed = await cursorPages(
    cloudflare,
    (cursor) =>
      `/accounts/${account}/r2/buckets?name_contains=${PREFIX}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    "R2 buckets",
    (result) => {
      const buckets = (result as { buckets?: unknown } | null)?.buckets;
      if (!Array.isArray(buckets)) throw new Error("The R2 listing has no buckets list.");
      return buckets;
    },
  );
  return listed.map((entry) => {
    const bucket = named(entry, "R2", "name");
    return { kind: "bucket", name: bucket.name, created: time(bucket.creation_date) };
  });
}

/**
 * The account's Artifacts namespaces. Their list response is undocumented
 * (developers.cloudflare.com/artifacts/api/rest-api shows only the request,
 * and cf passes the body through): an entry's name is `name` or `namespace`,
 * and a creation time, if any, `created_at`. Without one, a namespace's age is
 * its same-named D1's (and bucket's): a create makes the D1 first, and D1s and
 * buckets carry creation times. That sibling rule is all that keeps reconcile
 * off a create's namespace in flight.
 */
export async function listNamespaces(cloudflare: Cloudflare, account: string): Promise<Resource[]> {
  const listed = await cursorPages(
    cloudflare,
    (cursor) =>
      `/accounts/${account}/artifacts/namespaces?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    "Artifacts namespaces",
    (result) => {
      if (!Array.isArray(result)) throw new Error("The Artifacts listing isn't a list.");
      return result;
    },
  );
  return listed.map((entry) => {
    const namespace = named(entry, "Artifacts", "name", "namespace");
    return { kind: "namespace", name: namespace.name, created: time(namespace.created_at) };
  });
}

/**
 * Whether `resource` may belong to the timeline behind a Preview no live
 * record explains (its record may be in a source this job doesn't read). A
 * name can't be read back into a slug: a hashed name looks like a plain one
 * (bounded()), so both readings of the Preview's name protect what they could:
 *
 * - plain, `timeline-<slug>`: exactly names(slug);
 * - hashed, `timeline-<start>-<hash>`: any name whose slug part starts with
 *   `<start>` (the slug's, when that name isn't hashed) or that ends with
 *   `-<hash>` (the same hash of the whole slug, when it is).
 *
 * A Preview not named `timeline-…` could own anything.
 */
export function mayOwn(preview: string, resource: string): boolean {
  if (!preview.startsWith("timeline-")) return true;
  const rest = preview.slice("timeline-".length);
  if (SLUG.test(rest) && rest.length <= 64 && Object.values(names(rest)).includes(resource))
    return true;
  const hashed = /^(.+)-([0-9a-f]{8})$/.exec(rest);
  if (!hashed) return false;
  const [, start, hash] = hashed;
  const parts = [REGISTRY_PREFIX, PREFIX]
    .filter((prefix) => resource.startsWith(prefix))
    .map((prefix) => resource.slice(prefix.length));
  return resource.endsWith(`-${hash}`) || parts.some((part) => part.startsWith(start!));
}

export interface ReconcileOptions {
  cloudflare: Cloudflare;
  account: string;
  deployments: Deployments;
  /** Log what would be deleted, and change nothing. */
  dryRun?: boolean;
  /** Deletions per run. */
  max?: number;
  minAgeMs?: number;
  /** No deletion starts once this long has passed; default {@link RECONCILE_BUDGET_MS}. */
  budgetMs?: number;
  now?: number;
  /** The time, for the budget; default Date.now. */
  clock?: () => number;
  /** The order names' resources are tried in; default a shuffle. */
  order?: (groups: Resource[][]) => Resource[][];
  log?: (event: Record<string, unknown>) => void;
}

export interface ReconcileResult {
  /** Why reconcile changed nothing at all (it fails closed). */
  skipped?: string;
  candidates: string[];
  deleted: string[];
  failures: string[];
}

/** A new order, so no name always comes first. */
function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** A bucket's creation time (ms) by its exact name, "absent", or null when it doesn't say. */
async function bucketCreated(
  cloudflare: Cloudflare,
  account: string,
  name: string,
): Promise<number | null | "absent"> {
  const { status, body } = await cloudflare.api(
    "GET",
    `/accounts/${account}/r2/buckets/${encodeURIComponent(name)}`,
  );
  if (status === 404) return "absent";
  const bucket = (body as { result?: { name?: unknown; creation_date?: unknown } } | null)?.result;
  if (!ok(status) || bucket?.name !== name)
    throw new Error(`Looking up bucket ${name} returned HTTP ${status}: ${JSON.stringify(body)}`);
  return time(bucket.creation_date);
}

/** An error's message, for a log line. */
function described(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

/**
 * Delete the gitmatrix-preview-* resources no live preview owns, and the
 * timeline-* Previews no live record explains once their D1s are a day old
 * (CORE-388); report live timelines whose Preview isn't listed. A name a live timeline's slug
 * maps to is always kept, even when it also maps to another slug (CORE-377).
 * Fails closed: any listing error, or no live timeline while the Worker has
 * Previews, deletes nothing. A live timeline names() rejects owns nothing: it
 * is logged and left out.
 */
export async function reconcile(options: ReconcileOptions): Promise<ReconcileResult> {
  const { cloudflare, account, deployments } = options;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  const now = options.now ?? Date.now();
  const minAge = options.minAgeMs ?? RECONCILE_MIN_AGE_MS;
  const max = options.max ?? RECONCILE_MAX;
  const dryRun = options.dryRun ?? false;
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budget = options.budgetMs ?? RECONCILE_BUDGET_MS;
  const result: ReconcileResult = { candidates: [], deleted: [], failures: [] };
  const stop = (reason: string, error?: unknown) => {
    log({
      event: "preview.reconcile.skipped",
      reason,
      ...(error === undefined ? {} : { error: redact(described(error)) }),
    });
    result.skipped = reason;
    return result;
  };

  // Everything the decision needs, or no decision.
  let timelines: string[];
  let worker: string | null;
  let previews: Map<string, Preview>;
  let resources: Resource[];
  try {
    // Every source's live timelines (a timeline's records live in its own).
    timelines = await deployments.liveTimelines();
    worker = await workerId(cloudflare, account);
    previews = new Map(
      worker
        ? (await listPreviews(cloudflare, account, worker)).map((preview) => [
            preview.name,
            preview,
          ])
        : [],
    );
    resources = [
      ...(await listDatabases(cloudflare, account)),
      ...(await listBuckets(cloudflare, account)),
      ...(await listNamespaces(cloudflare, account)),
    ].filter((resource) => resource.name.startsWith(PREFIX));
  } catch (error) {
    return stop("a listing failed", error);
  }
  const live = new Set<string>();
  for (const slug of timelines) {
    // names() makes nothing for it, so it owns no preview resource.
    if (!SLUG.test(slug) || slug.length > 64) {
      log({ event: "preview.reconcile.ignored_slug", timeline: JSON.stringify(slug).slice(0, 80) });
      continue;
    }
    live.add(slug);
  }
  if (!live.size && previews.size)
    return stop("no live deployment records, but the Worker has Previews");

  // Kept: every name of a live record's slug (whatever other slug it may
  // also be a name of), and whatever a Preview no live record explains may own.
  const kept = new Set<string>();
  for (const slug of live) for (const name of Object.values(names(slug))) kept.add(name);
  const unexplained = [...previews.keys()].filter((preview) => !kept.has(preview));

  // A live timeline whose Preview isn't listed: reported, never acted on.
  // The Preview may still serve (CORE-216), or sleep on purpose, and the
  // records' expiry reaps it. Its names stay kept above.
  for (const slug of live)
    if (!previews.has(names(slug).preview))
      log({
        event: "preview.reconcile.preview_missing",
        timeline: slug,
        preview: names(slug).preview,
      });

  // Orphans: names no live preview owns, old enough not to be a create in flight.
  const young = new Set(
    resources
      .filter((resource) => resource.created !== null && now - resource.created < minAge)
      .map((resource) => resource.name),
  );
  const deadline = started + budget;
  let deletions = 0;

  // Stale Previews (CORE-388): a timeline-* Preview no live record explains
  // (a create that failed, or was killed, after deploying) goes once every D1
  // it may own is over a day old. A create makes its D1 just before it
  // deploys, and tears the old Preview down before that, so the D1's age is
  // the Preview's. Deleted by the id listed: a create since has a new one.
  const gone = new Set<string>();
  const asked: Preview[] = [];
  const databases = resources.filter((resource) => resource.kind === "database");
  // In a new order each run, so Previews that always fail can't starve the rest.
  for (const name of shuffled(unexplained)) {
    // A Preview names() didn't make could be anyone's.
    if (!name.startsWith("timeline-")) continue;
    const event = { kind: "preview", name };
    const own = databases.filter((database) => mayOwn(name, database.name));
    let reason: string | null = null;
    if (!own.length) reason = "no D1 it may own tells its age";
    else if (own.some((database) => database.created === null))
      reason = "a D1 it may own has no creation time";
    else if (own.some((database) => now - database.created! < STALE_PREVIEW_MS))
      reason = "a D1 it may own is under a day old";
    if (reason) {
      log({ event: "preview.reconcile.skipped", ...event, reason });
      continue;
    }
    result.candidates.push(`preview ${name}`);
    log({
      event: "preview.reconcile.candidate",
      ...event,
      reason: "no live record explains it, and every D1 it may own is over a day old",
    });
    // A dry run lists the data a real run would then reach.
    if (dryRun) {
      gone.add(name);
      continue;
    }
    if (deletions >= max) {
      log({ event: "preview.reconcile.skipped", ...event, reason: `over --max ${max}` });
      continue;
    }
    if (clock() >= deadline) {
      log({ event: "preview.reconcile.skipped", ...event, reason: "out of time" });
      continue;
    }
    try {
      deletions++;
      await deletePreviewById(cloudflare, account, worker!, previews.get(name)!);
      asked.push(previews.get(name)!);
    } catch (error) {
      result.failures.push(`preview ${name}: ${redact(described(error))}`);
      log({ event: "preview.reconcile.failed", ...event, error: redact(described(error)) });
    }
  }
  // Only a fresh list says a Preview is gone (CORE-216): its id no longer
  // listed (a create's new one by its name is another Preview). Until then
  // it still owns its data.
  if (asked.length) {
    let listed: Set<string> | null = null;
    try {
      listed = new Set(
        (await listPreviews(cloudflare, account, worker!)).map((preview) => preview.id),
      );
    } catch (error) {
      for (const preview of asked) {
        const why = `couldn't confirm it's gone: ${redact(described(error))}`;
        result.failures.push(`preview ${preview.name}: ${why}`);
        log({ event: "preview.reconcile.failed", kind: "preview", name: preview.name, error: why });
      }
    }
    for (const preview of listed ? asked : []) {
      const event = { kind: "preview", name: preview.name };
      if (listed!.has(preview.id)) {
        const why = "still listed after its delete";
        result.failures.push(`preview ${preview.name}: ${why}`);
        log({ event: "preview.reconcile.failed", ...event, error: why });
        continue;
      }
      gone.add(preview.name);
      result.deleted.push(`preview ${preview.name}`);
      log({ event: "preview.reconcile.deleted", ...event, outcome: "deleted" });
    }
  }
  const owners = unexplained.filter((name) => !gone.has(name));

  const orphans: Resource[] = [];
  for (const resource of resources) {
    if (kept.has(resource.name)) continue;
    const event = { kind: resource.kind, name: resource.name };
    const preview = owners.find((name) => mayOwn(name, resource.name));
    let reason: string | null = null;
    if (preview) reason = `Preview ${preview}, which no live record explains, may own it`;
    else if (resource.created === null && resource.kind !== "namespace")
      reason = "no creation time";
    // Its own age, or (one name for a create's D1, bucket and namespace) a sibling's.
    else if (young.has(resource.name)) reason = "created recently";
    if (reason) {
      log({ event: "preview.reconcile.skipped", ...event, reason });
      continue;
    }
    orphans.push(resource);
  }
  // One name's resources together, D1 first (as listed: the recheck below
  // relies on it), the names in a new order each run, so a resource that
  // fails or takes all the time can't starve the rest run after run.
  const groups = new Map<string, Resource[]>();
  for (const resource of orphans)
    groups.set(resource.name, [...(groups.get(resource.name) ?? []), resource]);
  for (const resource of (options.order ?? shuffled)([...groups.values()]).flat()) {
    const event = { kind: resource.kind, name: resource.name };
    result.candidates.push(`${resource.kind} ${resource.name}`);
    log({ event: "preview.reconcile.candidate", ...event, reason: "no live preview owns it" });
    if (dryRun) continue;
    if (deletions >= max) {
      log({ event: "preview.reconcile.skipped", ...event, reason: `over --max ${max}` });
      continue;
    }
    if (clock() >= deadline) {
      log({ event: "preview.reconcile.skipped", ...event, reason: "out of time" });
      continue;
    }
    try {
      // Listed a while ago: a create may have started since. Its D1 comes
      // first (and orphaned D1s, by the uuid listed, went above), so a D1 of
      // this exact name now means the bucket or namespace may be that
      // create's. Every page of the lookup, or (on any error) nothing.
      if (
        resource.kind !== "database" &&
        (await databasesMatching(cloudflare, account, resource.name)).some(
          (database) => database.name === resource.name,
        )
      ) {
        log({
          event: "preview.reconcile.skipped",
          ...event,
          reason: "a D1 of its name exists now",
        });
        continue;
      }
      deletions++;
      let outcome = "deleted";
      // Exactly the D1 listed: a create since may have made a new one by its name.
      if (resource.kind === "database")
        await ignoringAbsent(cloudflare.cf(["d1", "delete", resource.id!, "--force"]));
      else if (resource.kind === "bucket")
        outcome = await deleteBucket(cloudflare, resource.name, {
          deadline,
          clock,
          unchanged: async () => {
            const current = await bucketCreated(cloudflare, account, resource.name);
            return current === "absent" || current === resource.created;
          },
        });
      else outcome = await deleteNamespace(cloudflare, resource.name, { deadline, clock });
      if (outcome === "changed") {
        log({
          event: "preview.reconcile.skipped",
          ...event,
          reason: "the bucket by this name isn't the one listed",
        });
        continue;
      }
      result.deleted.push(`${resource.kind} ${resource.name}`);
      log({ event: "preview.reconcile.deleted", ...event, outcome });
    } catch (error) {
      result.failures.push(`${resource.kind} ${resource.name}: ${redact(described(error))}`);
      log({ event: "preview.reconcile.failed", ...event, error: redact(described(error)) });
    }
  }
  log({
    event: "preview.reconcile",
    dryRun,
    live: live.size,
    previews: previews.size,
    resources: resources.length,
    candidates: result.candidates.length,
    deleted: result.deleted.length,
    failures: result.failures.length,
  });
  return result;
}

/** `reconcile [--dry-run] [--max N]`. */
export function reconcileArgs(argv: string[]): { dryRun: boolean; max: number } {
  const parsed = { dryRun: false, max: RECONCILE_MAX };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") parsed.dryRun = true;
    else if (argv[i] === "--max" && /^[1-9]\d*$/.test(argv[i + 1] ?? ""))
      parsed.max = Number(argv[++i]);
    else throw new Error("Use: reconcile [--dry-run] [--max N]");
  }
  return parsed;
}

/** Fresh databases (migrations, then seed/), a bucket and a namespace for one create. */
export async function provision(
  cloudflare: Cloudflare,
  all: Names,
  secret: string,
  access: PreviewAccess,
): Promise<PreviewResources> {
  const db = await createDatabase(cloudflare, all.db);
  const registryDb = await createDatabase(cloudflare, all.registryDb);
  await cloudflare.cf(["d1", "migrations", "apply", db, "--dir", "migrations"]);
  await cloudflare.cf(["d1", "migrations", "apply", registryDb, "--dir", "registry/migrations"]);
  // Personas and Orbit Labs: the SQL half of `agent seed` (the API half follows the deploy).
  await cloudflare.cf(["d1", "migrations", "apply", db, "--dir", "seed"]);
  await cloudflare.cf(["r2", "buckets", "create", "--name", all.bucket]);
  // Teardown leaves a namespace Cloudflare won't delete once it lists nothing
  // (see deleteNamespace): reuse it rather than fail on its name.
  const leftover = await listArtifactsRepos((args) => cloudflare.cf(args), all.artifacts);
  if (!leftover)
    await cloudflare.cf(["artifacts", "namespaces", "create", "--namespace", all.artifacts]);
  else if (leftover.length)
    throw new Error(
      `Artifacts namespace ${all.artifacts} still lists repositories after teardown.`,
    );
  return {
    ...access,
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

/** The service credential stays in the caller's environment, never in a preview URL. */
export function accessHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.GITMATRIX_ACCESS_TOKEN ?? "";
  hide(token);
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    throw new Error("GITMATRIX_ACCESS_TOKEN must contain the Access service token JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("GITMATRIX_ACCESS_TOKEN must contain the Access service token JSON.");
  const id: unknown = Reflect.get(parsed, "cf-access-client-id");
  const secret: unknown = Reflect.get(parsed, "cf-access-client-secret");
  if (
    typeof id !== "string" ||
    typeof secret !== "string" ||
    !/^[\x21-\x7e]+$/.test(id) ||
    !/^[\x21-\x7e]+$/.test(secret)
  )
    throw new Error(
      "GITMATRIX_ACCESS_TOKEN needs nonempty cf-access-client-id and cf-access-client-secret.",
    );
  hide(id);
  hide(secret);
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

/** Wait until the new deployment answers as this preview, with its database ready. */
export async function waitForPreview(
  origin: string,
  resources: Pick<PreviewResources, "name" | "secret">,
  {
    request = fetch as Fetch,
    tries = 60,
    delayMs = 5000,
    headers = {} as Record<string, string>,
  } = {},
): Promise<void> {
  let last = "no answer";
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await request(`${origin}/api/dev/environment`, {
        headers: {
          ...headers,
          Authorization: `Bearer ${resources.secret}`,
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

/** How long downloading gm's binary may take; its lookup takes {@link GITMATRIX_TIMEOUT_MS}. */
export const GM_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * gm for `gm deploy record` and the fixture pushes: GITMATRIX_PREVIEW_GM when
 * given, else the newest gm main published to the job Space's generic
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
  const space = env.GITMATRIX_SPACE;
  const token = env.GITMATRIX_TOKEN;
  if (!server || !space || !token)
    throw new Error("Installing gm needs a CI job's GITMATRIX_URL, GITMATRIX_SPACE and token.");
  const headers = {
    Authorization: `Bearer ${token}`,
    [CONTENT_CONTRACT_HEADER]: String(CONTENT_CONTRACT_VERSION),
  };
  const owned = encodeURIComponent(space);
  const detail = await request(`${server}/api/packages/${owned}/generic/gm`, {
    headers,
    signal: AbortSignal.timeout(GITMATRIX_TIMEOUT_MS),
  });
  if (!detail.ok) throw new Error(`Looking up gm returned HTTP ${detail.status}.`);
  const latest = ((await detail.json()) as { package?: { latest?: string } }).package?.latest;
  if (!latest || !/^[\w.-]+$/.test(latest)) throw new Error("gm has no published version.");
  const platform = `linux-${arch === "arm64" ? "aarch64" : "x86_64"}`;
  const response = await request(`${server}/generic/${owned}/gm/${latest}/${platform}/gm`, {
    headers,
    // The body too: reading it ends with the same signal.
    signal: AbortSignal.timeout(GM_DOWNLOAD_TIMEOUT_MS),
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
  seed(origin: string, resources: PreviewResources, headers: Record<string, string>): Promise<void>;
  /** `gm deploy record`, with the job's variables. */
  record(args: string[]): Promise<void>;
  /** Whether this run stored a live record at `url`: null when that can't be told. */
  recorded(url: string): Promise<boolean | null>;
  /** The rollback's clock (tests). */
  clock?: () => number;
  /** Pauses between repeat repository deletes during teardown (tests). */
  pause?: (ms: number) => Promise<unknown>;
  wait(origin: string, resources: PreviewResources, headers: Record<string, string>): Promise<void>;
  secret?: string;
}

/**
 * create: tear down, provision, deploy in preview mode, seed, record. Returns
 * the URL. A failed create records a failed deployment first (so a slow
 * cleanup can't keep the checkpoint from saying so), then undoes what it made
 * (CORE-385): no live record accounts for it, so the sweep would never tear it
 * down. Only when its own live record may exist (the record call failed but
 * may have landed) does it keep the preview. Creates for one source run one at
 * a time, so the slug's names are this create's.
 */
export async function create(deps: CreateDeps, job: Job): Promise<string> {
  let made = false;
  let url: string | undefined;
  let recording = false;
  try {
    const access = previewAccess(job.env);
    const headers = accessHeaders(job.env);
    const all = await teardown(deps.cloudflare, job.account, job.slug, { wait: deps.pause });
    const secret = deps.secret ?? randomBytes(32).toString("hex");
    hide(secret);
    made = true;
    const resources = await provision(deps.cloudflare, all, secret, access);
    // isPreview builds cloudflare.config.ts's preview mode, bound to these resources.
    const output = await deps.cloudflare.cf(
      ["previews", "deploy", all.preview],
      previewVariables(resources),
    );
    url = previewUrl(output);
    await deps.wait(url, resources, headers);
    await deps.seed(url, resources, headers);
    // GITMATRIX_TIMELINE and GITMATRIX_CHECKPOINT file it under timeline/<slug>.
    // Access protects the hostname; recorded links contain no bearer capability.
    recording = true;
    await deps.record(["deploy", "record", "--url", url]);
    return url;
  } catch (error) {
    // A record call that failed may still have stored the live record.
    const live = recording && url ? await deps.recorded(url).catch(() => null) : false;
    // The checkpoint shows a failed preview rather than none; the job still fails.
    if (live !== true)
      await deps.record(["deploy", "record", "--status", "failed"]).catch(() => {});
    if (made && live === false) await rollBack(deps.cloudflare, job, deps.clock, deps.pause);
    else if (made)
      console.error(
        JSON.stringify({
          event: "preview.create.kept",
          ...names(job.slug),
          reason:
            live === true ? "its live record was stored" : "its live record may have been stored",
        }),
      );
    throw error;
  }
}

/** How long a failed create spends deleting what it made. */
const ROLLBACK_MS = 10 * 60_000;

/**
 * Undo a failed create: its Preview and data. The create's own error is the
 * one reported; a rollback that fails too says what it left, for a person or
 * reconcile (CORE-372) to delete.
 */
async function rollBack(
  cloudflare: Cloudflare,
  job: Job,
  clock: () => number = Date.now,
  wait?: (ms: number) => Promise<unknown>,
): Promise<void> {
  try {
    // Bounded: a bucket or namespace that won't empty mustn't hold the
    // repository's preview slot until the job's own deadline.
    const all = await teardown(cloudflare, job.account, job.slug, {
      deadline: clock() + ROLLBACK_MS,
      clock,
      wait,
    });
    console.error(JSON.stringify({ event: "preview.create.rolled-back", ...all }));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "preview.create.rollback-failed",
        ...names(job.slug),
        error: redact(error instanceof Error ? error.message : String(error)),
      }),
    );
  }
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

/**
 * The real Cloudflare: the website's cf, and the API with the job's token.
 * `cfTimeoutMs` bounds each cf call (builds and deploys take long; reconcile
 * passes less), `apiTimeoutMs` each API request.
 */
export function liveCloudflare(
  env: NodeJS.ProcessEnv,
  { cfTimeoutMs = 1_800_000, apiTimeoutMs = 120_000 } = {},
): Cloudflare {
  const token = env.CLOUDFLARE_API_TOKEN;
  return {
    cf: (args, extra = {}) =>
      // Uncoloured, so its errors read plainly (absent() also strips colour).
      run(CF, args, {
        cwd: website,
        env: { ...env, ...extra, NO_COLOR: "1" },
        timeout: cfTimeoutMs,
      }),
    async api(method, path) {
      if (!token) throw new Error("The Cloudflare API needs CLOUDFLARE_API_TOKEN.");
      const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(apiTimeoutMs),
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

/**
 * The API path listing this run's live deployment records, in the job's own
 * source (a timeline's preview runs in its work source; the list defaults to
 * canonical, which `gm deploy list` can't change). Null without the job's
 * variables.
 */
export function liveRecordsPath(env: NodeJS.ProcessEnv): string | null {
  const repo = env.GITMATRIX_REPOSITORY;
  const source = env.GITMATRIX_SOURCE_ID;
  const run = env.GITMATRIX_RUN_NUMBER;
  if (
    !repo ||
    !source ||
    !run ||
    !/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo) ||
    !/^\d+$/.test(run)
  )
    return null;
  const query = new URLSearchParams({ run, status: "active", source, limit: "100" });
  return `/repos/${repo}/deployments?${query}`;
}

/** The job's environment for gm, which needs none of Cloudflare's credentials. */
function withoutCloudflare(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest.CLOUDFLARE_API_TOKEN;
  delete rest.GITMATRIX_ACCESS_TOKEN;
  delete rest.GITMATRIX_ACCESS_ORIGIN;
  return rest;
}

/**
 * `reconcile`, which exits 0 whatever happens to it: it runs in teardown runs,
 * and a failed teardown run makes the sweep start another. Whatever goes
 * wrong, setup included, is logged as skipped (or failed). (Its job can still
 * fail before it, e.g. in `pnpm install`.)
 */
export async function reconcileMain(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  log: (event: Record<string, unknown>) => void = (event) => console.log(JSON.stringify(event)),
): Promise<void> {
  try {
    const flags = reconcileArgs(argv);
    const account = env.CLOUDFLARE_ACCOUNT_ID;
    if (!account) throw new Error("Set CLOUDFLARE_ACCOUNT_ID for the job.");
    if (!env.CLOUDFLARE_API_TOKEN) throw new Error("Set CLOUDFLARE_API_TOKEN for the job.");
    await reconcile({
      // Each cf call well inside the job's 15 minutes.
      cloudflare: liveCloudflare(env, { cfTimeoutMs: 120_000, apiTimeoutMs: 60_000 }),
      account,
      deployments: liveDeployments(env),
      log,
      ...flags,
    });
  } catch (error) {
    log({
      event: "preview.reconcile.skipped",
      reason: "an error stopped it",
      error: redact(described(error)),
    });
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "reconcile") return await reconcileMain(argv.slice(1));
  try {
    loadEnvFile(join(root, ".env"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
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
    const url = await create(
      {
        cloudflare,
        record,
        // This run's live records: the one a failed record call may have stored.
        recorded: async (url) => {
          const path = liveRecordsPath(job.env);
          if (!path) return null;
          const listed = JSON.parse(
            await run(gm, ["api", "GET", path, "-o", "json"], { env: gmEnv, timeout: 120_000 }),
          ) as { deployments?: { url: string | null }[] };
          if (!Array.isArray(listed.deployments)) return null;
          return listed.deployments.some((deployment) => deployment.url === url);
        },
        wait: (origin, resources, headers) => waitForPreview(origin, resources, { headers }),
        seed: async (origin, resources, headers) => {
          await seedFixtures({
            id: resources.name,
            secret: resources.secret,
            origin,
            gm,
            dir: join(scratch, "seed"),
            work: scratch,
            env: {
              ...gmEnv,
              GITMATRIX_ACCESS_ORIGIN: origin,
              GITMATRIX_ACCESS_TOKEN: job.env.GITMATRIX_ACCESS_TOKEN,
            },
            headers,
          });
        },
      },
      job,
    );
    console.log(JSON.stringify({ event: "preview.created", url, ...names(job.slug) }));
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
