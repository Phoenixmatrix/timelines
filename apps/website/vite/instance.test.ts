// Self-hosted instances (`gm instance`): a second copy of Gitmatrix in a
// Cloudflare account binds only its own resources, and the canonical
// production deploy resolves exactly as it did before instances existed.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import config from "../cloudflare.config.ts";
import { INSTANCE_VARIABLE, PRODUCTION, parseInstance, type Instance } from "./instance.ts";
import { previewVariables, type PreviewResources } from "./preview.ts";

/** Production's resolved config, as it was before instances existed. */
const PRODUCTION_CONFIG = join(import.meta.dirname, "production-config.json");

const preview: PreviewResources = {
  name: "timeline-demo",
  db: "33333333-3333-4333-8333-333333333333",
  registryDb: "44444444-4444-4444-8444-444444444444",
  bucket: "gitmatrix-preview-demo",
  artifacts: "gitmatrix-preview-demo",
  secret: "b".repeat(64),
  accessIssuer: "https://preview-tests.cloudflareaccess.com",
  accessAudience: "preview-tests",
};

/**
 * What `gm instance setup` writes for an instance named demo, field for field
 * (apps/cli/src/commands/instance.rs `Instance`), gm's own fields included.
 */
const demo = {
  version: 1,
  name: "demo",
  accountId: "0123456789abcdef0123456789abcdef",
  zone: { id: "fedcba9876543210fedcba9876543210", name: "example.com" },
  host: "timelines-demo.example.com",
  worker: "gitmatrix-demo",
  db: { name: "gitmatrix-demo", id: "11111111-1111-4111-8111-111111111111" },
  registryDb: { name: "gitmatrix-demo-registry", id: "22222222-2222-4222-8222-222222222222" },
  buckets: {
    registry: "gitmatrix-demo-registry-blobs",
    avatars: "gitmatrix-demo-avatars",
    stepArtifacts: "gitmatrix-demo-step-artifacts",
  },
  queues: { jobs: "gitmatrix-demo-jobs", registryJobs: "gitmatrix-demo-registry-jobs" },
  workflows: {
    knowledgeBuild: "gitmatrix-demo-knowledge-build",
    ciRun: "gitmatrix-demo-ci-run",
    repoPurge: "gitmatrix-demo-repo-purge",
  },
  container: "gitmatrix-demo-ci",
  artifacts: "gitmatrix-demo",
  ai: {
    gateway: "gitmatrix-demo",
    vectors: "gitmatrix-demo-knowledge",
    search: "gitmatrix-demo",
  },
  secrets: {
    store: "2dcc6c92ee1743548ad303924b4e0f11",
    registryKek: "gitmatrix_demo_registry_kek",
    betterAuth: "gitmatrix_demo_better_auth_secret",
  },
  rateLimitNamespace: "52817",
  owner: { email: "owner@example.com", org: "acme" },
  emailFrom: "timelines-demo@mail.example.com",
  deployed: { commit: "24e5b7af1a7e72ccd971a83cef74ecefa08afa14", at: "2026-10-13T02:11:37Z" },
};

function instanceFile(contents: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "gitmatrix-instance-")), "demo.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

