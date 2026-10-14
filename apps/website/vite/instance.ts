import { readFileSync } from "node:fs";

type Environment = Record<string, string | undefined>;

/** This process's environment, where there is one (cf evaluates the config in Node). */
function processEnv(): Environment {
  const runtime = globalThis as { process?: { env: Environment } };
  return runtime.process?.env ?? {};
}

/**
 * What a deployed Gitmatrix binds: its Worker, domain and every account-wide
 * resource. The canonical deploy is productionInstance(); `gm instance setup` creates
 * another in any Cloudflare account (several can share one) and writes its
 * file, which `gm instance deploy` hands cf as GITMATRIX_INSTANCE_CONFIG.
 * Durable Objects belong to their Worker, so only names Cloudflare scopes to
 * the account appear here.
 */
export interface Instance {
  /** The instance's slug; PRODUCTION_NAME for the canonical deploy. */
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

/**
 * The canonical deploy's identifiers that are its owner's, not the
 * repository's: the deploy job's CI secrets supply them (.gitmatrix/ci.yml,
 * tools/agent/deploy.ts), and an operator deploying by hand exports them.
 * Every other production name is fixed below.
 */
export const PRODUCTION_VARIABLES = {
  host: "GITMATRIX_PRODUCTION_HOST",
  db: "GITMATRIX_PRODUCTION_DB_ID",
  registryDb: "GITMATRIX_PRODUCTION_REGISTRY_DB_ID",
  secretsStore: "GITMATRIX_PRODUCTION_SECRETS_STORE_ID",
  ownerEmail: "GITMATRIX_PRODUCTION_OWNER_EMAIL",
  emailFrom: "GITMATRIX_PRODUCTION_EMAIL_FROM",
} as const;

type ProductionValue = keyof typeof PRODUCTION_VARIABLES;

/**
 * What production binds where its variables are absent: checks, tests and
 * builds resolve the config without them, and a production deploy refuses to.
 */
export const PRODUCTION_PLACEHOLDERS: Record<ProductionValue, string> = {
  host: "timelines.example.com",
  db: "00000000-0000-4000-8000-000000000000",
  registryDb: "00000000-0000-4000-8000-000000000001",
  secretsStore: "0".repeat(32),
  ownerEmail: "owner@example.com",
  emailFrom: "timelines@mail.example.com",
};

/**
 * Set to `production` by tools/agent/deploy.ts and `vp run deploy`: the
 * config is about to deploy the canonical instance, so every production
 * variable must be set.
 */
export const DEPLOY_VARIABLE = "GITMATRIX_DEPLOY";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const PRODUCTION_FORMATS: Record<ProductionValue, RegExp> = {
  host: HOST,
  db: /^[0-9a-f-]{32,36}$/,
  registryDb: /^[0-9a-f-]{32,36}$/,
  secretsStore: /^[0-9a-f]{32}$/,
  ownerEmail: EMAIL,
  emailFrom: EMAIL,
};

/** The production variables a deploy needs and this environment lacks. */
export function missingProductionVariables(env: Environment): string[] {
  return Object.values(PRODUCTION_VARIABLES).filter((name) => !env[name]?.trim());
}

/**
 * The canonical deploy, its identifiers read from `env` on every call.
 * Absent ones are placeholders, unless GITMATRIX_DEPLOY=production, when the
 * deploy fails rather than bind a placeholder.
 */
export function productionInstance(env: Environment): Instance {
  if (env[DEPLOY_VARIABLE]?.trim() === "production") {
    const missing = missingProductionVariables(env);
    if (missing.length)
      throw new Error(
        `A production deploy needs ${missing.join(", ")}. CI supplies them as the deploy ` +
          "job's secrets; deploying by hand, export them first.",
      );
  }
  const value = (key: ProductionValue): string => {
    const name = PRODUCTION_VARIABLES[key];
    const given = env[name]?.trim();
    if (!given) return PRODUCTION_PLACEHOLDERS[key];
    if (!PRODUCTION_FORMATS[key].test(given))
      throw new Error(`${name} must match ${PRODUCTION_FORMATS[key]}`);
    return given;
  };
  return {
    name: PRODUCTION_NAME,
    host: value("host"),
    worker: "gitmatrix",
    db: { name: "gitmatrix", id: value("db") },
    registryDb: { name: "gitmatrix-registry", id: value("registryDb") },
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
    // The account's store may hold other projects' secrets; names are prefixed with the project.
    secrets: {
      store: value("secretsStore"),
      registryKek: "gitmatrix_registry_kek",
      betterAuth: "gitmatrix_better_auth_secret",
    },
    // Rate-limit namespaces are account-wide; previews count in 4402.
    rateLimitNamespace: "4401",
    owner: { email: value("ownerEmail"), org: "matrixorg" },
    emailFrom: value("emailFrom"),
  };
}

/** The canonical deploy's instance name; an instance file may never use it. */
export const PRODUCTION_NAME = "production";

/** Whether an instance is the canonical deploy rather than a self-hosted one. */
export function isProduction(instance: Instance): boolean {
  return instance.name === PRODUCTION_NAME;
}

/** Set by `gm instance deploy`: the path of the instance file to deploy. */
export const INSTANCE_VARIABLE = "GITMATRIX_INSTANCE_CONFIG";

/** The instance a deploy binds: the file GITMATRIX_INSTANCE_CONFIG names, else production. */
export function deployedInstance(env: Environment): Instance {
  const path = env[INSTANCE_VARIABLE]?.trim();
  if (!path) return productionInstance(env);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${INSTANCE_VARIABLE}=${path} is not a readable instance file: ${reason}`);
  }
  return parseInstance(raw, env);
}

const SLUG = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SECRET = /^[a-z0-9_]{1,63}$/;
const ID = /^[0-9a-f-]{32,36}$/;

/**
 * Validate an instance file (gm writes it; extra fields are gm's own and
 * ignored) and refuse any name that is production's: a second instance
 * sharing one would bind, or redefine, production's resources. Production's
 * own identifiers come from `env` where it sets them.
 */
export function parseInstance(raw: unknown, env: Environment = processEnv()): Instance {
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
    host: text("host", HOST),
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
      email: text("owner.email", EMAIL),
      org: text("owner.org", /^[a-z0-9][a-z0-9-]{0,38}$/),
    },
    emailFrom: text("emailFrom", EMAIL),
  };
  if (instance.queues.jobs.endsWith("-registry-jobs"))
    problems.push("queues.jobs must not end in -registry-jobs");
  // Timeline previews own gitmatrix-preview-*; instance x's registry names are
  // gitmatrix-x-registry(-jobs) (gm instance setup refuses both too).
  if (instance.name.startsWith("preview-")) problems.push("name must not start with preview-");
  if (instance.name.endsWith("-registry")) problems.push("name must not end in -registry");
  if (problems.length) throw new Error(`Invalid instance file: ${problems.join("; ")}`);
  const shared = sharedWithProduction(instance, env);
  if (shared.length)
    throw new Error(
      `Instance ${instance.name} reuses production's ${shared.join(", ")}; ` +
        "every account-wide name must be its own.",
    );
  return instance;
}

