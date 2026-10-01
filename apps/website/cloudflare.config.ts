import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";

// Remote services have no local emulator, so dev talks to the real ones
// (Artifacts, Workers AI, Vectorize, AI Search). D1, the Durable Object and
// the Workflow run locally.
const remote = { dev: { remote: true } };

// CI jobs run in Cloudflare Sandbox containers once deployed. In `vp dev` they
// run on this machine instead (`gm runner`), so development never starts paid
// containers. GITMATRIX_CI_RUNNER=sandbox tries the container path locally
// (needs Docker).
type Runner = "local" | "sandbox";

/** A fixed, public development key for the registry. Never used once deployed. */
const DEV_KEK = btoa("gitmatrix-development-key-not-secret!");

const ciSandbox = defineContainer({
  name: "gitmatrix-ci",
  schedulingPolicy: "durable-object",
  images: { default: { dockerfile: "./ci/Dockerfile" } },
});

export default defineConfig(({ mode }) => {
  const runner: Runner =
    // (Evaluated in Node; the Worker's tsconfig also sees this file, without Node types.)
    ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
      .GITMATRIX_CI_RUNNER as Runner | undefined) ?? (mode === "development" ? "local" : "sandbox");
  const sandboxed = runner === "sandbox";
  const dev = mode === "development";
  const publicUrl =
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
      .GITMATRIX_PUBLIC_URL ?? (dev ? "http://localhost:5180" : undefined);
  return {
    ...(sandboxed ? { containers: [ciSandbox] } : {}),
    worker: {
      name: "gitmatrix",
      compatibilityDate: "2026-09-30",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "./worker/index.ts",
      observability: { enabled: true },
      // Hashing multi-GB image layers and building signed package indexes.
      limits: { cpuMs: 300_000 },
      assets: {
        notFoundHandling: "single-page-application",
        // The API and git smart-HTTP endpoints must never fall through to index.html.
        // Package protocols too: /v2 (OCI) and /<format>/… (registry/app.ts).
        runWorkerFirst: [
          "/api/*",
          "/*.git/*",
          "/v2/*",
          "/npm/*",
          "/pypi/*",
          "/maven/*",
          "/cargo/*",
          "/go/*",
          "/helm/*",
          "/apt/*",
          "/rpm/*",
          "/brew/*",
          "/generic/*",
          "/releases/*",
        ],
      },
      env: {
        DB: bindings.d1({ name: "gitmatrix", id: "00000000000000000000000000000000" }),
        ARTIFACTS: bindings.artifacts({ namespace: "gitmatrix-dev", ...remote }),
        // Knowledge graph and wiki.
        AI: bindings.ai(remote),
        VECTORS: bindings.vectorize({ name: "gitmatrix-knowledge", ...remote }),
        SEARCH: bindings.aiSearchNamespace({ namespace: "gitmatrix", ...remote }),
        KNOWLEDGE_COORDINATOR: bindings.durableObject({
          worker: "gitmatrix",
          exportName: "KnowledgeCoordinator",
        }),
        KNOWLEDGE_BUILD: bindings.workflow({
          name: "knowledge-build",
          worker: "gitmatrix",
          exportName: "KnowledgeBuild",
        }),
        // CI/CD.
        CI_RUNNER: bindings.text<Runner>(runner),
        CI_RUN: bindings.workflow({ name: "ci-run", worker: "gitmatrix", exportName: "CiRun" }),
        CI_SANDBOX: bindings.durableObject({ worker: "gitmatrix", exportName: "CiSandbox" }),
        // Packages (registry/): its own catalog database and blob bucket, so its
        // tables never meet gitmatrix's. People and permissions stay in DB.
        REGISTRY_DB: bindings.d1({
          name: "gitmatrix-registry",
          id: "00000000000000000000000000000001",
        }),
        REGISTRY_BLOBS: bindings.r2({ name: "gitmatrix-registry-blobs" }),
        REGISTRY_REPO: bindings.durableObject({ worker: "gitmatrix", exportName: "RegistryRepo" }),
        REGISTRY_UPLOAD: bindings.durableObject({
          worker: "gitmatrix",
          exportName: "RegistryUpload",
        }),
        REGISTRY_LOGIN: bindings.durableObject({
          worker: "gitmatrix",
          exportName: "RegistryLogin",
        }),
        REGISTRY_JOBS: bindings.queue({ name: "gitmatrix-registry-jobs" }),
        // Repository work off the push path: mirrors to other git hosts.
        JOBS: bindings.queue({ name: "gitmatrix-jobs" }),
        // Seals signing keys and upstream credentials, and seeds registry tokens.
        // Development uses a fixed public key; deployed, set the REGISTRY_KEK secret.
        ...(dev
          ? { REGISTRY_KEK: bindings.text(DEV_KEK), DEV_MODE: bindings.text("true") }
          : { REGISTRY_KEK: bindings.secret() }),
        // Where package clients and CI sandboxes reach gitmatrix. Generated
        // indexes (Helm, APT, RPM…) embed it; deployed, set GITMATRIX_PUBLIC_URL.
        ...(publicUrl ? { PUBLIC_URL: bindings.text(publicUrl) } : {}),
      },
      triggers: [
        triggers.queue({ name: "gitmatrix-registry-jobs", maxBatchSize: 10, maxRetries: 5 }),
        // Mirror syncs back off exponentially (worker/mirror/queue.ts), up to ~2 hours.
        triggers.queue({ name: "gitmatrix-jobs", maxBatchSize: 5, maxRetries: 12 }),
        // Package retention and garbage collection sweeps.
        triggers.scheduled({ schedule: "17 * * * *" }),
      ],
      exports: {
        KnowledgeCoordinator: exports.durableObject({ storage: "sqlite" }),
        KnowledgeBuild: exports.workflow({ name: "knowledge-build" }),
        CiRun: exports.workflow({ name: "ci-run" }),
        RegistryRepo: exports.durableObject({ storage: "sqlite" }),
        RegistryUpload: exports.durableObject({ storage: "sqlite" }),
        RegistryLogin: exports.durableObject({ storage: "sqlite" }),
        CiSandbox: exports.durableObject({
          storage: "sqlite",
          ...(sandboxed ? { container: ciSandbox } : {}),
        }),
      },
    },
  };
});
