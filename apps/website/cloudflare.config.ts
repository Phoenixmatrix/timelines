import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import { developmentEnvironment } from "./vite/environment.ts";
import { previewKey, previewResources } from "./vite/preview.ts";

// Remote services have no local emulator, so dev talks to the real ones
// (Artifacts, Workers AI, Vectorize, AI Search). D1, the Durable Object and
// the Workflow run locally.
const remote = { dev: { remote: true } };

// CI jobs run in Cloudflare Sandbox containers once deployed. In `vp dev` they
// run on this machine instead (`gm runner`), so development never starts paid
// containers. GITMATRIX_CI_RUNNER=sandbox tries the container path locally
// (needs Docker).
type Runner = "local" | "sandbox";

/** Where the deployed Worker lives; GITMATRIX_PUBLIC_URL can override it. */
const PRODUCTION_HOST = "gitmatrix.fward.dev";

/**
 * Remote resources dev also talks to (Artifacts, Vectorize, AI Search) get
 * production-only names, so a deploy never shares repositories or indexes with
 * `vp dev`. Created with `cf` on the "Pile of cats" account.
 */
const PRODUCTION = {
  artifacts: "gitmatrix",
  vectors: "gitmatrix-knowledge-prod",
  search: "gitmatrix-prod",
  gateway: "gitmatrix",
  db: "3ed3e1ec-bd11-4f8e-bfee-d7c0bcb89e77",
  registryDb: "caea2f3d-d4d3-43cd-aaf9-f14a3d84621d",
};

/** A fixed, public development key for the registry. Never used once deployed. */
const DEV_KEK = btoa("gitmatrix-development-key-not-secret!");
/** Signs development sessions only; deployed, the Secrets Store holds the real one. */
const DEV_AUTH_SECRET = "gitmatrix-development-auth-secret-not-secret";
/**
 * The account's Secrets Store, shared with the other ~/dev projects; names are
 * prefixed with the project (gitmatrix_…) so they never collide. readSecret()
 * reads NAME, else the NAME_SECRET binding.
 */
const SECRETS_STORE = "2dcc6c92ee1743548ad303924b4e0f11";

/** The instance owner: superuser everywhere, owner of OWNER_ORG once deployed. */
const OWNER_EMAIL = "hello@fward.me";
/** Sign-in codes come from this address (Email Service, mail.fward.dev). */
const EMAIL_FROM = "gitmatrix@mail.fward.dev";

/**
 * The CI image. Deploys from CI pass GITMATRIX_CI_IMAGE, the deployed
 * version's image reference: a Sandbox has no Docker to rebuild it, so CI
 * reuses it, and changes to ci/Dockerfile deploy from a machine with Docker.
 */
function ciSandbox(image: string | undefined) {
  return defineContainer({
    name: "gitmatrix-ci",
    schedulingPolicy: "durable-object",
    images: { default: image ? { reference: image } : { dockerfile: "./ci/Dockerfile" } },
  });
}

