import assert from "node:assert/strict";
import { test } from "node:test";
import { plan } from "./deploy.ts";

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
