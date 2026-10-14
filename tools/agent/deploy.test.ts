import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertOrdinaryOwnershipMigration,
  bindingMismatches,
  DEPLOY_SECRETS,
  deployAndRecord,
  liveBindings,
  liveRecorder,
  missingDeploySecrets,
  plan,
  productionUrls,
  recordDeployed,
  sitePlan,
  type Recorder,
  type WorkerDeployments,
} from "./deploy.ts";
import { PRODUCTION_PLACEHOLDERS } from "../../apps/website/vite/instance.ts";
import { SITE_HOST_PLACEHOLDER } from "../../apps/site/src/hosts.ts";

// recordDeployed reads the production hosts from the environment: these
// tests use the placeholders, whatever this shell exports.
for (const name of DEPLOY_SECRETS) delete process.env[name];
delete process.env.GITMATRIX_DEPLOY;
const APP_URL = `https://${PRODUCTION_PLACEHOLDERS.host}`;
const SITE_URL = `https://${SITE_HOST_PLACEHOLDER}`;

/** The deploy job's secrets, as CI sets them. */
const SECRETS = {
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  GITMATRIX_PRODUCTION_HOST: "timelines.acme.dev",
  GITMATRIX_SITE_HOST: "www.acme.dev",
  GITMATRIX_PRODUCTION_DB_ID: "5a1e0c0d-1111-4aaa-8bbb-0123456789ab",
  GITMATRIX_PRODUCTION_REGISTRY_DB_ID: "5a1e0c0d-2222-4aaa-8bbb-0123456789ab",
  GITMATRIX_PRODUCTION_SECRETS_STORE_ID: "5a1e0c0d33334aaa8bbb0123456789ab",
  GITMATRIX_PRODUCTION_OWNER_EMAIL: "founder@acme.dev",
  GITMATRIX_PRODUCTION_EMAIL_FROM: "timelines@mail.acme.dev",
};

const dirs = (paths: string[]) => plan(paths).migrations.map((m) => m.dir);

await test("docs, tests and local-only files deploy nothing", () => {
  assert.deepEqual(
    plan([
      "AGENTS.md",
      "apps/website/README.md",
      "apps/website/worker/ci/config.test.ts",
      "apps/website/seed/0001_dev.sql",
      "apps/cli/src/main.rs",
      ".gitmatrix/ci.yml",
    ]),
    { worker: false, image: false, migrations: [] },
  );
});

await test("Worker code, assets and dependencies deploy the Worker", () => {
  for (const path of [
    "apps/website/worker/index.ts",
    "apps/website/src/routes/SignIn.tsx",
    "apps/website/cloudflare.config.ts",
    "packages/formats/src/hash.ts",
    "pnpm-lock.yaml",
    "patches/cf@1.0.0-beta.7.patch",
  ]) {
    assert.equal(plan([path]).worker, true, path);
  }
});

await test("migrations apply to their own database without redeploying the Worker", () => {
  assert.deepEqual(dirs(["apps/website/migrations/0012_x.sql"]), ["migrations"]);
  assert.deepEqual(dirs(["apps/website/registry/migrations/0003_y.sql"]), ["registry/migrations"]);
  assert.equal(plan(["apps/website/migrations/0012_x.sql"]).worker, false);
});

await test("the CI image's build context is the image, not the Worker", () => {
  assert.deepEqual(plan(["apps/website/ci/Dockerfile"]), {
    worker: false,
    image: true,
    migrations: [],
  });
});

await test("the public site deploys for its own sources, docs and shared inputs only", () => {
  for (const path of [
    "apps/site/src/pages/index.astro",
    "apps/site/src/content/docs/concepts/timelines.md",
    "apps/site/src/data/gm-commands.json",
    "apps/site/cloudflare.config.ts",
    "pnpm-lock.yaml",
    "patches/cf@1.0.0-beta.7.patch",
  ]) {
    assert.equal(sitePlan([path]), true, path);
  }
  for (const path of [
    "apps/site/src/gm-reference.test.ts",
    "apps/site/README.md",
    "apps/website/src/routes/SignIn.tsx",
    "apps/cli/src/meta.rs",
    "AGENTS.md",
  ]) {
    assert.equal(sitePlan([path]), false, path);
  }
  // The site is its own Worker: its changes never redeploy the website.
  assert.equal(plan(["apps/site/src/pages/index.astro"]).worker, false);
});

