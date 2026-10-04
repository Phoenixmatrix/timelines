import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  browserDirectories,
  browsersRegistry,
  directoriesInUse,
  isBrowserDirectory,
  lockfileVersions,
  planPrune,
  pruneBrowsers,
} from "./browsers.ts";

await test("browser directories follow Playwright's naming, including platform overrides", () => {
  assert.deepEqual(
    browserDirectories([
      { name: "chromium", revision: "1243" },
      { name: "chromium-headless-shell", revision: "1243" },
      { name: "webkit", revision: "2359", revisionOverrides: { mac14: "2251" } },
      { name: "ffmpeg", revision: "1011" },
    ]),
    [
      "chromium-1243",
      "chromium_headless_shell-1243",
      "webkit-2359",
      "webkit_mac14_special-2251",
      "ffmpeg-1011",
    ],
  );
});

await test("only Playwright revision directories are prune candidates", () => {
  for (const name of [
    "chromium-1228",
    "chromium_headless_shell-1248",
    "chromium_tip_of_tree_headless_shell-1433",
    "ffmpeg-1013",
    "webkit-2182",
  ])
    assert.equal(isBrowserDirectory(name), true, name);
  for (const name of [".links", "__dirlock", "mcp-chrome-profile", "chrome", "chromium"])
    assert.equal(isBrowserDirectory(name), false, name);
});

await test("lockfile versions include every linked playwright-core", () => {
  const lockfile = [
    "packages:",
    "  '@playwright/test@1.63.0':",
    "  playwright-core@1.63.0:",
    "    resolution: {integrity: sha512-x}",
    "  'playwright-core@1.64.0-alpha-2026-10-03':",
    "snapshots:",
    "  playwright-core@1.63.0: {}",
    "  playwright@1.63.0:",
    "    dependencies:",
    "      playwright-core: 1.62.0",
  ].join("\n");
  assert.deepEqual(lockfileVersions(lockfile), ["1.63.0", "1.64.0-alpha-2026-10-03"]);
});

await test("registry follows PLAYWRIGHT_BROWSERS_PATH and XDG_CACHE_HOME", () => {
  assert.equal(browsersRegistry({ PLAYWRIGHT_BROWSERS_PATH: "/srv/pw" }), "/srv/pw");
  assert.equal(browsersRegistry({ PLAYWRIGHT_BROWSERS_PATH: "0" }), undefined);
  assert.equal(browsersRegistry({ XDG_CACHE_HOME: "/c" }), "/c/ms-playwright");
});

await test("in-use detection maps process paths to revision directories", () => {
  assert.deepEqual(
    [
      ...directoriesInUse("/cache/ms-playwright/", [
        "/cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
        "/cache/ms-playwright/chromium_headless_shell-1243/libEGL.so",
        "/cache/ms-playwright-other/chromium-1/chrome",
        "/usr/lib/libc.so.6",
      ]),
    ].sort(),
    ["chromium-1243", "chromium_headless_shell-1243"],
  );
});

await test("plan keeps needed, in-use and other installs' revisions and never touches other entries", () => {
  const plan = planPrune({
    entries: [
      ".links",
      "__dirlock",
      "mcp-chrome-profile",
      "chromium-1228",
      "chromium-1243",
      "chromium_headless_shell-1243",
      "chromium_headless_shell-1248",
      "webkit-2182",
      ".gitmatrix-prune-chromium-1105.42",
    ],
    needed: new Map([
      ["chromium-1243", ["playwright-core@1.63.0"]],
      ["chromium_headless_shell-1243", ["playwright-core@1.63.0"]],
    ]),
    inUse: new Map([["chromium_headless_shell-1248", [7]]]),
    otherInstalls: new Map([["chromium-1228", ["/npx/playwright-core (1.61.1)"]]]),
    includeOtherInstalls: false,
  });
  assert.deepEqual(plan.keep, [
    { name: "chromium-1228", reasons: ["registered by /npx/playwright-core (1.61.1)"] },
    { name: "chromium-1243", reasons: ["needed by playwright-core@1.63.0"] },
    { name: "chromium_headless_shell-1243", reasons: ["needed by playwright-core@1.63.0"] },
    { name: "chromium_headless_shell-1248", reasons: ["in use by pid 7"] },
  ]);
  assert.deepEqual(plan.heldByOtherInstalls, [
    { name: "chromium-1228", registeredBy: ["/npx/playwright-core (1.61.1)"] },
  ]);
  assert.deepEqual(plan.remove, [
    { name: ".gitmatrix-prune-chromium-1105.42", registeredBy: [] },
    { name: "webkit-2182", registeredBy: [] },
  ]);
});

await test("plan removes other installs' revisions only when asked, unless needed or in use", () => {
  const plan = planPrune({
    entries: ["chromium-1228", "chromium_headless_shell-1228", "webkit-2182"],
    needed: new Map(),
    inUse: new Map([["chromium_headless_shell-1228", [9]]]),
    otherInstalls: new Map([
      ["chromium-1228", ["/npx/playwright-core (1.61.1)"]],
      ["chromium_headless_shell-1228", ["/npx/playwright-core (1.61.1)"]],
    ]),
    includeOtherInstalls: true,
  });
  assert.deepEqual(plan.keep, [
    { name: "chromium_headless_shell-1228", reasons: ["in use by pid 9"] },
  ]);
  assert.deepEqual(plan.heldByOtherInstalls, []);
  assert.deepEqual(plan.remove, [
    { name: "chromium-1228", registeredBy: ["/npx/playwright-core (1.61.1)"] },
    { name: "webkit-2182", registeredBy: [] },
  ]);
});

