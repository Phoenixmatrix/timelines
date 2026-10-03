// The preview mode (CORE-80): what a timeline preview of Gitmatrix binds, and
// that nothing in it reaches production's Workflows, queues, email or data.

import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import config from "../cloudflare.config.ts";
import { WORKER_FIRST } from "../shared/worker-first.ts";
import {
  previewKey,
  previewResources,
  previewVariables,
  type PreviewResources,
} from "./preview.ts";

const resources: PreviewResources = {
  name: "timeline-faster-search",
  db: "11111111-1111-4111-8111-111111111111",
  registryDb: "22222222-2222-4222-8222-222222222222",
  bucket: "gitmatrix-preview-faster-search",
  artifacts: "gitmatrix-preview-faster-search",
  secret: "a".repeat(64),
};

interface Built {
  containers?: unknown[];
  worker: {
    domains?: string[];
    workersDev?: boolean;
    previewUrls?: boolean;
    assets: { runWorkerFirst: string[] | boolean };
    env: Record<string, { type: string; [key: string]: unknown }>;
    triggers: unknown[];
    exports: Record<string, { type: string }>;
  };
}

async function build(isPreview: boolean, variables: Record<string, string> = {}) {
  vi.stubEnv("GITMATRIX_CI_RUNNER", "sandbox");
  for (const [key, value] of Object.entries(variables)) vi.stubEnv(key, value);
  const factory = config as unknown as (context: {
    mode: string;
    isPreview: boolean;
  }) => Built | Promise<Built>;
  return factory({ mode: "production", isPreview });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("previewResources", () => {
  test("reads what tools/preview sets, and round-trips", () => {
    expect(previewResources(previewVariables(resources))).toEqual(resources);
  });

  test("never falls back: every resource is required", () => {
    const variables = previewVariables(resources);
    delete variables.GITMATRIX_PREVIEW_DB;
    expect(() => previewResources(variables)).toThrow(/GITMATRIX_PREVIEW_DB/);
    expect(() => previewResources({})).toThrow(/never production's/);
  });

  test("refuses a short secret", () => {
    expect(() => previewResources(previewVariables({ ...resources, secret: "short" }))).toThrow(
      /at least 32/,
    );
  });
});

describe("cloudflare.config.ts in preview mode", () => {
  test("a preview build without its resources fails rather than binding production's", async () => {
    await expect(async () => build(true)).rejects.toThrow(/GITMATRIX_PREVIEW_/);
  });

  test("binds the preview's own D1s, bucket and Artifacts namespace", async () => {
    const { worker } = await build(true, previewVariables(resources));
    expect(worker.env.DB).toMatchObject({ type: "d1", id: resources.db });
    expect(worker.env.REGISTRY_DB).toMatchObject({ type: "d1", id: resources.registryDb });
    expect(worker.env.REGISTRY_BLOBS).toMatchObject({ name: resources.bucket });
    expect(worker.env.ARTIFACTS).toMatchObject({ namespace: resources.artifacts });
    expect(worker.env.PREVIEW_MODE).toMatchObject({ value: "true" });
    expect(worker.env.AGENT_ID).toMatchObject({ value: resources.name });
    expect(worker.env.AGENT_SECRET).toMatchObject({ value: resources.secret });
    expect(worker.env.AUTH_FAILURES).toMatchObject({ namespace: "4402" });
  });

  test("runs every request through the access gate, keyed from the secret", async () => {
    const { worker } = await build(true, previewVariables(resources));
    expect(worker.assets.runWorkerFirst).toBe(true);
    expect(worker.env.ASSETS).toMatchObject({ type: "assets" });
    expect(worker.env.PREVIEW_KEY).toMatchObject({ value: previewKey(resources.secret) });
    expect(previewKey(resources.secret)).not.toBe(resources.secret);
  });

  test("leaves out Workflows, queues, cron, email, AI, the domain and the Secrets Store", async () => {
    const built = await build(true, previewVariables(resources));
    const types = Object.values(built.worker.env).map((binding) => binding.type);
    for (const type of [
      "workflow",
      "queue",
      "send-email",
      "secrets-store-secret",
      "ai",
      "vectorize",
      "ai-search-namespace",
    ])
      expect(types, type).not.toContain(type);
    for (const name of [
      "CI_RUN",
      "KNOWLEDGE_BUILD",
      "JOBS",
      "REGISTRY_JOBS",
      "EMAIL",
      "AI",
      "VECTORS",
      "SEARCH",
      "OWNER_ORG",
      "PUBLIC_URL",
      "CI_DISPATCH_URL",
    ])
      expect(built.worker.env[name], name).toBeUndefined();
    expect(built.worker.triggers).toEqual([]);
    expect(Object.values(built.worker.exports).some((e) => e.type === "workflow")).toBe(false);
    expect(built.worker.domains).toBeUndefined();
    // The subdomain is the production deploy's to set; a preview leaves it be.
    expect(built.worker.workersDev).toBeUndefined();
    expect(built.worker.previewUrls).toBeUndefined();
    expect(built.containers).toBeUndefined();
    for (const binding of Object.values(built.worker.env))
      expect(JSON.stringify(binding)).not.toMatch(
        /3ed3e1ec|caea2f3d|gitmatrix-registry-blobs|"gitmatrix-jobs"|"gitmatrix-prod"/,
      );
  });

  test("production keeps its bindings and has no preview mode", async () => {
    const { worker } = await build(false, { GITMATRIX_CONTAINER_IMAGES: "skip" });
    expect(worker.env.PREVIEW_MODE).toBeUndefined();
    expect(worker.env.CI_RUN).toMatchObject({ type: "workflow" });
    expect(worker.env.JOBS).toMatchObject({ type: "queue" });
    expect(worker.env.EMAIL).toBeDefined();
    expect(worker.env.AUTH_FAILURES).toMatchObject({ namespace: "4401" });
    expect(worker.triggers).toHaveLength(3);
    expect(worker.domains).toEqual(["gitmatrix.fward.dev"]);
    // Previews answer on the workers.dev subdomain; production itself doesn't.
    expect(worker.workersDev).toBe(false);
    expect(worker.previewUrls).toBe(true);
    expect(worker.assets.runWorkerFirst).toEqual(WORKER_FIRST);
    expect(worker.env.ASSETS).toBeUndefined();
    expect(worker.env.PREVIEW_KEY).toBeUndefined();
  });
});

test("production differs from before previews only in its workers.dev settings", async () => {
  vi.stubEnv("GITMATRIX_CI_RUNNER", "sandbox");
  vi.stubEnv("GITMATRIX_CONTAINER_IMAGES", "skip");
  const factory = config as unknown as (context: {
    mode: string;
    isPreview: boolean;
  }) => Promise<{ worker: Record<string, unknown> }>;
  const { worker } = await factory({ mode: "production", isPreview: false });
  const development = await factory({ mode: "development", isPreview: false });
  expect(development.worker.workersDev).toBeUndefined();
  expect(development.worker.previewUrls).toBeUndefined();
  const { workersDev, previewUrls, ...rest } = worker;
  expect({ workersDev, previewUrls }).toEqual({ workersDev: false, previewUrls: true });
  expect(Object.keys(rest)).toEqual([
    "name",
    "compatibilityDate",
    "compatibilityFlags",
    "entrypoint",
    "domains",
    "observability",
    "limits",
    "assets",
    "env",
    "triggers",
    "exports",
  ]);
});