await test("Space preparation always deploys the tagged fence-aware Worker", () => {
  assert.equal(
    plan(["apps/website/migrations/20261011171726_organization_space_prepare.sql"]).worker,
    true,
  );
  assert.equal(
    plan(["apps/website/registry/migrations/20261011171727_space_ownership_prepare.sql"]).worker,
    true,
  );
});

await test("ordinary deployment accepts additive preparation but rejects live ownership transformation", () => {
  const filename = "20261011171726_organization_space_prepare.sql";
  assert.doesNotThrow(() =>
    assertOrdinaryOwnershipMigration(
      filename,
      "CREATE TABLE spaces(id TEXT PRIMARY KEY); ALTER TABLE repos ADD COLUMN space_id TEXT;",
    ),
  );
  for (const sql of [
    "ALTER TABLE repos RENAME COLUMN owner_id TO space_id;",
    "DROP TABLE org_members;",
    "UPDATE repos SET space_id=owner_id;",
    "INSERT INTO space_grants SELECT * FROM org_members;",
    "DELETE FROM accounts WHERE kind='org';",
  ])
    assert.throws(() => assertOrdinaryOwnershipMigration(filename, sql), /approved|operator/);
});

// Recording what deployed (CORE-351), with fake cf and gm.
const HEAD = "a".repeat(40);
const NOW = "2026-10-12T22:00:00.000Z";

function fakes(
  listed: Record<string, WorkerDeployments>,
  tags: Record<string, string | null>,
  gm: (args: string[]) => Promise<string> = async () => '{"id": 41}',
) {
  const calls: string[][] = [];
  const events: Record<string, unknown>[] = [];
  const recorder: Recorder = {
    deployments: (worker) => {
      const found = listed[worker];
      if (!found) throw new Error(`cf: ${worker} not found`);
      return found;
    },
    versionTag: (_, versionId) => tags[versionId] ?? null,
    gm: async (args) => {
      calls.push(args);
      return gm(args);
    },
    now: () => NOW,
    log: (event) => events.push(event),
  };
  return { recorder, calls, events };
}

const live = (id: string, version: string, percentage = 100, created_on?: string) => ({
  deployments: [
    { id, ...(created_on ? { created_on } : {}), versions: [{ version_id: version, percentage }] },
    { id: "older", versions: [{ version_id: "ver-old", percentage: 100 }] },
  ],
});

const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

await test("each Worker that deployed is recorded with what ran; a skipped one isn't", async () => {
  const { recorder, calls, events } = fakes(
    {
      gitmatrix: live("dep-web", "ver-web", 100, "2026-10-12T21:59:30.123456Z"),
      "gitmatrix-site": live("dep-site", "ver-site"),
    },
    { "ver-web": HEAD, "ver-site": HEAD },
  );
  await deployAndRecord(
    [
      { worker: "gitmatrix", cwd: "/w", deploy: () => ({ deployed: true, previous: "ver-1" }) },
      {
        worker: "gitmatrix-site",
        cwd: "/s",
        deploy: () => ({ deployed: false, previous: "ver-site-0" }),
      },
    ],
    HEAD,
    () => recorder,
  );
  assert.equal(calls.length, 1, "Only the Worker that deployed is recorded");
  assert.deepEqual(calls[0], [
    "deploy",
    "record",
    "--url",
    APP_URL,
    "--environment",
    "production",
    "--commit",
    HEAD,
    "--service",
    "gitmatrix",
    "--provider-version",
    "ver-web",
    "--provider-deployment",
    "dep-web",
    "--percentage",
    "100",
    "--deployed-at",
    "2026-10-12T21:59:30.123Z",
    "--exposed-from",
    "2026-10-12T21:59:30.123Z",
    "--replaces",
    "ver-1",
  ]);
  assert.deepEqual(events, [
    { event: "deploy.recorded", worker: "gitmatrix", version: "ver-web", deployment: 41 },
  ]);
});

