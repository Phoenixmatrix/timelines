// The artifact store's management side, in gitmatrix's terms: an owner's
// packages and feeds, a package's console, its sources, housekeeping,
// proxies and virtual feeds, and what a commit or CI run published.

import { FORMATS, isFormatId, type FormatId } from "@gitmatrix/formats/info";
import { sql } from "kysely";

import type {
  BulkActionRequest,
  BulkActionResult,
  CreateFeedRequest,
  FeedSummary,
  NpmLoginRequest,
  OwnerPackages,
  PackageAccess,
  PackageDetail,
  PackageSource,
  PackageSummary,
  Published,
  PublishPage,
  PublishStatus,
  UpdateFeedRequest,
} from "../../shared/packages.ts";
import { issueToken } from "../../worker/api/tokens.ts";
import { avatarUrl } from "../../worker/avatars/api.ts";
import { db as gitmatrixDb } from "../../worker/schema.ts";
import { purgeInstance } from "../../worker/durable/registry.ts";
import type { AccessControl } from "../core/acl.ts";
import { loginObject, type Services } from "../core/context.ts";
import { nowIso } from "../core/db.ts";
import { RegistryError } from "../core/errors.ts";
import { audit } from "../core/audit.ts";
import { authorizePublish, requireMovesLatest } from "../core/provenance.ts";
import { principalOf } from "../core/auth/actor.ts";
import type { PackageRow } from "../core/catalog.ts";
import {
  createRepo,
  deleteRepo,
  getRepoById,
  getRepoByKey,
  listRepos,
  sealConfig,
  updateRepo,
  virtualMembers,
  type Repository,
} from "../core/repos.ts";
import { completeNpmLogin } from "../formats/npm/login.ts";
import { matchingVersions, queryPublishes, type Directory, type Scope } from "./query.ts";
import { actionsFor, applyToVersions } from "./versions.ts";

interface Owner {
  id: string;
  slug: string;
  displayName: string;
  kind: "user" | "org";
  avatarUrl: string | null;
}

async function findOwner(services: Services, slug: string): Promise<Owner> {
  const row = await gitmatrixDb(services.env.DB)
    .selectFrom("accounts")
    .select(["id", "slug", "display_name", "kind", "avatar_key"])
    .where("slug", "=", slug)
    .executeTakeFirst();
  if (!row) throw RegistryError.notFound(`No account ${slug}.`);
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    kind: row.kind,
    avatarUrl: avatarUrl(row.avatar_key),
  };
}

async function ownerAccess(access: AccessControl, ownerId: string): Promise<PackageAccess | null> {
  if (await access.isAdmin()) return "admin";
  return access.roleForOwner(ownerId);
}

async function feedAccess(access: AccessControl, feed: Repository): Promise<PackageAccess | null> {
  if (await access.can(feed, "admin")) return "admin";
  if (await access.can(feed, "write")) return "write";
  if (await access.can(feed, "read")) return "read";
  return null;
}

/** gitmatrix repositories, as the console's query and sources name them. */
export function directory(services: Services, owner: { slug: string }): Directory {
  const names = new Map<string, string>();
  return {
    async repoIds(value) {
      const [ownerSlug, name] = value.includes("/") ? value.split("/", 2) : [owner.slug, value];
      const results = await gitmatrixDb(services.env.DB)
        .selectFrom("repos as r")
        .innerJoin("accounts as o", "o.id", "r.owner_id")
        .select("r.id")
        .where("o.slug", "=", ownerSlug ?? "")
        .where("r.name", "=", name ?? "")
        .execute();
      return results.map((r) => r.id);
    },
    async repoNames(ids) {
      const missing = ids.filter((id) => !names.has(id));
      for (let i = 0; i < missing.length; i += 90) {
        const chunk = missing.slice(i, i + 90);
        const results = await gitmatrixDb(services.env.DB)
          .selectFrom("repos as r")
          .innerJoin("accounts as o", "o.id", "r.owner_id")
          .select(["r.id", "r.name", "o.slug"])
          .where("r.id", "in", chunk)
          .execute();
        for (const row of results) names.set(row.id, `${row.slug}/${row.name}`);
      }
      return new Map(ids.filter((id) => names.has(id)).map((id) => [id, names.get(id)!]));
    },
  };
}

