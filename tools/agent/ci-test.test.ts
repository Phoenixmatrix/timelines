import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ciTestPlan, websiteRunnerFiles, websiteRuns, type CiTestPlan } from "./ci-test.ts";
import { websiteTestSelection } from "./ready-plan.ts";

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");
const workspaces = [
  "apps/cli",
  "apps/website",
  "apps/site",
  "tools/agent",
  "tools/preview",
  "tools/remote",
  "packages/formats",
  "packages/testing",
];

/** A committed baseline plus a CI environment naming it, then `run` changes the tree. */
async function fixture(
  run: (
    plan: () => ReturnType<typeof ciTestPlan>,
    put: (path: string, content?: string) => Promise<void>,
    git: (args: string[]) => Promise<string>,
    env: NodeJS.ProcessEnv,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "ci-test-"));
  const git = async (args: string[]) =>
    (
      await exec("git", args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "CI test",
          GIT_AUTHOR_EMAIL: "ci@example.invalid",
          GIT_COMMITTER_NAME: "CI test",
          GIT_COMMITTER_EMAIL: "ci@example.invalid",
        },
      })
    ).stdout.trim();
  const put = async (path: string, content = "changed\n") => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  try {
    await git(["init", "-b", "main"]);
    for (const workspace of workspaces)
      await put(
        `${workspace}/package.json`,
        await readFile(join(repository, workspace, "package.json"), "utf8"),
      );
    await put(".gitignore", ".cloudflare/\n");
    await put("apps/website/.cloudflare/types/index.d.ts", "// generated\n");
    await put("pnpm-lock.yaml", "lockfileVersion: 9\n");
    await put(".gitmatrix/ci.yml", "jobs: {}\n");
    await git(["add", "."]);
    await git(["commit", "-m", "baseline"]);
    const base = await git(["rev-parse", "HEAD"]);
    const env = {
      GITMATRIX_COMMIT: base,
      GITMATRIX_VERIFIED_BASE: JSON.stringify({ commit: base, runNumber: 1, jobId: "test-1" }),
    };
    await run(() => ciTestPlan(root, env), put, git, env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test("the real website README is read by worker/ci/config.test.ts", async () => {
  assert.ok(
    websiteTestSelection(["apps/website/README.md"], repository).files.includes(
      "worker/ci/config.test.ts",
    ),
  );
});

await test("without a verified baseline the full suite runs", async () => {
  await fixture(async (_plan, _put, _git, env) => {
    const root = await mkdtemp(join(tmpdir(), "ci-test-none-"));
    try {
      const plan = await ciTestPlan(root, { ...env, GITMATRIX_VERIFIED_BASE: undefined });
      assert.equal(plan.full, true);
      assert.equal(plan.baseline, null);
      assert.equal(plan.websiteUnit, "all");
      assert.equal(plan.websiteBrowser, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

await test("a documentation change runs no tests", async () => {
  await fixture(async (plan, put) => {
    await put("README.md");
    const selected = await plan();
    assert.equal(selected.full, false);
    assert.deepEqual(selected.workspaces, []);
    assert.equal(selected.websiteUnit, "none");
    assert.equal(selected.websiteBrowser, false);
  });
});

await test("a gm change tests the site that reads its manifest, not the website", async () => {
  await fixture(async (plan, put) => {
    await put("apps/cli/src/main.rs");
    const selected = await plan();
    assert.equal(selected.full, false);
    assert.ok(selected.workspaces.includes("site"));
    assert.equal(selected.workspaces.includes("cli"), false);
    assert.equal(selected.websiteUnit, "none");
    assert.equal(selected.websiteBrowser, false);
  });
});

await test("a website source change runs related unit tests and all browser tests", async () => {
  await fixture(async (plan, put) => {
    await put("apps/website/worker/foo.ts");
    const selected = await plan();
    assert.equal(selected.websiteUnit, "changed");
    assert.equal(selected.websiteBrowser, true);
  });
});

await test("a website unit test file alone skips the browser project", async () => {
  await fixture(async (plan, put) => {
    await put("apps/website/worker/foo.test.ts");
    const selected = await plan();
    assert.equal(selected.websiteUnit, "changed");
    assert.equal(selected.websiteBrowser, false);
  });
});

await test("a browser test file runs the browser project", async () => {
  await fixture(async (plan, put) => {
    await put("apps/website/src/X.browser.test.tsx");
    const selected = await plan();
    assert.equal(selected.websiteUnit, "changed");
    assert.equal(selected.websiteBrowser, true);
  });
});

await test("paths that imports cannot trace run every website unit test", async () => {
  await fixture(async (plan, put, git) => {
    for (const path of [
      "apps/website/migrations/20260101000000_add.sql",
      "apps/website/src/styles/app.css",
      "apps/website/vite.config.ts",
      "apps/website/tsconfig.json",
      "apps/website/worker/testing/runtime.ts",
    ]) {
      await put(path);
      const selected = await plan();
      assert.equal(selected.websiteUnit, "all", path);
      assert.equal(selected.websiteBrowser, true, path);
      await git(["clean", "-fdq"]);
    }
  });
});

await test("a shared package change runs everything that consumes it", async () => {
  await fixture(async (plan, put) => {
    await put("packages/formats/src/x.ts");
    const selected = await plan();
    assert.equal(selected.full, false);
    assert.ok(selected.workspaces.includes("formats"));
    assert.equal(selected.websiteUnit, "all");
    assert.equal(selected.websiteBrowser, true);
  });
});

await test("a harness change selects its workspace instead of the full suite", async () => {
  await fixture(async (plan, put) => {
    await put("tools/agent/helper.ts");
    const selected = await plan();
    assert.equal(selected.full, false);
    assert.ok(selected.workspaces.includes("agent"));
    assert.equal(selected.websiteUnit, "none");
    assert.equal(selected.websiteBrowser, false);
  });
});

await test("the lockfile, CI configuration and workspace manifests select the full suite", async () => {
  await fixture(async (plan, put, git) => {
    for (const path of ["pnpm-lock.yaml", ".gitmatrix/ci.yml", "packages/testing/package.json"]) {
      await put(path, "changed\n");
      const selected = await plan();
      assert.equal(selected.full, true, path);
      assert.equal(selected.websiteUnit, "all", path);
      assert.equal(selected.websiteBrowser, true, path);
      await git(["checkout", "--", path]);
    }
  });
});

await test("a remote runtime change runs the agent tests that import it", async () => {
  await fixture(async (plan, put) => {
    await put("tools/remote/runtime.mjs");
    const selected = await plan();
    assert.equal(selected.full, false);
    assert.ok(selected.workspaces.includes("agent"));
  });
});

await test("a change to the website's test runner runs every website test", async () => {
  await fixture(async (plan, put, git) => {
    for (const path of ["tools/agent/website-tests.ts", "tools/agent/heavy.ts"]) {
      await put(path);
      const selected = await plan();
      assert.equal(selected.full, false, path);
      assert.equal(selected.websiteUnit, "all", path);
      assert.equal(selected.websiteBrowser, true, path);
      await git(["clean", "-fdq"]);
    }
  });
});

await test("the test runner's files follow its relative imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "ci-test-runner-"));
  try {
    await mkdir(join(root, "tools/agent"), { recursive: true });
    await writeFile(
      join(root, "tools/agent/website-tests.ts"),
      'import { a } from "./a.ts";\nimport { x } from "node:path";\n',
    );
    await writeFile(join(root, "tools/agent/a.ts"), 'export { b } from "./b.ts";\n');
    await writeFile(join(root, "tools/agent/b.ts"), "export const b = 1;\n");
    assert.deepEqual(websiteRunnerFiles(root), [
      "tools/agent/a.ts",
      "tools/agent/b.ts",
      "tools/agent/heavy.ts",
      "tools/agent/website-tests.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.ok(websiteRunnerFiles(repository).includes("tools/agent/heavy.ts"));
});

await test("the website README, which a unit test reads, runs the changed unit tests only", async () => {
  await fixture(async (plan, put) => {
    await put("apps/website/README.md");
    await put("apps/website/worker/ci/fake.test.ts", "// reads ../../README.md\n");
    const selected = await plan();
    assert.equal(selected.full, false);
    assert.equal(selected.websiteUnit, "changed");
    assert.deepEqual(selected.websiteFiles, ["worker/ci/fake.test.ts"]);
    assert.equal(selected.websiteBrowser, false);
  });
});

await test("the runner turns a website selection into website-tests.ts calls", () => {
  const plan = (over: Partial<CiTestPlan>): CiTestPlan => ({
    full: false,
    baseline: { commit: "b".repeat(40), runNumber: 1, jobId: "job" },
    changed: [],
    reasons: [],
    workspaces: [],
    websiteUnit: "none",
    websiteFiles: [],
    websiteBrowser: false,
    ...over,
  });
  assert.deepEqual(websiteRuns(plan({})), []);
  assert.deepEqual(websiteRuns(plan({ websiteUnit: "all", websiteBrowser: true })), [[]]);
  assert.deepEqual(websiteRuns(plan({ websiteUnit: "changed", websiteBrowser: true })), [
    ["--project", "unit", "--passWithNoTests", `--changed=${"b".repeat(40)}`],
    ["--project", "browser"],
  ]);
  // A README change: its readers run by name, apart from (and not narrowed by) --changed.
  assert.deepEqual(
    websiteRuns(plan({ websiteUnit: "changed", websiteFiles: ["worker/ci/config.test.ts"] })),
    [
      ["--project", "unit", "--passWithNoTests", `--changed=${"b".repeat(40)}`],
      ["--project", "unit", "worker/ci/config.test.ts"],
    ],
  );
  assert.deepEqual(
    websiteRuns(plan({ websiteUnit: "none", websiteFiles: ["worker/ci/config.test.ts"] })),
    [["--project", "unit", "worker/ci/config.test.ts"]],
  );
  // The whole unit project already includes them.
  assert.deepEqual(
    websiteRuns(plan({ websiteUnit: "all", websiteFiles: ["worker/ci/config.test.ts"] })),
    [["--project", "unit", "--passWithNoTests"]],
  );
});