await test("the site records too, without --replaces when nothing served before", async () => {
  const { recorder, calls } = fakes(
    { "gitmatrix-site": live("dep-site", "ver-site") },
    { "ver-site": HEAD },
  );
  assert.equal(
    await recordDeployed(recorder, {
      worker: "gitmatrix-site",
      cwd: "/s",
      head: HEAD,
      previous: null,
    }),
    true,
  );
  assert.equal(flag(calls[0]!, "--url"), SITE_URL);
  assert.equal(flag(calls[0]!, "--service"), "gitmatrix-site");
  assert.equal(flag(calls[0]!, "--deployed-at"), NOW, "Without cf's time, now");
  assert.equal(calls[0]!.includes("--replaces"), false);
});

await test("the same version as before is no replacement", async () => {
  const { recorder, calls } = fakes({ gitmatrix: live("dep-2", "ver-1") }, { "ver-1": HEAD });
  await recordDeployed(recorder, { worker: "gitmatrix", cwd: "/w", head: HEAD, previous: "ver-1" });
  assert.equal(calls[0]!.includes("--replaces"), false);
});

await test("a version built from another commit is never recorded as this one", async () => {
  const { recorder, calls, events } = fakes(
    { gitmatrix: live("dep-2", "ver-2") },
    { "ver-2": "b".repeat(40) },
  );
  assert.equal(
    await recordDeployed(recorder, { worker: "gitmatrix", cwd: "/w", head: HEAD, previous: null }),
    false,
  );
  assert.deepEqual(calls, []);
  assert.equal(events[0]!.event, "deploy.record.skipped");
  assert.match(String(events[0]!.reason), /wasn't built from the deployed commit/);
  // Nor an untagged one, or a list with no deployment id.
  const untagged = fakes({ gitmatrix: live("dep-2", "ver-2") }, {});
  await recordDeployed(untagged.recorder, {
    worker: "gitmatrix",
    cwd: "/w",
    head: HEAD,
    previous: null,
  });
  assert.deepEqual(untagged.calls, []);
  const anonymous = fakes(
    { gitmatrix: { deployments: [{ versions: [{ version_id: "ver-2", percentage: 100 }] }] } },
    { "ver-2": HEAD },
  );
  await recordDeployed(anonymous.recorder, {
    worker: "gitmatrix",
    cwd: "/w",
    head: HEAD,
    previous: null,
  });
  assert.deepEqual(anonymous.calls, []);
});

await test("the active version is the one with most traffic", async () => {
  const { recorder, calls } = fakes(
    {
      gitmatrix: {
        deployments: [
          {
            id: "dep-split",
            versions: [
              { version_id: "ver-old", percentage: 10 },
              { version_id: "ver-new", percentage: 90 },
            ],
          },
        ],
      },
    },
    { "ver-new": HEAD, "ver-old": "c".repeat(40) },
  );
  await recordDeployed(recorder, {
    worker: "gitmatrix",
    cwd: "/w",
    head: HEAD,
    previous: "ver-old",
  });
  assert.equal(flag(calls[0]!, "--provider-version"), "ver-new");
  assert.equal(flag(calls[0]!, "--percentage"), "90");
  assert.equal(flag(calls[0]!, "--replaces"), "ver-old");
});

await test("a recording failure only warns: the deploy stands and the next Worker still goes", async () => {
  const { recorder, calls, events } = fakes(
    { gitmatrix: live("dep-web", "ver-web"), "gitmatrix-site": live("dep-site", "ver-site") },
    { "ver-web": HEAD, "ver-site": HEAD },
    async (args) => {
      if (args.includes("gitmatrix")) throw new Error("HTTP 503 from the server");
      return '{"id": 7}';
    },
  );
  let siteDeployed = false;
  await deployAndRecord(
    [
      { worker: "gitmatrix", cwd: "/w", deploy: () => ({ deployed: true, previous: null }) },
      {
        worker: "gitmatrix-site",
        cwd: "/s",
        deploy: () => {
          siteDeployed = true;
          return { deployed: true, previous: null };
        },
      },
    ],
    HEAD,
    () => recorder,
  );
  assert.equal(siteDeployed, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(events[0], {
    event: "deploy.record.skipped",
    worker: "gitmatrix",
    head: HEAD,
    reason: "recording failed; the deploy stands",
    error: "HTTP 503 from the server",
  });
  assert.equal(events[1]!.event, "deploy.recorded");
  // A cf lookup that fails warns the same way.
  const broken = fakes({}, {});
  assert.equal(
    await recordDeployed(broken.recorder, {
      worker: "gitmatrix",
      cwd: "/w",
      head: HEAD,
      previous: null,
    }),
    false,
  );
  assert.match(String(broken.events[0]!.error), /not found/);
});

await test("a deploy that fails stops before recording, as before", async () => {
  const { recorder, calls } = fakes({}, {});
  await assert.rejects(
    deployAndRecord(
      [
        {
          worker: "gitmatrix",
          cwd: "/w",
          deploy: () => {
            throw new Error("cf deploy failed");
          },
        },
      ],
      HEAD,
      () => recorder,
    ),
    /cf deploy failed/,
  );
  assert.deepEqual(calls, []);
});

await test("production URLs come from the hosts the deploy's secrets set", () => {
  assert.deepEqual(productionUrls({}), { gitmatrix: APP_URL, "gitmatrix-site": SITE_URL });
  assert.deepEqual(productionUrls(SECRETS), {
    gitmatrix: "https://timelines.acme.dev",
    "gitmatrix-site": "https://www.acme.dev",
  });
});

await test("a deploy needs every one of its secrets", () => {
  assert.deepEqual(missingDeploySecrets(SECRETS), []);
  assert.deepEqual(missingDeploySecrets({}), [...DEPLOY_SECRETS]);
  assert.deepEqual(missingDeploySecrets({ ...SECRETS, GITMATRIX_SITE_HOST: " " }), [
    "GITMATRIX_SITE_HOST",
  ]);
  assert.equal(DEPLOY_SECRETS.length, 8);
});

await test("a deploy refuses secrets that don't name the live Worker's resources", () => {
  const live = liveBindings([
    { type: "d1", name: "DB", id: SECRETS.GITMATRIX_PRODUCTION_DB_ID },
    { type: "d1", name: "REGISTRY_DB", id: SECRETS.GITMATRIX_PRODUCTION_REGISTRY_DB_ID },
    {
      type: "secrets_store_secret",
      name: "REGISTRY_KEK_SECRET",
      store_id: SECRETS.GITMATRIX_PRODUCTION_SECRETS_STORE_ID,
    },
    {
      type: "secrets_store_secret",
      name: "BETTER_AUTH_SECRET_SECRET",
      store_id: SECRETS.GITMATRIX_PRODUCTION_SECRETS_STORE_ID,
    },
    { type: "plain_text", name: "OWNER_ORG", text: "acme" },
    {
      type: "plain_text",
      name: "PUBLIC_URL",
      text: `https://${SECRETS.GITMATRIX_PRODUCTION_HOST}`,
    },
    { type: "plain_text", name: "OWNER_EMAIL", text: SECRETS.GITMATRIX_PRODUCTION_OWNER_EMAIL },
    { type: "plain_text", name: "EMAIL_FROM", text: SECRETS.GITMATRIX_PRODUCTION_EMAIL_FROM },
  ]);
  assert.deepEqual(live.stores, [SECRETS.GITMATRIX_PRODUCTION_SECRETS_STORE_ID]);
  assert.deepEqual(bindingMismatches(live, SECRETS), []);
  const swapped = {
    ...SECRETS,
    GITMATRIX_PRODUCTION_DB_ID: SECRETS.GITMATRIX_PRODUCTION_REGISTRY_DB_ID,
    GITMATRIX_PRODUCTION_REGISTRY_DB_ID: SECRETS.GITMATRIX_PRODUCTION_DB_ID,
  };
  assert.deepEqual(bindingMismatches(live, swapped), [
    "GITMATRIX_PRODUCTION_DB_ID isn't the live DB binding's database",
    "GITMATRIX_PRODUCTION_REGISTRY_DB_ID isn't the live REGISTRY_DB binding's database",
  ]);
  assert.match(
    bindingMismatches(live, {
      ...SECRETS,
      GITMATRIX_PRODUCTION_SECRETS_STORE_ID: "f".repeat(32),
    }).join(),
    /GITMATRIX_PRODUCTION_SECRETS_STORE_ID/,
  );
  // A live version without a store binding can't vouch for the secret.
  assert.equal(bindingMismatches({ ...live, stores: [] }, SECRETS).length, 1);
  // The live public URL, owner and sender must be the ones the deploy would set.
  assert.deepEqual(
    bindingMismatches(live, { ...SECRETS, GITMATRIX_PRODUCTION_HOST: "other.example.com" }),
    [
      `GITMATRIX_PRODUCTION_HOST doesn't give the live PUBLIC_URL (https://${SECRETS.GITMATRIX_PRODUCTION_HOST})`,
    ],
  );
  assert.match(
    bindingMismatches(live, {
      ...SECRETS,
      GITMATRIX_PRODUCTION_OWNER_EMAIL: "x@example.com",
    }).join(),
    /GITMATRIX_PRODUCTION_OWNER_EMAIL doesn't give the live OWNER_EMAIL/,
  );
  assert.match(
    bindingMismatches(live, {
      ...SECRETS,
      GITMATRIX_PRODUCTION_EMAIL_FROM: "x@example.com",
    }).join(),
    /GITMATRIX_PRODUCTION_EMAIL_FROM doesn't give the live EMAIL_FROM/,
  );
  // GITMATRIX_PUBLIC_URL overrides the URL the config binds.
  assert.deepEqual(
    bindingMismatches(live, { ...SECRETS, GITMATRIX_PUBLIC_URL: "https://x.test" }).length,
    1,
  );
  // A text variable the live Worker doesn't bind yet is not a mismatch.
  assert.deepEqual(bindingMismatches({ ...live, texts: {} }, SECRETS), []);
});

await test("both Workers deploy before anything is recorded; a later failed deploy still records the first", async () => {
  const order: string[] = [];
  const { recorder } = fakes(
    { gitmatrix: live("dep-web", "ver-web"), "gitmatrix-site": live("dep-site", "ver-site") },
    { "ver-web": HEAD, "ver-site": HEAD },
    async (args) => {
      order.push(`record ${args[args.indexOf("--service") + 1]}`);
      return '{"id": 1}';
    },
  );
  const deploying = (worker: string) => ({
    worker,
    cwd: "/x",
    deploy: () => {
      order.push(`deploy ${worker}`);
      return { deployed: true, previous: null };
    },
  });
  await deployAndRecord(
    [deploying("gitmatrix"), deploying("gitmatrix-site")],
    HEAD,
    () => recorder,
  );
  assert.deepEqual(order, [
    "deploy gitmatrix",
    "deploy gitmatrix-site",
    "record gitmatrix",
    "record gitmatrix-site",
  ]);
  order.length = 0;
  await assert.rejects(
    deployAndRecord(
      [
        deploying("gitmatrix"),
        {
          worker: "gitmatrix-site",
          cwd: "/s",
          deploy: () => {
            throw new Error("site build failed");
          },
        },
      ],
      HEAD,
      () => recorder,
    ),
    /site build failed/,
  );
  assert.deepEqual(order, ["deploy gitmatrix", "record gitmatrix"]);
});

await test("recording has a budget: past it, what isn't recorded is skipped and gm is stopped", async () => {
  let stopped: unknown;
  const events: Record<string, unknown>[] = [];
  const recorder = (signal: AbortSignal) =>
    liveRecorder(signal, {
      env: {},
      cf: (args) =>
        args[1] === "deployments"
          ? JSON.stringify(live("dep-web", "ver-web"))
          : JSON.stringify({ annotations: { "workers/tag": HEAD } }),
      tempDir: async () => "/tmp/gm-dir",
      removeDir: async () => {},
      // An install that hangs, as a stalled download would.
      install: () =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => {
            stopped = signal.reason;
            reject(new Error("aborted"));
          }),
        ),
      exec: async () => "{}",
    });
  const started = Date.now();
  await deployAndRecord(
    [
      { worker: "gitmatrix", cwd: "/w", deploy: () => ({ deployed: true, previous: null }) },
      { worker: "gitmatrix-site", cwd: "/s", deploy: () => ({ deployed: true, previous: null }) },
    ],
    HEAD,
    (signal) => ({ ...recorder(signal), log: (event) => events.push(event) }),
    50,
  );
  assert.ok(Date.now() - started < 5_000, "The budget bounds recording");
  assert.match(String(stopped), /longer than 0.05s/);
  const skipped = events.filter((e) => e.event === "deploy.record.skipped");
  assert.deepEqual(
    skipped.map((e) => String(e.worker)).toSorted((a, b) => a.localeCompare(b)),
    ["gitmatrix", "gitmatrix-site"],
    "Each Worker not recorded is logged once as skipped",
  );
  assert.ok(skipped.every((e) => /ran out of its 0.05s/.test(String(e.reason))));
  // What the abandoned attempt logs afterwards is dropped.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 2);
});