async function feedSummaries(services: Services, feeds: Repository[]): Promise<FeedSummary[]> {
  if (feeds.length === 0) return [];
  const counts = await services.db
    .selectFrom("packages")
    .select(["repo_id", (eb) => eb.fn.countAll<number>().as("n")])
    .where(
      "repo_id",
      "in",
      feeds.map((f) => f.id),
    )
    .groupBy("repo_id")
    .execute();
  const count = new Map(counts.map((c) => [c.repo_id, Number(c.n)]));
  return Promise.all(
    feeds.map(async (feed) => ({
      id: feed.id,
      key: feed.key,
      format: feed.format,
      kind: feed.kind,
      visibility: feed.visibility,
      description: feed.description,
      upstream: feed.config.upstream ?? null,
      members:
        feed.kind === "virtual"
          ? (await virtualMembers(services.db, feed.id)).map((m) => m.repo.key)
          : [],
      retention: feed.config.retention ?? {},
      packages: count.get(feed.id) ?? 0,
    })),
  );
}

const HOUR = 3_600_000;

async function packageSummaries(
  services: Services,
  feeds: Repository[],
  owner: { slug: string },
  only?: string[],
): Promise<PackageSummary[]> {
  const local = feeds.filter((f) => f.kind === "local");
  if (local.length === 0) return [];
  const byId = new Map(local.map((f) => [f.id, f]));
  let query = services.db
    .selectFrom("packages as p")
    .select([
      "p.id",
      "p.name",
      "p.repo_id",
      // What `latest` points at where the format has tags, else the newest
      // installable that wasn't published from a non-default branch.
      sql<string | null>`coalesce(
        (select t.version from dist_tags t where t.package_id = p.id and t.tag = 'latest'),
        (select x.version from publishes x where x.package_id = p.id and x.status = 'active'
         and x.off_default_branch = 0 order by x.at desc limit 1))`.as("latest"),
      (eb) =>
        eb
          .selectFrom("publishes as x")
          .select((e) => e.fn.max("x.at").as("at"))
          .whereRef("x.package_id", "=", "p.id")
          .as("last_at"),
      (eb) =>
        eb
          .selectFrom("publishes as x")
          .select((e) => e.fn.count<number>("x.version").distinct().as("n"))
          .whereRef("x.package_id", "=", "p.id")
          .where("x.status", "=", "active")
          .as("versions"),
    ])
    .where(
      "p.repo_id",
      "in",
      local.map((f) => f.id),
    );
  if (only) query = query.where("p.id", "in", only);
  const rows = await query.execute();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const now = Date.now();
  const start = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  const startIso = new Date(start).toISOString();
  const spark = new Map<string, number[]>();
  const sources = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const [hours, granted] = await Promise.all([
      services.db
        .selectFrom("publishes")
        .select([
          "package_id",
          sql<number>`cast((julianday(at) - julianday(${startIso})) * 24 as integer)`.as("h"),
          (eb) => eb.fn.countAll<number>().as("n"),
        ])
        .where("package_id", "in", chunk)
        .where("at", ">=", startIso)
        .groupBy(["package_id", "h"])
        .execute(),
      services.db
        .selectFrom("package_sources")
        .select(["package_id", "git_repo_id"])
        .where("package_id", "in", chunk)
        .orderBy("granted_at")
        .execute(),
    ]);
    for (const row of hours) {
      const series = spark.get(row.package_id) ?? Array.from({ length: 24 }, () => 0);
      const h = Number(row.h);
      if (h >= 0 && h < 24) series[h] = (series[h] ?? 0) + Number(row.n);
      spark.set(row.package_id, series);
    }
    const names = await directory(services, owner).repoNames([
      ...new Set(granted.map((g) => g.git_repo_id)),
    ]);
    for (const g of granted) {
      const name = names.get(g.git_repo_id);
      if (name) sources.set(g.package_id, [...(sources.get(g.package_id) ?? []), name]);
    }
  }

  return rows
    .map((row): PackageSummary => {
      const feed = byId.get(row.repo_id)!;
      const series = spark.get(row.id) ?? Array.from({ length: 24 }, () => 0);
      return {
        id: row.id,
        format: feed.format,
        name: row.name,
        feed: feed.key,
        latest: (row.latest as string | null) ?? null,
        lastPublishedAt: (row.last_at as string | null) ?? null,
        versions: Number(row.versions ?? 0),
        publishes24h: series.reduce((a, b) => a + b, 0),
        spark: series,
        sources: sources.get(row.id) ?? [],
      };
    })
    .sort((a, b) => (b.lastPublishedAt ?? "").localeCompare(a.lastPublishedAt ?? ""));
}