async function fakePlaywright(path: string, version: string, revision: string, ffmpeg = "1011") {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "playwright-core", version }));
  await writeFile(
    join(path, "browsers.json"),
    JSON.stringify({
      browsers: [
        { name: "chromium", revision },
        { name: "chromium-headless-shell", revision },
        { name: "ffmpeg", revision: ffmpeg },
      ],
    }),
  );
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "agent-browsers-"));
  const registry = join(base, "ms-playwright");
  const worktree = join(base, "worktree");
  const current = join(worktree, "node_modules", ".pnpm", "node_modules", "playwright-core");
  await fakePlaywright(current, "1.63.0", "1243");
  await writeFile(join(worktree, "pnpm-lock.yaml"), "packages:\n  playwright-core@1.63.0:\n");
  const other = join(base, "npx", "playwright-core");
  await fakePlaywright(other, "1.61.1", "1228");
  await mkdir(join(registry, ".links"), { recursive: true });
  await writeFile(join(registry, ".links", "a"), other);
  await writeFile(join(registry, ".links", "b"), join(base, "deleted", "playwright-core"));
  for (const name of [
    "chromium_headless_shell-1243",
    "ffmpeg-1011",
    "chromium-1228",
    "chromium_headless_shell-1228",
    "chromium_headless_shell-1248",
    "chromium_headless_shell-1200",
    "mcp-chrome-profile",
  ]) {
    await mkdir(join(registry, name, "bin"), { recursive: true });
    await writeFile(join(registry, name, "bin", "chrome"), "x".repeat(10_000));
  }
  return { base, registry, worktree };
}

await test("prune dry-run reports exactly what a real prune removes", async () => {
  const { base, registry, worktree } = await fixture();
  try {
    const processes = async () =>
      new Map([[99, [join(registry, "chromium_headless_shell-1248", "bin", "chrome")]]]);
    const options = { root: worktree, registry, worktrees: [worktree], processes };
    const before = (await readdir(registry)).sort();
    const dry = await pruneBrowsers({ ...options, dryRun: true });
    assert.deepEqual((await readdir(registry)).sort(), before);
    assert.deepEqual(dry.versions, { "1.63.0": [worktree] });
    assert.deepEqual(
      dry.keep.map(({ name }) => name),
      [
        "chromium-1228",
        "chromium_headless_shell-1228",
        "chromium_headless_shell-1243",
        "chromium_headless_shell-1248",
        "ffmpeg-1011",
      ],
    );
    // Only the revision no live install registered goes by default.
    assert.deepEqual(
      dry.remove.map(({ name }) => name),
      ["chromium_headless_shell-1200"],
    );
    // The dry run lists what --include-other-installs would add.
    assert.deepEqual(
      dry.heldByOtherInstalls.map(({ name, registeredBy }) => [name, registeredBy.length]),
      [
        ["chromium-1228", 1],
        ["chromium_headless_shell-1228", 1],
      ],
    );
    assert.ok(dry.bytesFreed > 0 && dry.bytesHeldByOtherInstalls > 0);

    const real = await pruneBrowsers({ ...options, dryRun: false });
    assert.deepEqual(
      real.remove.map(({ name, removed }) => [name, removed]),
      dry.remove.map(({ name }) => [name, true]),
    );
    assert.equal(real.bytesFreed, dry.bytesFreed);
    assert.ok((await readdir(registry)).includes("chromium-1228"));

    const include = { ...options, includeOtherInstalls: true };
    const dryAll = await pruneBrowsers({ ...include, dryRun: true });
    assert.deepEqual(
      dryAll.remove.map(({ name }) => name),
      dry.heldByOtherInstalls.map(({ name }) => name),
    );
    assert.deepEqual(dryAll.heldByOtherInstalls, []);
    const all = await pruneBrowsers({ ...include, dryRun: false });
    assert.ok(all.remove.every(({ removed }) => removed));
    assert.deepEqual((await readdir(registry)).sort(), [
      ".links",
      "chromium_headless_shell-1243",
      "chromium_headless_shell-1248",
      "ffmpeg-1011",
      "mcp-chrome-profile",
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

await test("prune keeps a revision that starts being used during deletion", async () => {
  const { base, registry, worktree } = await fixture();
  try {
    let scans = 0;
    // The second scan sees a process that opened the renamed directory.
    const processes = async () =>
      new Map(
        scans++ === 0
          ? []
          : [
              [
                5,
                (await readdir(registry))
                  .filter((name) => name.includes("chromium-1228"))
                  .map((name) => join(registry, name, "bin", "chrome")),
              ],
            ],
      );
    const report = await pruneBrowsers({
      root: worktree,
      registry,
      worktrees: [worktree],
      processes,
      dryRun: false,
      includeOtherInstalls: true,
    });
    assert.equal(report.remove.find(({ name }) => name === "chromium-1228")?.removed, false);
    assert.ok((await readdir(registry)).includes("chromium-1228"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

await test("prune refuses unresolved versions and an active install lock", async () => {
  const { base, registry, worktree } = await fixture();
  try {
    const processes = async () => new Map<number, string[]>();
    const options = { root: worktree, registry, worktrees: [worktree], processes, dryRun: false };
    await writeFile(join(worktree, "pnpm-lock.yaml"), "packages:\n  playwright-core@1.70.0:\n");
    await assert.rejects(pruneBrowsers(options), /playwright-core 1\.70\.0.*refusing to guess/s);
    await writeFile(join(worktree, "pnpm-lock.yaml"), "packages:\n  playwright-core@1.63.0:\n");
    await mkdir(join(registry, "__dirlock"));
    await assert.rejects(pruneBrowsers(options), /Playwright install holds/);
    assert.ok((await readdir(registry)).includes("chromium-1228"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