await test("liveRecorder: cf and gm wiring, one install, and no Cloudflare token for gm", async () => {
  const cfCalls: [string[], string, number][] = [];
  const execs: { file: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number }[] = [];
  let installs = 0;
  let removed: string | undefined;
  const recorder = liveRecorder(new AbortController().signal, {
    env: { CLOUDFLARE_API_TOKEN: "cf-secret", GITMATRIX_TOKEN: "gmj_job", PATH: "/bin" },
    cf: (args, cwd, timeout) => {
      cfCalls.push([args, cwd, timeout]);
      return args[1] === "deployments"
        ? JSON.stringify(live("dep-web", "ver-web"))
        : JSON.stringify({ annotations: { "workers/tag": HEAD } });
    },
    tempDir: async () => "/tmp/gm-dir",
    removeDir: async (path) => {
      removed = path;
    },
    install: async (env, directory) => {
      installs++;
      assert.equal(env.GITMATRIX_TOKEN, "gmj_job", "Installing uses the job's credential");
      return `${directory}/gm`;
    },
    exec: async (file, args, options) => {
      execs.push({ file, args, env: options.env, timeout: options.timeout });
      return '{"id": 9}';
    },
  });
  for (const worker of ["gitmatrix", "gitmatrix-site"])
    assert.equal(
      await recordDeployed(recorder, { worker, cwd: `/${worker}`, head: HEAD, previous: null }),
      true,
    );
  assert.deepEqual(
    cfCalls.map(([args, cwd]) => [args.join(" "), cwd]),
    [
      ["workers deployments list --worker gitmatrix", "/gitmatrix"],
      ["workers versions get ver-web --worker-id gitmatrix", "/gitmatrix"],
      ["workers deployments list --worker gitmatrix-site", "/gitmatrix-site"],
      ["workers versions get ver-web --worker-id gitmatrix-site", "/gitmatrix-site"],
    ],
  );
  assert.ok(cfCalls.every(([, , timeout]) => timeout > 0 && timeout <= 60_000));
  assert.equal(installs, 1, "gm is installed once");
  assert.equal(execs.length, 2);
  assert.ok(execs.every((e) => e.file === "/tmp/gm-dir/gm"));
  assert.deepEqual(execs[0]!.args.slice(0, 2), ["deploy", "record"]);
  assert.ok(
    execs.every((e) => !("CLOUDFLARE_API_TOKEN" in e.env) && e.env.GITMATRIX_TOKEN === "gmj_job"),
    "gm runs as the job, without Cloudflare's token",
  );
  await recorder.close();
  assert.equal(removed, "/tmp/gm-dir");
});

