// Resolving refs found in text (CORE-22) for one viewer: issue keys, tracker
// issue URLs of this deployment, commit hashes in a repository, `owner/repo`
// and `pkg@version`. Every answer is permission-checked (tracker membership,
// repository read, registry feed read); anything the viewer can't open, or
// that might belong to an external tracker, is `unresolved` and stays text.

import { FORMATS, isFormatId } from "@gitmatrix/formats/info";
import { sql } from "kysely";
import { packagePath } from "../../shared/packages.ts";
import {
  commitPath,
  issueUrlParts,
  REF_LIMITS,
  refKind,
  type CommitTarget,
  type IssueTarget,
  type PackageTarget,
  type RefContext,
  type RefKind,
  type RefResolution,
  type RefTarget,
} from "../../shared/refs.ts";
import type { Issue, TrackerOwner } from "../../shared/tracker.ts";
import { readableRepo, roleFor, selectRepos, type Actor, type RepoRow } from "../db.ts";
import { RepoReader } from "../objects.ts";
import { atLeast } from "../permissions.ts";
import { repoTrackers } from "../mentions/index.ts";
import { db } from "../schema.ts";
import { Timing } from "../timing.ts";
import { accessible } from "../tracker/api.ts";
import { trackerObject } from "../tracker/stub.ts";
import { Services } from "../../registry/core/context.ts";
import { listRepos } from "../../registry/core/repos.ts";

export interface ResolveScope {
  env: Env;
  actor: Actor | null;
  /** The incoming request: the registry authenticates it itself, as /api/packages does. */
  request: Request;
  /** Origins whose `/tracker/…` URLs are this deployment's (PUBLIC_URL, the request's). */
  origins: string[];
  timing?: Timing;
  waitUntil: (work: Promise<unknown>) => void;
}

type IssueRow = Pick<Issue, "id" | "key" | "title" | "status">;

/** How many trackers are read at once. */
const TRACKER_CONCURRENCY = 6;

