import assert from "node:assert/strict";
import { test } from "node:test";
import { plan, sitePlan } from "./deploy.ts";

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