await test("liveRecorder: a failed install or temp directory only warns, and makes nothing", async () => {
  for (const overrides of [
    { install: async () => Promise.reject(new Error("Downloading gm 1.2 returned HTTP 502.")) },
    { tempDir: async () => Promise.reject(new Error("ENOSPC")) },
  ]) {
    const events: Record<string, unknown>[] = [];
    let execs = 0;
    const recorder = liveRecorder(new AbortController().signal, {
      env: {},
      cf: (args) =>
        args[1] === "deployments"
          ? JSON.stringify(live("dep-web", "ver-web"))
          : JSON.stringify({ annotations: { "workers/tag": HEAD } }),
      tempDir: async () => "/tmp/gm-dir",
      removeDir: async () => {},
      install: async () => "/tmp/gm-dir/gm",
      exec: async () => {
        execs++;
        return "{}";
      },
      ...overrides,
    });
    const recorded = await recordDeployed(
      { ...recorder, log: (event) => events.push(event) },
      { worker: "gitmatrix", cwd: "/w", head: HEAD, previous: null },
    );
    assert.equal(recorded, false);
    assert.equal(execs, 0);
    assert.equal(events[0]!.event, "deploy.record.skipped");
    assert.match(String(events[0]!.error), /HTTP 502|ENOSPC/);
  }
});