/** `work` over `items`, at most `limit` at a time, results in input order. */
async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = [];
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await work(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function issueTarget(owner: Pick<TrackerOwner, "slug">, issue: IssueRow): IssueTarget {
  return {
    kind: "issue",
    path: `/tracker/${encodeURIComponent(owner.slug)}/issues/${encodeURIComponent(issue.id)}`,
    label: `${issue.key} · ${issue.title}`,
    tracker: owner.slug,
    id: issue.id,
    key: issue.key,
    title: issue.title,
    status: issue.status,
  };
}

/** The origins a request treats as its own: PUBLIC_URL's and the request's. */
export function ownOrigins(env: Env, requestUrl: string): string[] {
  const origins = new Set([new URL(requestUrl).origin]);
  const configured = Reflect.get(env, "PUBLIC_URL");
  if (typeof configured === "string" && configured) {
    try {
      origins.add(new URL(configured).origin);
    } catch {
      // A malformed PUBLIC_URL recognizes nothing extra.
    }
  }
  return [...origins];
}

/**
 * Resolve `refs` for the viewer, one answer per ref in order. Lookups are
 * shared across the batch: each tracker, repository and feed is read once.
 */
export async function resolveRefs(
  scope: ResolveScope,
  refs: string[],
  context: RefContext = {},
): Promise<RefResolution[]> {
  const unique = [...new Set(refs)];
  const kinds = new Map<string, RefKind | null>(unique.map((ref) => [ref, refKind(ref)]));
  const answers = new Map<string, RefResolution>();
  const of = (kind: RefKind) => unique.filter((ref) => kinds.get(ref) === kind);

  // The page's repository, when the viewer can read it.
  const contextRepo =
    context.owner && context.repo
      ? await readableRepos(scope, [[context.owner, context.repo]]).then(
          (found) => found.get(`${context.owner}/${context.repo}`) ?? null,
        )
      : null;

  await Promise.all([
    resolveIssues(scope, of("issue"), of("issue-url"), context, contextRepo, answers),
    resolveRepos(scope, of("repo"), answers),
    resolveCommits(scope, of("commit"), contextRepo, answers),
    resolvePackages(scope, of("package"), context.owner, answers),
  ]);
  return refs.map((ref) => answers.get(ref) ?? { ref, status: "unresolved" });
}

// ── Issues ────────────────────────────────────────────────────────────────

/**
 * Issue keys, best tracker first: the page's tracker, then the trackers that
 * subscribe to the page's repository, then any other the viewer belongs to.
 * The first tier with a match decides; two matches in that tier are ambiguous.
 * Tracker URLs resolve only for this deployment's origins, in the tracker
 * they name, and only when the viewer belongs to it.
 */
async function resolveIssues(
  scope: ResolveScope,
  keys: string[],
  urls: string[],
  context: RefContext,
  contextRepo: RepoRow | null,
  answers: Map<string, RefResolution>,
) {
  if (!keys.length && !urls.length) return;
  const trackers = scope.actor ? await accessible(scope.env.DB, scope.actor) : [];
  const bySlug = new Map(trackers.map((t) => [t.slug, t]));
  // One lookup per tracker for the whole batch.
  const lookups = new Map<string, Promise<IssueRow[] | null>>();
  const lookup = (owner: TrackerOwner, wanted: string[]) => {
    const cacheKey = `${owner.id}\n${wanted.join("\n")}`;
    let pending = lookups.get(cacheKey);
    if (!pending) {
      // An RPC answers with a promise; a test's in-process object may not (await takes both).
      pending = (async () => {
        const reply = await trackerObject(scope.env, owner.id).issueRefs(wanted);
        return reply.ok ? (reply.value as IssueRow[]) : null;
      })().catch((error: unknown) => {
        console.error(`refs: tracker ${owner.slug} failed`, error);
        return null;
      });
      lookups.set(cacheKey, pending);
    }
    return pending;
  };

  // URLs: this deployment's tracker, by id or key.
  const urlsByTracker = new Map<TrackerOwner, { ref: string; issue: string }[]>();
  for (const ref of urls) {
    const parts = issueUrlParts(ref);
    if (!parts || !scope.origins.includes(parts.origin)) continue;
    const owner = bySlug.get(parts.tracker);
    if (!owner) {
      answers.set(ref, { ref, status: "unresolved", ours: true });
      continue;
    }
    urlsByTracker.set(owner, [...(urlsByTracker.get(owner) ?? []), { ref, issue: parts.issue }]);
  }
  const urlWork = [...urlsByTracker].map(async ([owner, wanted]) => {
    const found = (await lookup(owner, [...new Set(wanted.map((w) => w.issue))])) ?? [];
    for (const { ref, issue } of wanted) {
      const hit = found.find((row) => row.id === issue || row.key === issue);
      answers.set(
        ref,
        hit
          ? { ref, status: "resolved", target: issueTarget(owner, hit) }
          : { ref, status: "unresolved", ours: true },
      );
    }
  });

  // Keys: tier by tier.
  const keyWork = (async () => {
    if (!keys.length || !trackers.length) return;
    const first = context.tracker ? bySlug.get(context.tracker) : undefined;
    // The repository's subscribing trackers and its owner's: one tier here
    // (the push-time mention index splits them, worker/mentions).
    const related = contextRepo
      ? await repoTrackers(scope.env.DB, contextRepo.id, { orgs: false })
      : null;
    const subscribed = new Set(
      related ? [...related.subscribed.map((t) => t.id), related.owner.id] : [],
    );
    const rest = trackers
      .filter((t) => t !== first && !subscribed.has(t.id))
      // Your own tracker first, then organizations by slug.
      .sort((a, b) => Number(b.id === scope.actor!.id) - Number(a.id === scope.actor!.id));
    const tiers = [
      first ? [first] : [],
      trackers.filter((t) => t !== first && subscribed.has(t.id)),
      rest,
    ];
    let budget: number = REF_LIMITS.trackers;
    let open = keys;
    for (const tier of tiers) {
      if (!open.length) break;
      const read = tier.slice(0, Math.max(0, budget));
      budget -= read.length;
      if (!read.length) continue;
      const found = await pooled(read, TRACKER_CONCURRENCY, async (owner) => ({
        owner,
        issues: (await lookup(owner, open)) ?? [],
      }));
      const still: string[] = [];
      for (const ref of open) {
        const hits = found.flatMap(({ owner, issues }) =>
          issues.filter((issue) => issue.key === ref).map((issue) => issueTarget(owner, issue)),
        );
        if (hits.length === 1) answers.set(ref, { ref, status: "resolved", target: hits[0]! });
        else if (hits.length > 1) answers.set(ref, { ref, status: "ambiguous", candidates: hits });
        else still.push(ref);
      }
      open = still;
    }
  })();
  await Promise.all([...urlWork, keyWork]);
}

// ── Repositories ──────────────────────────────────────────────────────────

/** Readable repositories among `pairs`, by `owner/name`. */
async function readableRepos(
  scope: ResolveScope,
  pairs: [string, string][],
): Promise<Map<string, RepoRow & { owner_slug: string }>> {
  if (!pairs.length) return new Map();
  const rows = await selectRepos(scope.env.DB, scope.actor?.id ?? "")
    .where(readableRepo(scope.actor))
    .where((eb) =>
      eb.or(
        pairs.map(([owner, name]) => eb.and([eb("o.slug", "=", owner), eb("r.name", "=", name)])),
      ),
    )
    .execute();
  return new Map(
    rows
      // permissions.ts stays the authority; readableRepo already agrees with it.
      .filter((row) => atLeast(roleFor(row, scope.actor), "read"))
      .map((row) => [`${row.owner_slug}/${row.name}`, row]),
  );
}

async function resolveRepos(
  scope: ResolveScope,
  refs: string[],
  answers: Map<string, RefResolution>,
) {
  const pairs = refs.map((ref) => ref.split("/") as [string, string]);
  const found = await readableRepos(scope, pairs);
  for (const ref of refs) {
    const row = found.get(ref);
    if (row)
      answers.set(ref, {
        ref,
        status: "resolved",
        target: {
          kind: "repo",
          path: `/${encodeURIComponent(row.owner_slug)}/${encodeURIComponent(row.name)}`,
          label: `${row.owner_slug}/${row.name}`,
          owner: row.owner_slug,
          name: row.name,
        },
      });
  }
}

// ── Commits ───────────────────────────────────────────────────────────────

/**
 * Hashes in the page's repository. A full hash must name a commit there. A
 * short one must prefix exactly one commit among the branch and tag tips,
 * the repository's CI runs and its recent default-branch history
 * (REF_LIMITS.history): Artifacts can't expand an abbreviation, and a
 * hash in a log or a message is nearly always a recent one.
 */
async function resolveCommits(
  scope: ResolveScope,
  refs: string[],
  repo: (RepoRow & { owner_slug?: string }) | null,
  answers: Map<string, RefResolution>,
) {
  if (!refs.length || !repo) return;
  const owner =
    repo.owner_slug ??
    (
      await db(scope.env.DB)
        .selectFrom("accounts")
        .select("slug")
        .where("id", "=", repo.owner_id)
        .executeTakeFirstOrThrow()
    ).slug;
  const target = (sha: string): CommitTarget => ({
    kind: "commit",
    path: commitPath(owner, repo.name, sha),
    label: `Commit ${sha.slice(0, 7)} in ${owner}/${repo.name}`,
    owner,
    repo: repo.name,
    sha,
  });
  const reader = new RepoReader(
    scope.env,
    repo.artifacts_name,
    repo.artifacts_remote,
    scope.timing ?? new Timing(),
    scope.waitUntil,
  );
  try {
    const full = refs.filter((ref) => ref.length === 40);
    const short = refs.filter((ref) => ref.length < 40);
    await Promise.all(
      full.map(async (sha) => {
        const commit = await reader.commit(sha).catch(() => null);
        if (commit) answers.set(sha, { ref: sha, status: "resolved", target: target(sha) });
      }),
    );
    if (!short.length) return;
    const known = new Set<string>();
    const refsNow = await reader.refs().catch(() => null);
    if (refsNow) {
      if (refsNow.head) known.add(refsNow.head);
      for (const ref of [...refsNow.branches, ...refsNow.tags]) known.add(ref.oid);
    }
    const runs = await db(scope.env.DB)
      .selectFrom("ci_runs")
      .select("commit_oid")
      .distinct()
      .where("repo_id", "=", repo.id)
      .where((eb) => eb.or(short.map((prefix) => eb("commit_oid", "like", `${prefix}%`))))
      .limit(500)
      .execute();
    for (const run of runs) known.add(run.commit_oid);
    const matching = (prefix: string) => [...known].filter((oid) => oid.startsWith(prefix));
    if (short.some((prefix) => matching(prefix).length === 0)) {
      const head = refsNow?.head ?? (await reader.resolve(repo.default_branch).catch(() => null));
      if (head) {
        const log = await reader.log(head, REF_LIMITS.history, 0).catch(() => []);
        for (const commit of log) known.add(commit.hash);
      }
    }
    for (const prefix of short) {
      const hits = matching(prefix);
      if (hits.length === 1)
        answers.set(prefix, { ref: prefix, status: "resolved", target: target(hits[0]!) });
    }
  } finally {
    await reader.close();
  }
}

// ── Packages ──────────────────────────────────────────────────────────────

/**
 * `name@version` among the page owner's packages, in feeds the registry lets
 * the viewer read. The same name in two formats is ambiguous.
 */
async function resolvePackages(
  scope: ResolveScope,
  refs: string[],
  ownerSlug: string | undefined,
  answers: Map<string, RefResolution>,
) {
  if (!refs.length || !ownerSlug) return;
  const owner = await db(scope.env.DB)
    .selectFrom("accounts")
    .select(["id", "slug"])
    .where("slug", "=", ownerSlug)
    .executeTakeFirst();
  if (!owner) return;
  const services = new Services(scope.env, scope.request, scope.waitUntil);
  const access = await services.access();
  const feeds: string[] = [];
  for (const feed of await listRepos(services.db, undefined, owner.id))
    if (await access.can(feed, "read")) feeds.push(feed.id);
  if (!feeds.length) return;
  const wanted = refs.map((ref) => {
    const at = ref.lastIndexOf("@");
    return { ref, name: ref.slice(0, at), version: ref.slice(at + 1) };
  });
  const rows = await services.db
    .selectFrom("packages as p")
    .innerJoin("repositories as r", "r.id", "p.repo_id")
    .innerJoin("versions as v", "v.package_id", "p.id")
    .select(["p.name", "p.normalized_name", "r.format", "v.version"])
    .where(sql<boolean>`p.repo_id IN (SELECT value FROM json_each(${JSON.stringify(feeds)}))`)
    .where((eb) =>
      eb.or(
        wanted.map(({ name, version }) =>
          eb.and([
            eb.or([eb("p.name", "=", name), eb("p.normalized_name", "=", name.toLowerCase())]),
            eb.or([eb("v.version", "=", version), eb("v.version", "=", version.replace(/^v/, ""))]),
          ]),
        ),
      ),
    )
    .orderBy("r.format")
    .execute();
  for (const { ref, name, version } of wanted) {
    const hits = rows
      .filter(
        (row) =>
          (row.name === name || row.normalized_name === name.toLowerCase()) &&
          (row.version === version || row.version === version.replace(/^v/, "")) &&
          isFormatId(row.format),
      )
      .map((row): PackageTarget => {
        const format = row.format as keyof typeof FORMATS;
        return {
          kind: "package",
          path: `${packagePath(owner.slug, format, row.name)}?version=${encodeURIComponent(row.version)}`,
          label: `${row.name}@${row.version} · ${FORMATS[format].label}`,
          owner: owner.slug,
          format,
          name: row.name,
          version: row.version,
        };
      });
    // One version per format: a name and version match once in each.
    const distinct = [...new Map(hits.map((hit) => [hit.format, hit])).values()];
    if (distinct.length === 1) answers.set(ref, { ref, status: "resolved", target: distinct[0]! });
    else if (distinct.length > 1)
      answers.set(ref, { ref, status: "ambiguous", candidates: distinct as RefTarget[] });
  }
}
