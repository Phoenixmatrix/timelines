import { readFileSync } from "node:fs";

type Environment = Record<string, string | undefined>;

/**
 * What a deployed Gitmatrix binds: its Worker, domain and every account-wide
 * resource. The canonical deploy is PRODUCTION; `gm instance setup` creates
 * another in any Cloudflare account (several can share one) and writes its
 * file, which `gm instance deploy` hands cf as GITMATRIX_INSTANCE_CONFIG.
 * Durable Objects belong to their Worker, so only names Cloudflare scopes to
 * the account appear here.
 */
export interface Instance {
  /** The instance's slug; "production" for the canonical deploy. */
  name: string;
  host: string;
  worker: string;
  /** D1 databases: names, and the ids the bindings use. */
  db: { name: string; id: string };
  registryDb: { name: string; id: string };
  buckets: { registry: string; avatars: string; stepArtifacts: string };
  /**
   * The general jobs queue and the registry's. worker/index.ts routes a batch
   * by its queue name, so these end in -jobs and -registry-jobs.
   */
  queues: { jobs: string; registryJobs: string };
  /** Workflow names are the account's: a second Worker declaring one redefines it. */
  workflows: { knowledgeBuild: string; ciRun: string; repoPurge: string };
  /** The CI Sandbox's container application. */
  container: string;
  artifacts: string;
  /** Paid AI resources, or null for an instance without AI (the UI shows its AI-off states). */
  ai: { gateway: string; vectors: string; search: string } | null;
  /** The account's Secrets Store, and this instance's secrets in it. */
  secrets: { store: string; registryKek: string; betterAuth: string };
  /** Rate-limit namespace ids are account-wide integers. */
  rateLimitNamespace: string;
  /** Superuser everywhere, and owner of `owner.org`, created on their first sign-in. */
  owner: { email: string; org: string };
  /** Sign-in codes come from this address, on an Email Sending domain of the account. */
  emailFrom: string;
}

/** The canonical deploy, on the "Pile of cats" account. */
export const PRODUCTION: Instance = {
  name: "production",
  host: "timelinesapp.fward.dev",
  worker: "gitmatrix",
  db: { name: "gitmatrix", id: "3ed3e1ec-bd11-4f8e-bfee-d7c0bcb89e77" },
  registryDb: { name: "gitmatrix-registry", id: "caea2f3d-d4d3-43cd-aaf9-f14a3d84621d" },
  buckets: {
    registry: "gitmatrix-registry-blobs",
    avatars: "gitmatrix-avatars",
    stepArtifacts: "gitmatrix-step-artifacts",
  },
  queues: { jobs: "gitmatrix-jobs", registryJobs: "gitmatrix-registry-jobs" },
  workflows: { knowledgeBuild: "knowledge-build", ciRun: "ci-run", repoPurge: "repo-purge" },
  container: "gitmatrix-ci",
  // Dev also talks to the remote Artifacts, Vectorize and AI Search, so
  // production's have production-only names.
  artifacts: "gitmatrix",
  ai: { gateway: "gitmatrix", vectors: "gitmatrix-knowledge-prod", search: "gitmatrix-prod" },
  // Shared with the other ~/dev projects; names are prefixed with the project.
  secrets: {
    store: "2dcc6c92ee1743548ad303924b4e0f11",
    registryKek: "gitmatrix_registry_kek",
    betterAuth: "gitmatrix_better_auth_secret",
  },
  // ~/dev projects use 1001 and 4x01 per project; previews count in 4402.
  rateLimitNamespace: "4401",
  owner: { email: "hello@fward.me", org: "matrixorg" },
  emailFrom: "gitmatrix@mail.fward.dev",
};

/** Set by `gm instance deploy`: the path of the instance file to deploy. */
export const INSTANCE_VARIABLE = "GITMATRIX_INSTANCE_CONFIG";