async function visibleFeeds(services: Services, ownerId: string): Promise<Repository[]> {
  const access = await services.access();
  const feeds = await listRepos(services.db, undefined, ownerId);
  const visible: Repository[] = [];
  for (const feed of feeds) if (await access.can(feed, "read")) visible.push(feed);
  return visible;
}

export async function ownerPackages(services: Services, slug: string): Promise<OwnerPackages> {
  const owner = await findOwner(services, slug);
  const access = await services.access();
  const feeds = await visibleFeeds(services, owner.id);
  return {
    owner,
    access: await ownerAccess(access, owner.id),
    registryUrl: services.baseUrl,
    packages: await packageSummaries(services, feeds, owner),
    feeds: await feedSummaries(services, feeds),
  };
}

export interface Located {
  owner: Owner;
  feed: Repository;
  pkg: PackageRow;
  access: PackageAccess;
}

export async function locate(
  services: Services,
  slug: string,
  format: string,
  name: string,
): Promise<Located> {
  if (!isFormatId(format)) throw RegistryError.notFound(`Unknown format ${format}.`);
  const owner = await findOwner(services, slug);
  const feed = await getRepoByKey(services.db, format, owner.slug.toLowerCase());
  const access = await services.access();
  const level = feed ? await feedAccess(access, feed) : null;
  const missing = RegistryError.notFound(
    `${owner.slug} has no ${FORMATS[format].label} package ${name}.`,
  );
  if (!feed || !level) {
    if (feed && access.actor.kind === "anonymous") throw RegistryError.unauthorized();
    throw missing;
  }
  const row = await services.db
    .selectFrom("packages")
    .selectAll()
    .where("repo_id", "=", feed.id)
    .where((eb) => eb.or([eb("name", "=", name), eb("normalized_name", "=", name.toLowerCase())]))
    .executeTakeFirst();
  if (!row) throw missing;
  const pkg: PackageRow = {
    id: row.id,
    repoId: row.repo_id,
    name: row.name,
    normalizedName: row.normalized_name,
    metadata: JSON.parse(row.metadata || "{}") as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return { owner, feed, pkg, access: level };
}

export async function packageDetail(
  services: Services,
  slug: string,
  format: string,
  name: string,
): Promise<PackageDetail> {
  const { owner, feed, pkg, access } = await locate(services, slug, format, name);
  const [[summary], [feedSummary], tags, totals, sources] = await Promise.all([
    packageSummaries(services, [feed], owner, [pkg.id]),
    feedSummaries(services, [feed]),
    services.db
      .selectFrom("dist_tags")
      .select(["tag", "version"])
      .where("package_id", "=", pkg.id)
      .execute(),
    services.db
      .selectFrom("publishes")
      .select((eb) => [
        eb.fn.countAll<number>().as("publishes"),
        eb.fn
          .sum<number>(eb.case().when("status", "=", "active").then(1).else(0).end())
          .as("active"),
        eb.fn.min("at").as("first"),
      ])
      .where("package_id", "=", pkg.id)
      .executeTakeFirst(),
    packageSources(services, owner, pkg.id),
  ]);
  return {
    package: summary!,
    feed: feedSummary!,
    owner,
    registryUrl: services.baseUrl,
    access,
    tags: Object.fromEntries(tags.map((t) => [t.tag, t.version])),
    sources,
    actions:
      access === "read"
        ? []
        : actionsFor(feed.format).filter((a) => a !== "delete" || access === "admin"),
    totals: {
      publishes: Number(totals?.publishes ?? 0),
      active: Number(totals?.active ?? 0),
      firstPublishedAt: (totals?.first as string | null) ?? null,
    },
  };
}

async function packageSources(
  services: Services,
  owner: { slug: string },
  packageId: string,
): Promise<PackageSource[]> {
  const [granted, usage] = await Promise.all([
    services.db
      .selectFrom("package_sources")
      .selectAll()
      .where("package_id", "=", packageId)
      .orderBy("granted_at")
      .execute(),
    services.db
      .selectFrom("publishes")
      .select([
        "git_repo_id",
        (eb) => eb.fn.countAll<number>().as("n"),
        (eb) => eb.fn.max("at").as("last"),
      ])
      .where("package_id", "=", packageId)
      .where("git_repo_id", "is not", null)
      .groupBy("git_repo_id")
      .execute(),
  ]);
  const names = await directory(services, owner).repoNames(granted.map((g) => g.git_repo_id));
  const used = new Map(usage.map((u) => [u.git_repo_id, u]));
  return granted.map((g) => ({
    repoId: g.git_repo_id,
    repo: names.get(g.git_repo_id) ?? null,
    grantedBy: g.granted_by,
    grantedAt: g.granted_at,
    publishes: Number(used.get(g.git_repo_id)?.n ?? 0),
    lastPublishedAt: (used.get(g.git_repo_id)?.last as string | null) ?? null,
  }));
}

export async function packagePublishes(
  services: Services,
  slug: string,
  format: string,
  name: string,
  options: { query: string; offset: number; limit: number },
): Promise<PublishPage> {
  const { owner, feed, pkg } = await locate(services, slug, format, name);
  return queryPublishes(services.db, scopeOf(feed, pkg), directory(services, owner), options);
}

function scopeOf(feed: Repository, pkg: PackageRow): Scope {
  return { packageId: pkg.id, tagsAreVersions: feed.format === "oci" };
}

const BULK_LIMIT = 1000;

export async function bulkAction(
  services: Services,
  slug: string,
  format: string,
  name: string,
  request: BulkActionRequest,
): Promise<BulkActionResult> {
  const { owner, feed, pkg } = await locate(services, slug, format, name);
  const access = await services.access();
  if (request.action === "delete") await access.require(feed, "delete");
  else {
    await access.require(feed, "write");
    // Changing a package is publishing it: its sources' writers, or owner admins.
    await authorizePublish(services.db, { id: pkg.id, name: pkg.name, repoId: feed.id });
    if (request.action === "tag" && request.tag === "latest") requireMovesLatest(access.actor);
  }
  let versions: string[];
  let remaining = 0;
  if (request.versions?.length) {
    versions = [...new Set(request.versions)].slice(0, BULK_LIMIT);
    remaining = Math.max(0, new Set(request.versions).size - versions.length);
  } else if (request.query !== undefined) {
    const matched = await matchingVersions(
      services.db,
      scopeOf(feed, pkg),
      directory(services, owner),
      request.query,
      BULK_LIMIT,
    );
    versions = matched.versions;
    remaining = matched.total - versions.length;
  } else {
    throw RegistryError.badRequest("Send the versions, or a query that selects them.");
  }
  const result = await applyToVersions({ services, feed, pkg }, request.action, versions, {
    ...(request.tag ? { tag: request.tag } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
  });
  return { ...result, remaining };
}

export async function grantSource(
  services: Services,
  slug: string,
  format: string,
  name: string,
  repo: string,
): Promise<PackageSource[]> {
  const { owner, feed, pkg } = await locate(services, slug, format, name);
  const access = await services.access();
  await access.require(feed, "admin");
  const ids = await directory(services, owner).repoIds(repo);
  if (ids.length !== 1) throw RegistryError.notFound(`No repository ${repo}.`);
  await services.db
    .insertInto("package_sources")
    .values({
      package_id: pkg.id,
      git_repo_id: ids[0]!,
      granted_by: principalOf(access.actor),
      granted_at: nowIso(),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await audit(services.db, access.actor, "package.source.grant", {
    repoId: feed.id,
    target: pkg.name,
    detail: { repo },
  });
  return packageSources(services, owner, pkg.id);
}

export async function revokeSource(
  services: Services,
  slug: string,
  format: string,
  name: string,
  repoId: string,
): Promise<PackageSource[]> {
  const { owner, feed, pkg } = await locate(services, slug, format, name);
  const access = await services.access();
  await access.require(feed, "admin");
  await services.db
    .deleteFrom("package_sources")
    .where("package_id", "=", pkg.id)
    .where("git_repo_id", "=", repoId)
    .execute();
  await audit(services.db, access.actor, "package.source.revoke", {
    repoId: feed.id,
    target: pkg.name,
    detail: { repoId },
  });
  return packageSources(services, owner, pkg.id);
}

// ── Feeds: the owner's registries, proxies and virtual feeds ──────────────

async function requireOwnerAdmin(services: Services, owner: Owner): Promise<AccessControl> {
  const access = await services.access();
  if (access.actor.kind === "anonymous") throw RegistryError.unauthorized();
  if (
    (await ownerAccess(access, owner.id)) !== "admin" ||
    !access.actor.scopes.has("packages:admin")
  ) {
    throw RegistryError.denied(`Only ${owner.slug}'s admins manage its feeds.`);
  }
  return access;
}

const FEED_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export async function createFeed(
  services: Services,
  slug: string,
  request: CreateFeedRequest,
): Promise<FeedSummary> {
  const owner = await findOwner(services, slug);
  const access = await requireOwnerAdmin(services, owner);
  if (!FEED_NAME.test(request.name ?? "")) {
    throw RegistryError.badRequest("Feed names are lowercase letters, digits, '-' and '_'.");
  }
  const key = `${owner.slug.toLowerCase()}.${request.name}`;
  const input = await sealConfig(services.env, {
    key,
    format: request.format,
    ownerId: owner.id,
    kind: request.kind,
    visibility: request.visibility ?? "private",
    description: request.description ?? "",
    config:
      request.kind === "remote"
        ? {
            upstream: request.upstream || FORMATS[request.format]?.defaultUpstream,
            ...(request.upstreamUsername ? { upstreamUsername: request.upstreamUsername } : {}),
            ...(request.upstreamPassword ? { upstreamPassword: request.upstreamPassword } : {}),
          }
        : {},
    members: (request.members ?? []).map((m) => ({ key: m, include: [], exclude: [] })),
  });
  const feed = await createRepo(services.db, input as never, principalOf(access.actor));
  await audit(services.db, access.actor, "feed.create", {
    repoId: feed.id,
    target: key,
    detail: { kind: feed.kind, format: feed.format },
  });
  return (await feedSummaries(services, [feed]))[0]!;
}

async function ownedFeed(services: Services, owner: Owner, format: string, key: string) {
  if (!isFormatId(format)) throw RegistryError.notFound(`Unknown format ${format}.`);
  const feed = await getRepoByKey(services.db, format as FormatId, key);
  if (!feed || feed.ownerId !== owner.id) throw RegistryError.notFound(`No feed ${key}.`);
  return feed;
}

export async function updateFeed(
  services: Services,
  slug: string,
  format: string,
  key: string,
  request: UpdateFeedRequest,
): Promise<FeedSummary> {
  const owner = await findOwner(services, slug);
  const access = await requireOwnerAdmin(services, owner);
  const feed = await ownedFeed(services, owner, format, key);
  const config: Record<string, unknown> = { ...feed.config };
  if (request.retention) {
    const retention = Object.fromEntries(
      Object.entries(request.retention).filter(([, v]) => v !== undefined && v !== null && v !== 0),
    );
    if (Object.keys(retention).length) config.retention = retention;
    else delete config.retention;
  }
  if (request.upstream !== undefined) config.upstream = request.upstream;
  if (request.upstreamUsername !== undefined) config.upstreamUsername = request.upstreamUsername;
  if (request.upstreamPassword) config.upstreamPassword = request.upstreamPassword;
  const input = await sealConfig(services.env, {
    ...(request.visibility ? { visibility: request.visibility } : {}),
    ...(request.description !== undefined ? { description: request.description } : {}),
    config,
    ...(request.members
      ? { members: request.members.map((m) => ({ key: m, include: [], exclude: [] })) }
      : {}),
  });
  const updated = await updateRepo(services.db, feed, input as never);
  await audit(services.db, access.actor, "feed.update", {
    repoId: feed.id,
    target: key,
    detail: { fields: Object.keys(request) },
  });
  return (await feedSummaries(services, [updated]))[0]!;
}

export async function removeFeed(
  services: Services,
  slug: string,
  format: string,
  key: string,
): Promise<void> {
  const owner = await findOwner(services, slug);
  const access = await requireOwnerAdmin(services, owner);
  const feed = await ownedFeed(services, owner, format, key);
  if (feed.kind === "local") {
    throw RegistryError.badRequest("An owner's own registry stays; delete its packages instead.");
  }
  await deleteRepo(services.db, feed);
  await audit(services.db, access.actor, "feed.delete", { target: key });
  // Its Durable Object (indexes, leases) goes with it (CORE-205). The feed is
  // gone either way; a failure leaves the instance in the registry's list.
  await purgeInstance(services.env, "RegistryRepo", feed.id, "registry repository deleted").catch(
    (error: unknown) => console.error("Registry: purging a deleted feed's object failed", error),
  );
}

// ── What a commit or a run published ──────────────────────────────────────

export async function published(
  services: Services,
  repo: string,
  where: { commit?: string; run?: number },
): Promise<Published> {
  const [ownerSlug] = repo.split("/");
  const ids = await directory(services, { slug: ownerSlug ?? "" }).repoIds(repo);
  if (ids.length !== 1) return { rows: [] };
  let query = services.db
    .selectFrom("publishes as x")
    .innerJoin("packages as p", "p.id", "x.package_id")
    .selectAll("x")
    .select(["p.name as package_name"])
    .where("x.git_repo_id", "=", ids[0]!)
    .orderBy("x.at", "desc")
    .limit(200);
  if (where.commit) query = query.where("x.commit_oid", "=", where.commit);
  else if (where.run !== undefined) query = query.where("x.run_number", "=", where.run);
  else return { rows: [] };
  const rows = await query.execute();
  const access = await services.access();
  const feeds = new Map<string, Repository | null>();
  const out: Published["rows"] = [];
  for (const row of rows) {
    if (!feeds.has(row.feed_id)) {
      const feed = await getRepoById(services.db, row.feed_id);
      feeds.set(row.feed_id, feed && (await access.can(feed, "read")) ? feed : null);
    }
    const feed = feeds.get(row.feed_id);
    if (!feed) continue;
    out.push({
      id: row.id,
      format: feed.format,
      package: row.package_name,
      feed: feed.key,
      version: row.version,
      status: row.status as PublishStatus,
      digest: row.digest,
      size: row.size,
      at: row.at,
      repo,
      ref: row.ref,
      commit: row.commit_oid,
      runNumber: row.run_number,
      actor: row.actor_label,
      via: row.via,
      tags: [],
    });
  }
  return { rows: out };
}

// ── npm login from the browser ────────────────────────────────────────────

export async function npmLogin(services: Services, publicId: string): Promise<NpmLoginRequest> {
  const state = await loginObject(services.env, publicId).peek();
  if (!state) throw RegistryError.notFound("This login link expired. Run npm login again.");
  return {
    publicId,
    hostname: state.hostname ?? null,
    registry: state.repo,
    status:
      state.status === "pending" && state.expiresAt > Date.now()
        ? "pending"
        : state.status === "pending"
          ? "expired"
          : "done",
  };
}

export async function approveNpmLogin(services: Services, publicId: string): Promise<void> {
  const access = await services.access();
  const actor = access.actor;
  if (actor.kind !== "user" || actor.via !== "session" || !actor.subject) {
    throw RegistryError.unauthorized("Sign in to approve npm logins.");
  }
  const state = await npmLogin(services, publicId);
  if (state.status !== "pending")
    throw RegistryError.conflict("This login was already used or expired.");
  const token = await issueToken(
    services.env.DB,
    actor.subject,
    `npm login${state.hostname ? ` on ${state.hostname}` : ""}`,
    "write",
  );
  if (!(await completeNpmLogin(services.env, publicId, token.secret))) {
    throw RegistryError.conflict("This login was already used or expired.");
  }
  await audit(services.db, actor, "npm.login", {
    detail: { flow: "web", registry: state.registry },
  });
}

// ── A repository's packages: what it is a source of, or has published ─────

export async function repoPackages(services: Services, repo: string): Promise<PackageSummary[]> {
  const [ownerSlug] = repo.split("/");
  const owner = { slug: ownerSlug ?? "" };
  const ids = await directory(services, owner).repoIds(repo);
  if (ids.length !== 1) return [];
  const repoId = ids[0]!;
  const rows = await services.db
    .selectFrom("packages as p")
    .select(["p.id", "p.repo_id"])
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom("package_sources as s")
            .select("s.package_id")
            .whereRef("s.package_id", "=", "p.id")
            .where("s.git_repo_id", "=", repoId),
        ),
        eb.exists(
          eb
            .selectFrom("publishes as x")
            .select("x.id")
            .whereRef("x.package_id", "=", "p.id")
            .where("x.git_repo_id", "=", repoId),
        ),
      ]),
    )
    .execute();
  if (rows.length === 0) return [];
  const access = await services.access();
  const feeds: Repository[] = [];
  for (const feedId of new Set(rows.map((r) => r.repo_id))) {
    const feed = await getRepoById(services.db, feedId);
    if (feed && (await access.can(feed, "read"))) feeds.push(feed);
  }
  return packageSummaries(
    services,
    feeds,
    owner,
    rows.map((r) => r.id),
  );
}
