import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

// The CI image bakes Chromium's headless shell for one Playwright version
// (CORE-248). A stale image still works, but its test job fetches the new
// revision on every run, so a Playwright upgrade bumps the Dockerfile's ARG in
// the same change; the image then deploys from a machine with Docker
// (`vp run deploy` in apps/website).

const root = resolve(import.meta.dirname, "../..");

/** The playwright version apps/website resolves to in a pnpm (v9) lockfile. */
function websitePlaywright(lockfile: string): string | undefined {
  const importer = /^ {2}apps\/website:\n((?: {4}.*\n|\n)*)/m.exec(lockfile)?.[1] ?? "";
  return /^ {6}playwright:\n {8}specifier: .*\n {8}version: ([^\s(]+)/m.exec(importer)?.[1];
}

await test("the CI image bakes the headless shell for the lockfile's Playwright", async () => {
  const dockerfile = await readFile(resolve(root, "apps/website/ci/Dockerfile"), "utf8");
  const lockfile = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
  const baked = /^ARG PLAYWRIGHT_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
  const locked = websitePlaywright(lockfile);
  assert.ok(locked, "apps/website resolves no playwright in pnpm-lock.yaml");
  assert.equal(
    baked,
    locked,
    "apps/website/ci/Dockerfile's PLAYWRIGHT_VERSION must match pnpm-lock.yaml; " +
      "bump it and redeploy the CI image from a machine with Docker (`vp run deploy` in apps/website)",
  );
});