/** The instance a deploy binds: the file GITMATRIX_INSTANCE_CONFIG names, else production. */
export function deployedInstance(env: Environment): Instance {
  const path = env[INSTANCE_VARIABLE]?.trim();
  if (!path) return PRODUCTION;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${INSTANCE_VARIABLE}=${path} is not a readable instance file: ${reason}`);
  }
  return parseInstance(raw);
}

const SLUG = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SECRET = /^[a-z0-9_]{1,63}$/;
const ID = /^[0-9a-f-]{32,36}$/;

/**
 * Validate an instance file (gm writes it; extra fields are gm's own and
 * ignored) and refuse any name that is production's: a second instance
 * sharing one would bind, or redefine, production's resources.
 */
export function parseInstance(raw: unknown): Instance {
  const problems: string[] = [];
  const at = (path: string): unknown =>
    path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], raw);
  const text = (path: string, pattern: RegExp): string => {
    const value = at(path);
    if (typeof value !== "string" || !pattern.test(value)) {
      problems.push(`${path} must match ${pattern}`);
      return "";
    }
    return value;
  };
  const aiConfigured = at("ai") !== null && at("ai") !== undefined;
  const instance: Instance = {
    name: text("name", SLUG),
    host: text("host", /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
    worker: text("worker", NAME),
    db: { name: text("db.name", NAME), id: text("db.id", ID) },
    registryDb: { name: text("registryDb.name", NAME), id: text("registryDb.id", ID) },
    buckets: {
      registry: text("buckets.registry", NAME),
      avatars: text("buckets.avatars", NAME),
      stepArtifacts: text("buckets.stepArtifacts", NAME),
    },
    queues: {
      jobs: text("queues.jobs", /^[a-z0-9][a-z0-9-]*-jobs$/),
      registryJobs: text("queues.registryJobs", /^[a-z0-9][a-z0-9-]*-registry-jobs$/),
    },
    workflows: {
      knowledgeBuild: text("workflows.knowledgeBuild", NAME),
      ciRun: text("workflows.ciRun", NAME),
      repoPurge: text("workflows.repoPurge", NAME),
    },
    container: text("container", NAME),
    artifacts: text("artifacts", NAME),
    ai: aiConfigured
      ? {
          gateway: text("ai.gateway", NAME),
          vectors: text("ai.vectors", NAME),
          search: text("ai.search", NAME),
        }
      : null,
    secrets: {
      store: text("secrets.store", /^[0-9a-f]{32}$/),
      registryKek: text("secrets.registryKek", SECRET),
      betterAuth: text("secrets.betterAuth", SECRET),
    },
    rateLimitNamespace: text("rateLimitNamespace", /^[1-9][0-9]{0,9}$/),
    owner: {
      email: text("owner.email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/),
      org: text("owner.org", /^[a-z0-9][a-z0-9-]{0,38}$/),
    },
    emailFrom: text("emailFrom", /^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  };
  if (instance.queues.jobs.endsWith("-registry-jobs"))
    problems.push("queues.jobs must not end in -registry-jobs");
  // Timeline previews own gitmatrix-preview-*; instance x's registry names are
  // gitmatrix-x-registry(-jobs) (gm instance setup refuses both too).
  if (instance.name.startsWith("preview-")) problems.push("name must not start with preview-");
  if (instance.name.endsWith("-registry")) problems.push("name must not end in -registry");
  if (problems.length) throw new Error(`Invalid instance file: ${problems.join("; ")}`);
  const shared = sharedWithProduction(instance);
  if (shared.length)
    throw new Error(
      `Instance ${instance.name} reuses production's ${shared.join(", ")}; ` +
        "every account-wide name must be its own.",
    );
  return instance;
}

/** The account-wide names (and the host) an instance shares with production. */
export function sharedWithProduction(instance: Instance): string[] {
  if (instance === PRODUCTION) return [];
  const flat = (value: Instance) => ({
    name: value.name,
    host: value.host,
    worker: value.worker,
    "db.name": value.db.name,
    "db.id": value.db.id,
    "registryDb.name": value.registryDb.name,
    "registryDb.id": value.registryDb.id,
    "buckets.registry": value.buckets.registry,
    "buckets.avatars": value.buckets.avatars,
    "buckets.stepArtifacts": value.buckets.stepArtifacts,
    "queues.jobs": value.queues.jobs,
    "queues.registryJobs": value.queues.registryJobs,
    "workflows.knowledgeBuild": value.workflows.knowledgeBuild,
    "workflows.ciRun": value.workflows.ciRun,
    "workflows.repoPurge": value.workflows.repoPurge,
    container: value.container,
    artifacts: value.artifacts,
    "ai.gateway": value.ai?.gateway,
    "ai.vectors": value.ai?.vectors,
    "ai.search": value.ai?.search,
    "secrets.registryKek": value.secrets.registryKek,
    "secrets.betterAuth": value.secrets.betterAuth,
    rateLimitNamespace: value.rateLimitNamespace,
  });
  const ours = flat(instance);
  const production = new Set(Object.values(flat(PRODUCTION)));
  // Development's remote resources keep their fixed names too.
  for (const name of ["gitmatrix-dev", "gitmatrix-knowledge", "4402"]) production.add(name);
  return Object.entries(ours)
    .filter(([, value]) => value !== undefined && production.has(value))
    .map(([key]) => key);
}