export default defineConfig(({ mode, isPreview }) => {
  // cf evaluates this in Node, while the Worker's tsconfig excludes Node globals.
  const runtime = globalThis as typeof globalThis & {
    process?: { env: Record<string, string | undefined> };
  };
  const env = runtime.process?.env ?? {};
  const dev = mode === "development";
  const local = developmentEnvironment(env);
  if (local.agent && !dev) throw new Error("Agent environments must never deploy");
  // A timeline preview (`cf previews deploy`, run by tools/preview; CORE-80).
  // Worker Previews isolate Durable Objects and nothing else, so a preview
  // binds its own D1s, bucket and Artifacts namespace, and leaves out what
  // would reach production or the outside world: the Workflows, the queues
  // (producers and consumers), cron, email, AI, the domain and the Secrets
  // Store. PREVIEW_MODE turns on worker/preview.ts's guards behind that.
  const preview = isPreview ? previewResources(env) : null;
  const ai = !preview && !(dev && local.agent && env.GITMATRIX_AGENT_AI === "disabled");
  const runner = (env.GITMATRIX_CI_RUNNER ?? (dev ? "local" : "sandbox")) as Runner;
  const sandboxed = runner === "sandbox";
  // Declaring the container makes `vite build` build its image, which needs
  // Docker. CI's build check runs inside a Sandbox without it and never
  // deploys, so it sets GITMATRIX_CONTAINER_IMAGES=skip.
  // Previews take no container: they run no CI, and cf can't preview one a
  // Durable Object manages.
  const container = sandboxed && !preview && env.GITMATRIX_CONTAINER_IMAGES !== "skip";
  const ci = ciSandbox(env.GITMATRIX_CI_IMAGE);
  // A preview answers wherever cf put it, so it goes by each request's origin.
  const publicUrl = preview
    ? undefined
    : dev
      ? local.publicUrl
      : (env.GITMATRIX_PUBLIC_URL ?? `https://${PRODUCTION_HOST}`);
  return {
    ...(container ? { containers: [ci] } : {}),
    worker: {
      name: "gitmatrix",
      compatibilityDate: "2026-09-30",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "./worker/index.ts",
      // Deployed: served on its domain, not on gitmatrix.<subdomain>.workers.dev,
      // but with preview URLs on that subdomain, where the timeline previews
      // (`cf previews deploy`, tools/preview) answer as
      // <preview>-gitmatrix.<subdomain>.workers.dev. Explicit, so a deploy
      // sets the subdomain to exactly that (enabled false, previews_enabled true).
      ...(dev || preview
        ? {}
        : { domains: [PRODUCTION_HOST], workersDev: false, previewUrls: true }),
      observability: { enabled: true },
      // Multi-GB hashing/indexing; up to 20,000 historical frames with base/cache I/O.
      limits: { cpuMs: 300_000, subrequests: 200_000 },
      assets: {
        notFoundHandling: "single-page-application",
        // The API, git and package protocols. Kept in step with
        // shared/worker-first.ts by a test, not imported: a module both this
        // config and the Worker load fails to load in the dev server. A
        // preview runs the Worker first for everything: its access gate
        // (worker/preview.ts) stands in front of the assets too.
        runWorkerFirst: preview
          ? true
          : [
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
        // Local D1 keeps the zero ids (`vp run db:migrate` targets them).
        DB: bindings.d1({
          name: "gitmatrix",
          id: preview?.db ?? (dev ? "00000000000000000000000000000000" : PRODUCTION.db),
        }),
        TRACKER: bindings.durableObject({ worker: "gitmatrix", exportName: "Tracker" }),
        // The assistant (CORE-25): one Durable Object per conversation, and the
        // Worker Loader its Code Mode scripts run in (isolated, no network).
        ASSISTANT: bindings.durableObject({ worker: "gitmatrix", exportName: "Assistant" }),
        LOADER: bindings.workerLoader(),
        ARTIFACTS: bindings.artifacts({
          namespace:
            preview?.artifacts ??
            (dev ? (env.GITMATRIX_ARTIFACTS_NAMESPACE ?? "gitmatrix-dev") : PRODUCTION.artifacts),
          ...remote,
        }),
        // Knowledge graph and wiki.
        ...(ai
          ? {
              AI: bindings.ai(remote),
              AI_GATEWAY: bindings.text(
                dev ? (env.GITMATRIX_AI_GATEWAY ?? "gitmatrix-dev") : PRODUCTION.gateway,
              ),
              VECTORS: bindings.vectorize({
                name: dev
                  ? (env.GITMATRIX_VECTORIZE_INDEX ?? "gitmatrix-knowledge")
                  : PRODUCTION.vectors,
                ...remote,
              }),
              SEARCH: bindings.aiSearchNamespace({
                namespace: dev
                  ? (env.GITMATRIX_SEARCH_NAMESPACE ?? "gitmatrix")
                  : PRODUCTION.search,
                ...remote,
              }),
            }
          : {}),
        KNOWLEDGE_COORDINATOR: bindings.durableObject({
          worker: "gitmatrix",
          exportName: "KnowledgeCoordinator",
        }),
        // Workflows are the account's, not a Preview's: a preview binds none.
        ...(preview
          ? {}
          : {
              KNOWLEDGE_BUILD: bindings.workflow({
                name: "knowledge-build",
                worker: "gitmatrix",
                exportName: "KnowledgeBuild",
              }),
            }),
        // CI/CD.
        CI_RUNNER: bindings.text<Runner>(runner),
        // Local runners start on demand: the CI Workflow pings the dev server,
        // which runs `gm runner --once` per queued job (vite/ci-runners.ts).
        ...(runner === "local" && dev && publicUrl
          ? { CI_DISPATCH_URL: bindings.text(`${publicUrl}/__gitmatrix/ci/dispatch`) }
          : {}),
        ...(dev && env.GITMATRIX_AGENT_ID
          ? { AGENT_ID: bindings.text(env.GITMATRIX_AGENT_ID) }
          : {}),
        ...(dev && env.GITMATRIX_AGENT_SECRET
          ? { AGENT_SECRET: bindings.text(env.GITMATRIX_AGENT_SECRET) }
          : {}),
        // tools/preview seeds a preview through the same secret-gated /api/dev
        // routes the agent harness uses (worker/api/dev.ts).
        ...(preview
          ? {
              PREVIEW_MODE: bindings.text("true"),
              // The access key every request must present (or a token minted behind it).
              PREVIEW_KEY: bindings.text(previewKey(preview.secret)),
              // The gate passes asset requests on through this.
              ASSETS: bindings.assets(),
              AGENT_ID: bindings.text(preview.name),
              AGENT_SECRET: bindings.text(preview.secret),
            }
          : {}),
        ...(dev && env.GITMATRIX_CI_DISPATCH_SECRET
          ? { CI_DISPATCH_SECRET: bindings.text(env.GITMATRIX_CI_DISPATCH_SECRET) }
          : {}),
        // Development only: the Atlas model, prices and caps, per owning account
        // (worker/knowledge/budget.ts `atlasSettings`). `agent test-ai` runs its
        // disabled, refused and exhausted providers through it; deployed
        // Workers always use the built-in defaults.
        ...(dev && env.GITMATRIX_ATLAS_CONFIG
          ? { ATLAS_CONFIG: bindings.text(env.GITMATRIX_ATLAS_CONFIG) }
          : {}),
        ...(preview
          ? {}
          : {
              CI_RUN: bindings.workflow({
                name: "ci-run",
                worker: "gitmatrix",
                exportName: "CiRun",
              }),
            }),
        CI_SANDBOX: bindings.durableObject({ worker: "gitmatrix", exportName: "CiSandbox" }),
        // Packages (registry/): its own catalog database and blob bucket, so its
        // tables never meet gitmatrix's. People and permissions stay in DB.
        REGISTRY_DB: bindings.d1({
          name: "gitmatrix-registry",
          id:
            preview?.registryDb ??
            (dev ? "00000000000000000000000000000001" : PRODUCTION.registryDb),
        }),
        REGISTRY_BLOBS: bindings.r2({ name: preview?.bucket ?? "gitmatrix-registry-blobs" }),
        // People's profile pictures and their generated options (CORE-116). A
        // preview shares its one bucket: avatar keys (avatars/, avatar-options/)
        // never meet the registry's (b/, c/, d/).
        AVATARS: bindings.r2({ name: preview?.bucket ?? "gitmatrix-avatars" }),
        REGISTRY_REPO: bindings.durableObject({ worker: "gitmatrix", exportName: "RegistryRepo" }),
        REGISTRY_UPLOAD: bindings.durableObject({
          worker: "gitmatrix",
          exportName: "RegistryUpload",
        }),
        REGISTRY_LOGIN: bindings.durableObject({
          worker: "gitmatrix",
          exportName: "RegistryLogin",
        }),
        // The queues are production's (a preview would feed its consumers), so
        // a preview has neither; its pushes don't mirror or queue release notes.
        ...(preview
          ? {}
          : {
              REGISTRY_JOBS: bindings.queue({ name: "gitmatrix-registry-jobs" }),
              // Repository work off the push path: mirrors to other git hosts.
              JOBS: bindings.queue({ name: "gitmatrix-jobs" }),
            }),
        // Seals signing keys and upstream credentials, and seeds registry tokens.
        // Development uses a fixed public key; deployed, set the REGISTRY_KEK secret.
        // A preview seals with its own secret and, emailing no one, signs people
        // in as the seeded personas (DEV_MODE), as development does.
        ...(dev
          ? { REGISTRY_KEK: bindings.text(DEV_KEK), DEV_MODE: bindings.text("true") }
          : preview
            ? {
                REGISTRY_KEK: bindings.text(btoa(preview.secret)),
                DEV_MODE: bindings.text("true"),
              }
            : {
                REGISTRY_KEK_SECRET: bindings.secretsStoreSecret({
                  storeId: SECRETS_STORE,
                  secretName: "gitmatrix_registry_kek",
                }),
              }),
        // Sign-in (worker/better-auth.ts): emailed one-time codes and device
        // login for gm. Invite only; OWNER_EMAIL may always sign in.
        ...(dev || preview
          ? { BETTER_AUTH_SECRET: bindings.text(preview?.secret ?? DEV_AUTH_SECRET) }
          : {
              BETTER_AUTH_SECRET_SECRET: bindings.secretsStoreSecret({
                storeId: SECRETS_STORE,
                secretName: "gitmatrix_better_auth_secret",
              }),
            }),
        OWNER_EMAIL: bindings.text(OWNER_EMAIL),
        // Deployed only: the owner's org, created on their first sign-in. It
        // will hold the gitmatrix repository; development keeps the seed data.
        ...(dev || preview ? {} : { OWNER_ORG: bindings.text("matrixorg") }),
        EMAIL_FROM: bindings.text(EMAIL_FROM),
        // Locally the binding simulates delivery: messages are logged, never sent.
        // A preview sends nothing.
        ...(preview ? {} : { EMAIL: bindings.sendEmail({ allowedSenderAddresses: [EMAIL_FROM] }) }),
        // Failed codes and device approvals, per email and per IP. Crossing the
        // limit locks the key out for 15 minutes (auth_lockouts).
        // Namespace ids are account-wide: ~/dev projects use 1001 and 4x01 per
        // project (4101 trustmatrix … 4301 mailmatrix), so gitmatrix is 4401.
        // Previews count their failures apart from production's, in 4402.
        AUTH_FAILURES: bindings.rateLimit({
          namespace: preview ? "4402" : "4401",
          simple: { limit: 5, period: 60 },
        }),
        // Where package clients and CI sandboxes reach gitmatrix. Generated
        // indexes (Helm, APT, RPM…) embed it; deployed, https://gitmatrix.fward.dev.
        ...(publicUrl ? { PUBLIC_URL: bindings.text(publicUrl) } : {}),
      },
      // No consumers or cron in a preview: Worker Previews don't run them, and
      // the queues are production's.
      triggers: preview
        ? []
        : [
            triggers.queue({ name: "gitmatrix-registry-jobs", maxBatchSize: 10, maxRetries: 5 }),
            // Mirror syncs back off exponentially (worker/mirror/queue.ts), up to ~2 hours.
            triggers.queue({ name: "gitmatrix-jobs", maxBatchSize: 5, maxRetries: 12 }),
            // Package retention and garbage collection sweeps; previews, landings
            // and Atlas projection retention (worker/index.ts `scheduled`).
            triggers.scheduled({ schedule: "17 * * * *" }),
          ],
      exports: {
        Tracker: exports.durableObject({ storage: "sqlite" }),
        Assistant: exports.durableObject({ storage: "sqlite" }),
        KnowledgeCoordinator: exports.durableObject({ storage: "sqlite" }),
        // A Workflow's name is the account's: a preview declaring these would
        // redefine production's.
        ...(preview
          ? {}
          : {
              KnowledgeBuild: exports.workflow({ name: "knowledge-build" }),
              CiRun: exports.workflow({ name: "ci-run" }),
            }),
        RegistryRepo: exports.durableObject({ storage: "sqlite" }),
        RegistryUpload: exports.durableObject({ storage: "sqlite" }),
        RegistryLogin: exports.durableObject({ storage: "sqlite" }),
        CiSandbox: exports.durableObject({
          storage: "sqlite",
          ...(container ? { container: ci } : {}),
        }),
      },
    },
  };
});