/**
 * The provider's names for the Workflows the Space cutover censuses, by the
 * cutover's own name for each (worker/space-cutover/quiescence.ts
 * CUTOVER_WORKFLOWS). The Worker reads them from its CUTOVER_WORKFLOW_NAMES
 * binding; tools/space-cutover.ts lists the same ones.
 */
export function cutoverWorkflowNames(
  instance: Instance,
): Record<"ci-run" | "knowledge-build" | "repo-purge", string> {
  return {
    "ci-run": instance.workflows.ciRun,
    "knowledge-build": instance.workflows.knowledgeBuild,
    "repo-purge": instance.workflows.repoPurge,
  };
}

/**
 * The installation a workflow census lists: an instance's file (`gm instance
 * setup` writes it) when one is given, else production. The census names its
 * Worker and account explicitly; they must be the instance's, so a census of
 * one installation never reads another's Workflows.
 */
export function censusInstance(
  file: unknown,
  worker: string,
  account: string,
  env: Environment = processEnv(),
): Instance {
  if (file === null) {
    const production = productionInstance(env);
    if (worker !== production.worker)
      throw new Error(
        `--worker ${worker} isn't production's; pass its gm instance file with --instance-config`,
      );
    return production;
  }
  const instance = parseInstance(file, env);
  if (worker !== instance.worker)
    throw new Error(`--worker ${worker} isn't instance ${instance.name}'s (${instance.worker})`);
  const accountId = (file as { accountId?: unknown }).accountId;
  if (typeof accountId === "string" && accountId !== account)
    throw new Error(`--account ${account} isn't instance ${instance.name}'s (${accountId})`);
  return instance;
}

/**
 * The account-wide names (and the host) an instance shares with production.
 * Production's identifiers are compared where `env` sets them; placeholders
 * stand for nothing, so they never count as shared.
 */
export function sharedWithProduction(
  instance: Instance,
  env: Environment = processEnv(),
): string[] {
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
  const placeholders = new Set(Object.values(PRODUCTION_PLACEHOLDERS));
  const production = new Set(
    Object.values(flat(productionInstance({ ...env, [DEPLOY_VARIABLE]: undefined }))).filter(
      (value) => value !== undefined && !placeholders.has(value),
    ),
  );
  // Development's remote resources keep their fixed names too.
  for (const name of ["gitmatrix-dev", "gitmatrix-knowledge", "4402"]) production.add(name);
  return Object.entries(ours)
    .filter(([, value]) => value !== undefined && production.has(value))
    .map(([key]) => key);
}
