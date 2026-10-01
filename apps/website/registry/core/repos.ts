import {
  FORMATS,
  isFormatId,
  validRepoKey,
  type FormatId,
  type RepoKind,
  type Visibility,
} from "@gitmatrix/formats/info";
import { z } from "zod";

import { db as gitmatrixDb } from "../../worker/schema.ts";

import { nowIso, parseJson, type DB } from "./db.ts";
import { RegistryError } from "./errors.ts";
import { ulid } from "./ids.ts";
import { seal } from "./seal.ts";

export interface Repository {
  id: string;
  key: string;
  format: FormatId;
  /** gitmatrix account (user or org) that owns the feed. */
  ownerId: string;
  kind: RepoKind;
  visibility: Visibility;
  description: string;
  config: RepoConfig;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VirtualMember {
  repo: Repository;
  position: number;
  include: string[];
  exclude: string[];
}

const RetentionConfig = z
  .object({
    /** Keep at most this many versions per package (oldest pruned first). */
    keepLatest: z.number().int().positive().optional(),
    /** Prune versions (or untagged OCI manifests) older than this. */
    maxAgeDays: z.number().int().positive().optional(),
    /** OCI: delete manifests no tag points at. */
    deleteUntagged: z.boolean().optional(),
  })
  .strict();

export const RepoConfigSchema = z
  .object({
    // local
    /** Refuse to overwrite a published version or file (default true). */
    immutable: z.boolean().optional(),
    retention: RetentionConfig.optional(),
    /** Largest single upload accepted, in bytes. */
    maxUploadBytes: z.number().int().positive().optional(),
    /** apt: distributions and components offered in Release files. */
    apt: z
      .object({
        distributions: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)).optional(),
        components: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)).optional(),
        origin: z.string().max(100).optional(),
        label: z.string().max(100).optional(),
      })
      .optional(),
    /** Signing key algorithm for apt/rpm metadata. */
    signingAlgorithm: z.enum(["rsa4096", "ed25519"]).optional(),
    /** brew: tap name (the `<name>` in `homebrew-<name>`). */
    tapName: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    // remote
    upstream: z.url().optional(),
    upstreamUsername: z.string().max(200).optional(),
    /** Sealed with the KEK; never returned by the API. */
    upstreamPasswordSealed: z.string().optional(),
    metadataTtlSeconds: z
      .number()
      .int()
      .min(0)
      .max(86_400 * 7)
      .optional(),
    negativeTtlSeconds: z.number().int().min(0).max(86_400).optional(),
    /** Allow plain-http upstreams (off by default). */
    allowInsecureUpstream: z.boolean().optional(),
    // virtual
    /** Local member that receives publishes sent to the virtual repository. */
    defaultDeployRepo: z.string().optional(),
    /** Names only ever resolved from local members (dependency-confusion guard). */
    pinnedNamespaces: z.array(z.string().min(1).max(200)).optional(),
    /** Merge versions across members instead of first-owner-wins. */
    mergeVersions: z.boolean().optional(),
  })
  .strict();

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

