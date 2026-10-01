import { bindings, defineConfig, defineContainer, exports } from "cf/config";

// Remote services have no local emulator, so dev talks to the real ones
// (Artifacts, Workers AI, Vectorize, AI Search). D1, the Durable Object and
// the Workflow run locally.
const remote = { dev: { remote: true } };

// CI jobs run in Cloudflare Sandbox containers once deployed. In `vp dev` they
// run on this machine instead (`gm runner`), so development never starts paid
// containers. GITMATRIX_CI_RUNNER=sandbox tries the container path locally
// (needs Docker).
type Runner = "local" | "sandbox";

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
  return {
    ...(sandboxed ? { containers: [ciSandbox] } : {}),
    worker: {
      name: "gitmatrix",
      compatibilityDate: "2026-09-30",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "./worker/index.ts",
      observability: { enabled: true },
      assets: {
        notFoundHandling: "single-page-application",
        // The API and git smart-HTTP endpoints must never fall through to index.html.
        runWorkerFirst: ["/api/*", "/*.git/*"],
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
      },
      exports: {
        KnowledgeCoordinator: exports.durableObject({ storage: "sqlite" }),
        KnowledgeBuild: exports.workflow({ name: "knowledge-build" }),
        CiRun: exports.workflow({ name: "ci-run" }),
        CiSandbox: exports.durableObject({
          storage: "sqlite",
          ...(sandboxed ? { container: ciSandbox } : {}),
        }),
      },
    },
  };
});
