import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  parseReadyOptions,
  readinessPlan,
  type ReadyOptions,
  type ReadyPlan,
} from "./ready-plan.ts";

const exec = promisify(execFile);
const options: ReadyOptions = { all: false, dryRun: false, base: "origin/main" };
const workspaces = [
  "apps/cli",
  "apps/website",
  "tools/agent",
  "tools/preview",
  "packages/formats",
  "packages/testing",
  "packages/utils",
];
const repository = resolve(import.meta.dirname, "../..");

async function fixture(
  run: (
    root: string,
    git: (args: string[]) => Promise<string>,
    put: (path: string, content?: string) => Promise<void>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "ready-plan-"));
  const git = async (args: string[]) =>
    (
      await exec("git", args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Readiness test",
          GIT_AUTHOR_EMAIL: "ready@example.invalid",
          GIT_COMMITTER_NAME: "Readiness test",
          GIT_COMMITTER_EMAIL: "ready@example.invalid",
        },
      })
    ).stdout;
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
    await git(["add", "."]);
    await git(["commit", "-m", "baseline"]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await run(root, git, put);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const names = (plan: ReadyPlan) => plan.gates.map((gate) => gate.name);
const targets = (plan: ReadyPlan) =>
  plan.gates.flatMap((gate) => gate.args.filter((arg) => arg.includes("#")));

await test("ready options accept explicit flags and reject malformed or unknown arguments", () => {
  assert.deepEqual(parseReadyOptions([]), options);
  assert.deepEqual(parseReadyOptions(["--all", "--dry-run", "--base", "HEAD~2"]), {
    all: true,
    dryRun: true,
    base: "HEAD~2",
  });
  assert.deepEqual(parseReadyOptions(["--base=topic"]), { ...options, base: "topic" });
  for (const args of [
    ["--base"],
    ["--base="],
    ["--base", "--all"],
    ["--base=-x"],
    ["--base= main"],
    ["--base=a\0b"],
    ["--wat"],
    ["--all=true"],
    ["HEAD"],
    ["--all", "--all"],
    ["--base=x", "--base", "y"],
  ])
    assert.throws(() => parseReadyOptions(args), Error, args.join(" "));
});

await test("unchanged and allowlisted documentation run only mandatory checks", async () => {
  await fixture(async (root, _git, put) => {
    assert.deepEqual(names(await readinessPlan(root, options)), ["check"]);
    await put("README.md");
    await put("apps/website/README.md");
    const plan = await readinessPlan(root, options);
    assert.deepEqual(names(plan), ["check"]);
    assert.equal(plan.full, false);
    assert.equal(plan.e2e, false);
    await rm(join(root, "apps/website/.cloudflare"), { recursive: true });
    const fresh = await readinessPlan(root, options);
    assert.deepEqual(names(fresh), ["bindings", "check"]);
    assert.deepEqual(fresh.gates[0], {
      name: "bindings",
      binary: "cf",
      args: ["workers", "types"],
      cwd: "website",
    });
  });
});

await test("website production changes propagate implicit TS consumers without Rust gates", async () => {
  await fixture(async (root, _git, put) => {
    await put("apps/website/src/routes/Home.tsx");
    const plan = await readinessPlan(root, options);
    assert.equal(plan.full, false);
    assert.equal(plan.e2e, true);
    assert.deepEqual(targets(plan), [
      "@gitmatrix/agent#typecheck",
      "@gitmatrix/agent#test",
      "@gitmatrix/preview#typecheck",
      "@gitmatrix/preview#test",
      "website#typecheck",
      "website#test",
      "website#build",
    ]);
    assert.deepEqual(names(plan).slice(0, 2), ["bindings", "check"]);
  });
});

await test("CLI changes select its whole Rust package, not website builds or workspace tests", async () => {
  for (const path of ["apps/cli/src/main.rs", "apps/cli/assets/prompt.md", "apps/cli/Cargo.toml"]) {
    await fixture(async (root, _git, put) => {
      await put(path);
      const plan = await readinessPlan(root, options);
      assert.equal(plan.full, false, path);
      assert.equal(plan.e2e, true, path);
      assert.deepEqual(targets(plan), ["cli#check", "cli#test", "cli#build"], path);
    });
  }
});

await test("manifest dependencies propagate formats and testing but keep utils isolated", async () => {
  for (const [workspace, expected, e2e] of [
    [
      "formats",
      [
        "@gitmatrix/formats#typecheck",
        "@gitmatrix/formats#test",
        "website#typecheck",
        "website#test",
        "website#build",
        "@gitmatrix/agent#typecheck",
        "@gitmatrix/preview#typecheck",
      ],
      true,
    ],
    [
      "testing",
      [
        "@gitmatrix/testing#typecheck",
        "@gitmatrix/testing#test",
        "website#typecheck",
        "website#test",
        "@gitmatrix/agent#typecheck",
        "@gitmatrix/preview#typecheck",
      ],
      false,
    ],
    ["utils", ["utils#test", "utils#build"], false],
  ] as const) {
    await fixture(async (root, _git, put) => {
      await put(`packages/${workspace}/src/index.ts`);
      const plan = await readinessPlan(root, options);
      assert.equal(plan.full, false);
      assert.equal(plan.e2e, e2e);
      for (const target of expected) assert.ok(targets(plan).includes(target), target);
      assert.ok(!targets(plan).some((target) => target.startsWith("cli#")));
      if (workspace === "testing")
        assert.ok(!targets(plan).some((target) => target.endsWith("#build")));
      if (workspace === "utils") assert.deepEqual(targets(plan), expected);
    });
  }
});

await test("manifest graph changes are read dynamically and propagated transitively", async () => {
  await fixture(async (root, git, put) => {
    const path = "packages/formats/package.json";
    const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
    manifest.dependencies.utils = "workspace:*";
    await put(path, JSON.stringify(manifest));
    await git(["add", path]);
    await git(["commit", "-m", "new workspace edge"]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await put("packages/utils/src/index.ts");
    const plan = await readinessPlan(root, options);
    assert.ok(targets(plan).includes("@gitmatrix/formats#test"));
    assert.ok(targets(plan).includes("website#build"));
    assert.ok(targets(plan).includes("@gitmatrix/preview#typecheck"));
    assert.equal(plan.e2e, true);
  });
});

await test("test-only changes select corresponding tests and types without build or E2E", async () => {
  for (const [path, expected] of [
    ["apps/website/src/routes/Home.browser.test.tsx", ["website#typecheck", "website#test"]],
    ["apps/website/worker/index.test.ts", ["website#typecheck", "website#test"]],
    ["apps/cli/tests/integration.rs", ["cli#check", "cli#test"]],
    ["tools/agent/environment.test.ts", ["@gitmatrix/agent#typecheck", "@gitmatrix/agent#test"]],
    ["tools/preview/preview.test.ts", ["@gitmatrix/preview#typecheck", "@gitmatrix/preview#test"]],
    [
      "packages/formats/src/hash.test.ts",
      ["@gitmatrix/formats#typecheck", "@gitmatrix/formats#test"],
    ],
  ] as const) {
    await fixture(async (root, _git, put) => {
      await put(path);
      const plan = await readinessPlan(root, options);
      assert.deepEqual(targets(plan), expected, path);
      assert.equal(plan.full, false, path);
      assert.equal(plan.e2e, false, path);
    });
  }
});

await test("preview tooling stays isolated from production app and CLI", async () => {
  await fixture(async (root, _git, put) => {
    await put("tools/preview/preview.ts");
    const plan = await readinessPlan(root, options);
    assert.deepEqual(targets(plan), ["@gitmatrix/preview#typecheck", "@gitmatrix/preview#test"]);
    assert.equal(plan.e2e, false);
  });
});

await test("unknown/global paths, task manifests and shared harness changes fail closed", async () => {
  for (const path of [
    "pnpm-lock.yaml",
    "vite.config.ts",
    "patches/cf.patch",
    "unknown.md",
    "packages/new/src/index.ts",
    "tools/new-tool/task.ts",
    "tools/agent/environment.ts",
    "tools/agent/ready-plan.ts",
    "tools/agent/ready-e2e.ts",
    "tools/agent/e2e.ts",
    "apps/website/package.json",
  ]) {
    await fixture(async (root, _git, put) => {
      await put(path);
      const plan = await readinessPlan(root, options);
      assert.equal(plan.full, true, path);
      assert.equal(plan.e2e, true, path);
      assert.ok(
        plan.reasons.some((reason) => reason.includes(path)),
        path,
      );
      assert.deepEqual(names(plan), [
        "bindings",
        "check",
        "cli-check",
        "types",
        "preview-types",
        "website-types",
        "formats-types",
        "testing-types",
        "tests",
        "build",
      ]);
      assert.deepEqual(plan.gates.at(-2)?.args, [
        "run",
        "-r",
        "--concurrency-limit",
        "1",
        "--no-cache",
        "test",
      ]);
      assert.deepEqual(plan.gates.at(-1)?.args, [
        "run",
        "-r",
        "--concurrency-limit",
        "1",
        "--no-cache",
        "build",
      ]);
    });
  }
});

await test("runtime markdown and fixtures are not discarded as documentation or tests", async () => {
  for (const path of [
    "apps/website/worker/templates/instructions.md",
    "apps/website/worker/fixtures/message.json",
    "packages/formats/src/fixtures/file.md",
  ]) {
    await fixture(async (root, _git, put) => {
      await put(path);
      const plan = await readinessPlan(root, options);
      assert.equal(plan.e2e, true, path);
      assert.ok(targets(plan).includes("website#build"), path);
    });
  }
});

await test("Git discovery preserves committed, staged, unstaged, deleted, renamed and special paths", async () => {
  await fixture(async (root, git, put) => {
    const prefix = "packages/utils/src/";
    const baseline = ["staged.ts", "unstaged.ts", "deleted.ts", "old name.ts", "cancelled.ts"];
    for (const name of baseline) await put(prefix + name, "original\n");
    await git(["add", "."]);
    await git(["commit", "-m", "files baseline"]);
    const base = (await git(["rev-parse", "HEAD"])).trim();
    await git(["update-ref", "refs/remotes/origin/main", base]);
    await put(prefix + "committed.ts");
    await git(["add", "."]);
    await git(["commit", "-m", "committed change"]);
    await put(prefix + "staged.ts");
    await git(["add", "--", prefix + "staged.ts"]);
    await put(prefix + "unstaged.ts");
    await rm(join(root, prefix + "deleted.ts"));
    await rename(join(root, prefix + "old name.ts"), join(root, prefix + "new\tname.ts"));
    await git(["add", "--", prefix + "old name.ts", prefix + "new\tname.ts"]);
    // Even changes canceled out in the worktree must retain their staged blast radius.
    await put(prefix + "cancelled.ts", "staged\n");
    await git(["add", "--", prefix + "cancelled.ts"]);
    await put(prefix + "cancelled.ts", "original\n");
    for (const name of ["untracked\nname.ts", 'quote"name.ts', "-dash.ts", "café.ts"])
      await put(prefix + name);
    const plan = await readinessPlan(root, options);
    assert.equal(plan.base, base);
    assert.deepEqual(
      plan.changed,
      [
        ...baseline,
        "committed.ts",
        "new\tname.ts",
        "untracked\nname.ts",
        'quote"name.ts',
        "-dash.ts",
        "café.ts",
      ]
        .map((name) => prefix + name)
        .sort(),
    );
    assert.deepEqual(targets(plan), ["utils#test", "utils#build"]);
  });
});

await test("base discovery uses merge-base rather than changes unique to the base branch", async () => {
  await fixture(async (root, git, put) => {
    const base = (await git(["rev-parse", "HEAD"])).trim();
    await git(["checkout", "-b", "upstream"]);
    await put("root-only-on-upstream.config");
    await git(["add", "."]);
    await git(["commit", "-m", "upstream"]);
    await git(["checkout", "main"]);
    await put("packages/utils/src/ours.ts");
    await git(["add", "."]);
    await git(["commit", "-m", "ours"]);
    const plan = await readinessPlan(root, { ...options, base: "upstream" });
    assert.equal(plan.base, base);
    assert.deepEqual(plan.changed, ["packages/utils/src/ours.ts"]);
    assert.equal(plan.full, false);
  });
});

await test("missing base, invalid Git repository and unreadable graph select full coverage with reasons", async () => {
  await fixture(async (root, git) => {
    await git(["update-ref", "-d", "refs/remotes/origin/main"]);
    for (const base of ["origin/main", "does-not-exist", "--invalid"]) {
      const plan = await readinessPlan(root, { ...options, base });
      assert.equal(plan.full, true);
      assert.equal(plan.e2e, true);
      assert.equal(plan.base, null);
      assert.ok(plan.reasons[0].includes(base));
    }
    await rm(join(root, "packages/utils/package.json"));
    // A missing known manifest is itself a conservative global configuration change.
    assert.equal((await readinessPlan(root, { ...options, base: "HEAD" })).full, true);
    await rm(join(root, ".git"), { recursive: true });
    const plan = await readinessPlan(root, options);
    assert.equal(plan.full, true);
    assert.ok(plan.reasons[0].includes("Cannot discover changes"));
  });
});

await test("--all preserves full gates while dry-run leaves selection and filesystem unchanged", async () => {
  await fixture(async (root) => {
    const selected = await readinessPlan(root, options);
    assert.deepEqual(await readinessPlan(root, { ...options, dryRun: true }), selected);
    const all = await readinessPlan(root, { ...options, all: true, dryRun: true });
    assert.equal(all.full, true);
    assert.equal(all.e2e, true);
    assert.deepEqual(all.changed, []);
    assert.ok(all.reasons[0].includes("--all"));
  });
});