type Row = {
  id: string;
  key: string;
  format: string;
  owner_id: string;
  kind: RepoKind;
  visibility: Visibility;
  description: string;
  config: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

function fromRow(row: Row): Repository {
  if (!isFormatId(row.format)) throw new Error(`unknown format ${row.format}`);
  return {
    id: row.id,
    key: row.key,
    format: row.format,
    ownerId: row.owner_id,
    kind: row.kind,
    visibility: row.visibility,
    description: row.description,
    config: parseJson<RepoConfig>(row.config, {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { repo: Repository | null; until: number }>();

export function invalidateRepoCache(format?: string, key?: string): void {
  if (format && key) cache.delete(`${format}:${key}`);
  else cache.clear();
}

/** Feed keys are unique per format: `orbit` is both orbit's npm and its docker registry. */
export async function getRepoByKey(
  db: DB,
  format: FormatId,
  key: string,
): Promise<Repository | null> {
  const cacheKey = `${format}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.repo;
  const row = await db
    .selectFrom("repositories")
    .selectAll()
    .where("format", "=", format)
    .where("key", "=", key)
    .executeTakeFirst();
  const repo = row ? fromRow(row as Row) : null;
  if (cache.size > 2_000) cache.clear();
  cache.set(cacheKey, { repo, until: Date.now() + CACHE_TTL_MS });
  return repo;
}

/**
 * The feed for a request. An owner's own feed in any format (key = their
 * slug) exists from the moment it is first used: nobody provisions registries.
 * Remote and virtual feeds (`<owner>.<name>`) are created by their owner.
 */
export async function resolveFeed(
  services: { db: DB; env: Env },
  format: FormatId,
  key: string,
): Promise<Repository | null> {
  const existing = await getRepoByKey(services.db, format, key);
  if (existing) return existing;
  if (!FORMATS[format].kinds.includes("local") || key.includes(".")) return null;
  const owner = await gitmatrixDb(services.env.DB)
    .selectFrom("accounts")
    .select(["id", "slug"])
    .where("slug", "=", key)
    .executeTakeFirst();
  if (!owner || owner.slug.toLowerCase() !== key) return null;
  const now = nowIso();
  await services.db
    .insertInto("repositories")
    .values({
      id: ulid(),
      key,
      format,
      owner_id: owner.id,
      kind: "local",
      visibility: "private",
      description: "",
      config: "{}",
      created_by: "system",
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(["format", "key"]).doNothing())
    .execute();
  invalidateRepoCache(format, key);
  return getRepoByKey(services.db, format, key);
}

export async function getRepoById(db: DB, id: string): Promise<Repository | null> {
  const row = await db
    .selectFrom("repositories")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? fromRow(row as Row) : null;
}

export async function listRepos(
  db: DB,
  format?: FormatId,
  ownerId?: string,
): Promise<Repository[]> {
  let query = db.selectFrom("repositories").selectAll().orderBy("key");
  if (format) query = query.where("format", "=", format);
  if (ownerId) query = query.where("owner_id", "=", ownerId);
  return (await query.execute()).map((row) => fromRow(row as Row));
}

export const CreateRepoInput = z.object({
  key: z.string(),
  format: z.string(),
  ownerId: z.string(),
  kind: z.enum(["local", "remote", "virtual"]),
  visibility: z.enum(["public", "internal", "private"]),
  description: z.string().max(500).default(""),
  config: RepoConfigSchema.default({}),
  members: z
    .array(
      z.object({
        key: z.string(),
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
export type CreateRepoInput = z.input<typeof CreateRepoInput>;

function validateShape(format: FormatId, kind: RepoKind, config: RepoConfig): void {
  if (!FORMATS[format].kinds.includes(kind)) {
    throw RegistryError.badRequest(
      `${FORMATS[format].label} does not support ${kind} repositories`,
    );
  }
  if (kind === "remote") {
    if (!config.upstream)
      throw RegistryError.badRequest("Remote repositories need an upstream URL");
    const upstream = new URL(config.upstream);
    if (upstream.protocol !== "https:" && !config.allowInsecureUpstream) {
      throw RegistryError.badRequest("Upstream must use https");
    }
  } else if (config.upstream) {
    throw RegistryError.badRequest("Only remote repositories have an upstream");
  }
}

export async function createRepo(
  db: DB,
  raw: CreateRepoInput,
  createdBy: string | null,
): Promise<Repository> {
  const input = CreateRepoInput.parse(raw);
  if (!validRepoKey(input.key)) {
    throw new RegistryError(
      "name_invalid",
      "Repository keys are 1-64 lowercase letters, digits, '.', '_' or '-'",
    );
  }
  if (!isFormatId(input.format)) throw RegistryError.badRequest(`Unknown format ${input.format}`);
  validateShape(input.format, input.kind, input.config);
  if (await getRepoByKeyUncached(db, input.format, input.key)) {
    throw RegistryError.conflict(`Feed ${input.key} already exists`);
  }
  const now = nowIso();
  const id = ulid();
  await db
    .insertInto("repositories")
    .values({
      id,
      key: input.key,
      format: input.format,
      owner_id: input.ownerId,
      kind: input.kind,
      visibility: input.visibility,
      description: input.description,
      config: JSON.stringify(input.config),
      created_by: createdBy,
      created_at: now,
      updated_at: now,
    })
    .execute();
  if (input.kind === "virtual") await setVirtualMembers(db, id, input.format, input.members);
  invalidateRepoCache(input.format, input.key);
  return (await getRepoById(db, id))!;
}

async function getRepoByKeyUncached(
  db: DB,
  format: FormatId,
  key: string,
): Promise<Repository | null> {
  invalidateRepoCache(format, key);
  return getRepoByKey(db, format, key);
}

export const UpdateRepoInput = z.object({
  visibility: z.enum(["public", "internal", "private"]).optional(),
  description: z.string().max(500).optional(),
  config: RepoConfigSchema.optional(),
  // Not CreateRepoInput's field: its `.default([])` would turn an omitted
  // `members` into "remove every member".
  members: z
    .array(
      z.object({
        key: z.string(),
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
      }),
    )
    .optional(),
});
export type UpdateRepoInput = z.input<typeof UpdateRepoInput>;

export async function updateRepo(
  db: DB,
  repo: Repository,
  raw: UpdateRepoInput,
): Promise<Repository> {
  const input = UpdateRepoInput.parse(raw);
  const config = input.config ? { ...input.config } : repo.config;
  // Sealed credentials are write-only: keep the stored one unless replaced.
  if (input.config && !input.config.upstreamPasswordSealed && repo.config.upstreamPasswordSealed) {
    config.upstreamPasswordSealed = repo.config.upstreamPasswordSealed;
  }
  validateShape(repo.format, repo.kind, config);
  await db
    .updateTable("repositories")
    .set({
      visibility: input.visibility ?? repo.visibility,
      description: input.description ?? repo.description,
      config: JSON.stringify(config),
      updated_at: nowIso(),
    })
    .where("id", "=", repo.id)
    .execute();
  if (repo.kind === "virtual" && input.members) {
    await setVirtualMembers(db, repo.id, repo.format, input.members);
  }
  invalidateRepoCache(repo.format, repo.key);
  return (await getRepoById(db, repo.id))!;
}

export async function deleteRepo(db: DB, repo: Repository): Promise<void> {
  await db.deleteFrom("repositories").where("id", "=", repo.id).execute();
  invalidateRepoCache(repo.format, repo.key);
}

async function setVirtualMembers(
  db: DB,
  virtualId: string,
  format: FormatId,
  members: { key: string; include: string[]; exclude: string[] }[],
): Promise<void> {
  const resolved: { id: string; include: string[]; exclude: string[] }[] = [];
  for (const member of members) {
    const repo = await getRepoByKeyUncached(db, format, member.key);
    if (!repo) throw RegistryError.badRequest(`No repository ${member.key}`);
    if (repo.format !== format) throw RegistryError.badRequest(`${member.key} is not ${format}`);
    if (repo.kind === "virtual") throw RegistryError.badRequest("Virtual repositories cannot nest");
    if (repo.id === virtualId) throw RegistryError.badRequest("A repository cannot include itself");
    resolved.push({ id: repo.id, include: member.include, exclude: member.exclude });
  }
  await db.deleteFrom("virtual_members").where("virtual_id", "=", virtualId).execute();
  for (const [position, member] of resolved.entries()) {
    await db
      .insertInto("virtual_members")
      .values({
        virtual_id: virtualId,
        member_id: member.id,
        position,
        include_patterns: JSON.stringify(member.include),
        exclude_patterns: JSON.stringify(member.exclude),
      })
      .execute();
  }
}

export async function virtualMembers(db: DB, virtualId: string): Promise<VirtualMember[]> {
  const rows = await db
    .selectFrom("virtual_members as m")
    .innerJoin("repositories as r", "r.id", "m.member_id")
    .selectAll("r")
    .select(["m.position", "m.include_patterns", "m.exclude_patterns"])
    .where("m.virtual_id", "=", virtualId)
    .orderBy("m.position")
    .execute();
  return rows.map((row) => ({
    repo: fromRow(row as unknown as Row),
    position: row.position,
    include: parseJson<string[]>(row.include_patterns, []),
    exclude: parseJson<string[]>(row.exclude_patterns, []),
  }));
}

/**
 * Feed settings as people send them: a plain `upstreamPassword` is sealed
 * with the registry key before it is stored, and never returned.
 */
export async function sealConfig<T extends { config?: Record<string, unknown> }>(
  env: object,
  input: T,
): Promise<T> {
  const password = input.config?.upstreamPassword;
  if (!input.config || password === undefined) return input;
  const { upstreamPassword: _plain, ...config } = input.config;
  return {
    ...input,
    config:
      typeof password === "string" && password
        ? { ...config, upstreamPasswordSealed: await seal(env, password) }
        : config,
  };
}

/** A redacted copy safe to hand to clients. */
export function publicRepo(repo: Repository): Repository {
  const { upstreamPasswordSealed, ...config } = repo.config;
  return {
    ...repo,
    config: upstreamPasswordSealed ? { ...config, upstreamPasswordSealed: "********" } : config,
  };
}