/** Every string in the resolved config: names, ids, hosts, addresses. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

interface Built {
  containers?: { name: string }[];
  worker: {
    name: string;
    domains?: string[];
    env: Record<string, { type: string; [key: string]: unknown }>;
    triggers: { type?: string; name?: string; [key: string]: unknown }[];
    exports: Record<string, { type: string; name?: string }>;
  };
}

/** Build the deployed config with nothing from this shell's GITMATRIX_* leaking in. */
async function build(variables: Record<string, string> = {}) {
  for (const key of Object.keys(process.env))
    if (key.startsWith("GITMATRIX_")) vi.stubEnv(key, undefined);
  vi.stubEnv("GITMATRIX_CI_RUNNER", "sandbox");
  for (const [key, value] of Object.entries(variables)) vi.stubEnv(key, value);
  const factory = config as unknown as (context: {
    mode: string;
    isPreview: boolean;
  }) => Built | Promise<Built>;
  return factory({ mode: "production", isPreview: false });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("production", () => {
  // The whole resolved config, so a change for instances that touched the
  // canonical deploy (a binding, trigger, export or container) shows here.
  // After a deliberate change to production's config, regenerate it with
  // GITMATRIX_UPDATE_PRODUCTION_CONFIG=1 vp test run vite/instance.test.ts.
  test("resolves exactly as before instances existed", async () => {
    const update = process.env.GITMATRIX_UPDATE_PRODUCTION_CONFIG === "1";
    const built = JSON.parse(JSON.stringify(await build()));
    if (update) writeFileSync(PRODUCTION_CONFIG, JSON.stringify(built, null, 2) + "\n");
    expect(built).toEqual(JSON.parse(readFileSync(PRODUCTION_CONFIG, "utf8")));
  });
});

describe("an instance", () => {
  test("binds only its own account-wide resources", async () => {
    const built = await build({ [INSTANCE_VARIABLE]: instanceFile(demo) });
    const { worker } = built;
    expect(worker.name).toBe("gitmatrix-demo");
    expect(worker.domains).toEqual(["timelines-demo.example.com"]);
    // No previews, so no workers.dev subdomain needed (a new account has none).
    expect(worker).toMatchObject({ workersDev: false, previewUrls: false });
    expect(built.containers?.map((c) => c.name)).toEqual(["gitmatrix-demo-ci"]);
    expect(worker.env.DB).toMatchObject({ name: "gitmatrix-demo", id: demo.db.id });
    expect(worker.env.REGISTRY_DB).toMatchObject({ id: demo.registryDb.id });
    expect(worker.env.JOBS).toMatchObject({ name: "gitmatrix-demo-jobs" });
    expect(worker.env.CI_RUN).toMatchObject({ name: "gitmatrix-demo-ci-run" });
    expect(worker.env.AUTH_FAILURES).toMatchObject({ namespace: "52817" });
    expect(worker.env.REGISTRY_KEK_SECRET).toMatchObject({
      secretName: "gitmatrix_demo_registry_kek",
    });
    expect(worker.env.PUBLIC_URL).toMatchObject({ value: "https://timelines-demo.example.com" });
    expect(worker.env.OWNER_ORG).toMatchObject({ value: "acme" });
    expect(worker.triggers.map((t) => t.name).filter(Boolean)).toEqual([
      "gitmatrix-demo-registry-jobs",
      "gitmatrix-demo-jobs",
    ]);
    expect(
      Object.values(worker.exports)
        .filter((e) => e.type === "workflow")
        .map((e) => e.name),
    ).toEqual([
      "gitmatrix-demo-knowledge-build",
      "gitmatrix-demo-ci-run",
      "gitmatrix-demo-repo-purge",
    ]);
    // Durable Objects are the Worker's own: every one names this Worker.
    for (const binding of Object.values(worker.env))
      if (binding.type === "durable-object" || binding.type === "workflow")
        expect(binding.worker).toBe("gitmatrix-demo");
  });

  test("shares nothing with production but the account's Secrets Store", async () => {
    const instance = await build({ [INSTANCE_VARIABLE]: instanceFile(demo) });
    const production = await build();
    const ours = new Set(strings(instance));
    const shared = strings(production).filter(
      (value) =>
        ours.has(value) &&
        // Configuration that is no resource: types, dates, flags, routes, paths.
        !/^(\/|\.\/|[A-Z_]+$)/.test(value) &&
        !Object.values(production.worker.env).some((b) => b.type === value),
    );
    expect(new Set(shared)).toEqual(
      new Set([
        "2dcc6c92ee1743548ad303924b4e0f11",
        "2026-09-30",
        "nodejs_compat",
        "single-page-application",
        "scheduled",
        "17 * * * *",
        "sandbox",
        "off",
        "sqlite",
        ...Object.keys(production.worker.exports),
      ]),
    );
  });

  test("without AI binds no paid AI", async () => {
    const { worker } = await build({ [INSTANCE_VARIABLE]: instanceFile({ ...demo, ai: null }) });
    for (const name of ["AI", "AI_GATEWAY", "VECTORS", "SEARCH"])
      expect(worker.env[name], name).toBeUndefined();
  });

  test("development and previews ignore the instance file", async () => {
    vi.stubEnv(INSTANCE_VARIABLE, instanceFile(demo));
    const factory = config as unknown as (context: {
      mode: string;
      isPreview: boolean;
    }) => Built | Promise<Built>;
    const development = await factory({ mode: "development", isPreview: false });
    expect(development.worker.name).toBe("gitmatrix");
    for (const [key, value] of Object.entries(previewVariables(preview))) vi.stubEnv(key, value);
    const previewed = await factory({ mode: "production", isPreview: true });
    expect(previewed.worker.name).toBe("gitmatrix");
    expect(JSON.stringify(previewed)).not.toContain("gitmatrix-demo");
  });
});

describe("parseInstance", () => {
  test("accepts gm's file and ignores gm's own fields", () => {
    const instance: Instance = parseInstance(demo);
    expect(instance.name).toBe("demo");
    expect(instance).not.toHaveProperty("deployed");
    expect(instance).not.toHaveProperty("zone");
  });

  test("refuses any of production's account-wide names", () => {
    expect(() => parseInstance({ ...demo, worker: "gitmatrix" })).toThrow(/production's worker/);
    expect(() =>
      parseInstance({ ...demo, workflows: { ...demo.workflows, ciRun: "ci-run" } }),
    ).toThrow(/workflows.ciRun/);
    expect(() => parseInstance({ ...demo, rateLimitNamespace: "4401" })).toThrow(
      /rateLimitNamespace/,
    );
    expect(() => parseInstance({ ...demo, host: PRODUCTION.host })).toThrow(/host/);
    expect(() => parseInstance({ ...demo, ai: { ...demo.ai, search: "gitmatrix-prod" } })).toThrow(
      /ai.search/,
    );
  });

  test("names the fields it can't use", () => {
    expect(() => parseInstance({ ...demo, queues: { jobs: "x", registryJobs: "y" } })).toThrow(
      /queues.jobs.*queues.registryJobs/,
    );
    expect(() => parseInstance({})).toThrow(/Invalid instance file/);
    expect(() => parseInstance({ ...demo, name: "preview-x" })).toThrow(/preview-/);
    expect(() => parseInstance({ ...demo, name: "acme-registry" })).toThrow(/-registry/);
    expect(() => parseInstance({ ...demo, db: { ...demo.db, id: PRODUCTION.db.id } })).toThrow(
      /db.id/,
    );
  });
});
