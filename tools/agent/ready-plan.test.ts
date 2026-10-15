import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  localGates,
  parseReadyOptions,
  readinessPlan,
  type ReadyOptions,
  type ReadyPlan,
} from "./ready-plan.ts";
import { ciBuildPlan } from "./ci-build.ts";

const exec = promisify(execFile);
const options: ReadyOptions = { all: false, dryRun: false, base: "origin/main" };
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
    for (const name of ["app", "tokens", "matrixkit"])
      await put(
        `apps/website/src/styles/${name}.css`,
        '@import "./base.css";\n.a { color: red; }\n',
      );
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

await test("docs and coding-agent configuration retain mandatory checks", async () => {
  await fixture(async (root, _git, put) => {
    assert.deepEqual(names(await readinessPlan(root, options)), ["remote-types", "check"]);
    await put("README.md");
    await put("DESIGN.md");
    await put("SELF-HOSTING.md");
    await put("LICENSE");
    await put("apps/website/README.md");
    await put(".claude/settings.json", "{}\n");
    await put(".claude/agents/runner.md");
    await put(".claude/rules/delegation.md");
    await put(".claude/skills/gitmatrix-graph-work/SKILL.md");
    await put(".agents/skills/gitmatrix-graph-work/SKILL.md");
    const plan = await readinessPlan(root, options);
    assert.deepEqual(names(plan), ["remote-types", "check"]);
    assert.equal(plan.full, false);
    assert.equal(plan.e2e, false);
    await rm(join(root, "apps/website/.cloudflare"), { recursive: true });
    const fresh = await readinessPlan(root, options);
    assert.deepEqual(names(fresh), ["bindings", "remote-types", "check"]);
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
      "website#typecheck",
      "@gitmatrix/remote#typecheck",
      "@gitmatrix/agent#typecheck",
      "@gitmatrix/agent#test",
      "@gitmatrix/preview#typecheck",
      "@gitmatrix/preview#test",
      "website#test",
      "website#build",
    ]);
    assert.ok(names(plan).indexOf("website-types") < names(plan).indexOf("check"));
    assert.ok(names(plan).indexOf("remote-types") < names(plan).indexOf("check"));
  });
});

await test("CLI changes select its whole Rust package and the site's gm reference, not the website", async () => {
  for (const path of ["apps/cli/src/main.rs", "apps/cli/assets/prompt.md", "apps/cli/Cargo.toml"]) {
    await fixture(async (root, _git, put) => {
      await put(path);
      const plan = await readinessPlan(root, options);
      assert.equal(plan.full, false, path);
      assert.equal(plan.e2e, true, path);
      assert.deepEqual(
        targets(plan),
        [
          "@gitmatrix/remote#typecheck",
          "cli#check",
          "cli#test",
          "cli#build",
          "site#typecheck",
          "site#test",
          "site#build",
        ],
        path,
      );
    });
  }
});

await test("public site changes select site work and the mandatory remote contract, without E2E", async () => {
  for (const path of [
    "apps/site/src/pages/index.astro",
    "apps/site/src/content/docs/concepts/timelines.md",
  ]) {
    await fixture(async (root, _git, put) => {
      await put(path);
      const plan = await readinessPlan(root, options);
      assert.equal(plan.full, false, path);
      assert.equal(plan.e2e, false, path);
      assert.deepEqual(
        targets(plan),
        ["@gitmatrix/remote#typecheck", "site#typecheck", "site#test", "site#build"],
        path,
      );
    });
  }
});

await test("manifest dependencies propagate formats and testing", async () => {
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
    });
  }
});

await test("manifest graph changes are read dynamically and propagated transitively", async () => {
  await fixture(async (root, git, put) => {
    const path = "packages/formats/package.json";
    const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
    manifest.dependencies["@gitmatrix/preview"] = "workspace:*";
    await put(path, JSON.stringify(manifest));
    await git(["add", path]);
    await git(["commit", "-m", "new workspace edge"]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await put("tools/preview/preview.ts");
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
      assert.deepEqual(
        targets(plan),
        expected[0] === "website#typecheck"
          ? [expected[0], "@gitmatrix/remote#typecheck", ...expected.slice(1)]
          : ["@gitmatrix/remote#typecheck", ...expected],
        path,
      );
      assert.equal(plan.full, false, path);
      assert.equal(plan.e2e, false, path);
    });
  }
});

await test("preview tooling stays isolated from production app and CLI", async () => {
  await fixture(async (root, _git, put) => {
    await put("tools/preview/preview.ts");
    const plan = await readinessPlan(root, options);
    assert.deepEqual(targets(plan), [
      "@gitmatrix/remote#typecheck",
      "@gitmatrix/preview#typecheck",
      "@gitmatrix/preview#test",
    ]);
    assert.equal(plan.e2e, false);
  });
});

await test("remote protocol consumers participate in transitive workspace task selection", async () => {
  await fixture(async (root, git, put) => {
    const path = "tools/remote/package.json";
    const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
    // Exercise selection of an available consumer task rather than only its mandatory typecheck.
    manifest.scripts.test = "node --test";
    await put(path, JSON.stringify(manifest));
    await git(["add", path]);
    await git(["commit", "-m", "remote test task"]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await put("tools/agent/environment.test.ts");
    const testOnly = await readinessPlan(root, options);
    assert.ok(!targets(testOnly).includes("@gitmatrix/remote#test"));
    await put("apps/website/src/routes/Home.tsx");
    const production = await readinessPlan(root, options);
    assert.equal(production.full, false);
    assert.ok(targets(production).includes("@gitmatrix/remote#test"));
    assert.equal(production.e2e, true);
  });
});

await test("every narrow plan regenerates and checks remote bindings before root lint", async () => {
  for (const path of ["README.md", "apps/cli/tests/remote.rs", "tools/remote/worker.test.ts"]) {
    await fixture(async (root, _git, put) => {
      await put(path);
      for (const generated of [false, true]) {
        if (generated) await put("tools/remote/.cloudflare/types/index.d.ts", "// generated\n");
        const plan = await readinessPlan(root, options);
        assert.equal(plan.full, false);
        const remote = plan.gates.filter((gate) => gate.name === "remote-types");
        assert.equal(remote.length, 1);
        assert.deepEqual(remote[0].args, ["run", "--no-cache", "@gitmatrix/remote#typecheck"]);
        assert.ok(plan.gates.indexOf(remote[0]) < names(plan).indexOf("check"));
      }
    });
  }
});

await test("unknown/global paths, task manifests and shared harness changes fail closed", async () => {
  // One path per fail-closed class: lockfile, task manifest, unclassified Markdown,
  // an unknown workspace and the shared harness.
  for (const path of [
    "pnpm-lock.yaml",
    "vite.config.ts",
    "unknown.md",
    "packages/new/src/index.ts",
    "tools/agent/environment.ts",
  ]) {
    await fixture(async (root, _git, put) => {
      await put(path);
      const plan = await readinessPlan(root, options);
      assert.equal(plan.full, true, path);
      assert.equal(plan.e2e, true, path);
      // Full code gates, but E2E journeys still come from the changed path.
      assert.equal(plan.e2eAll, false, path);
      assert.ok(
        plan.reasons.some((reason) => reason.includes(path)),
        path,
      );
      for (const target of [
        "website#typecheck",
        "@gitmatrix/agent#typecheck",
        "@gitmatrix/preview#typecheck",
        "@gitmatrix/remote#typecheck",
        "@gitmatrix/formats#typecheck",
        "@gitmatrix/testing#typecheck",
        "site#typecheck",
        "cli#check",
      ])
        assert.ok(targets(plan).includes(target), target);
      assert.ok(names(plan).indexOf("remote-types") < names(plan).indexOf("check"));
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

await test("content-only audited stylesheets retain every website gate and E2E", async () => {
  for (const name of ["app", "tokens", "matrixkit"]) {
    await fixture(async (root, _git, put) => {
      await put(
        `apps/website/src/styles/${name}.css`,
        '@import "./base.css";\n.a { color: blue; }\n',
      );
      await rm(join(root, "apps/website/.cloudflare"), { recursive: true });
      const plan = await readinessPlan(root, options);
      assert.deepEqual(names(plan), [
        "website-types",
        "remote-types",
        "check",
        "website-tests",
        "website-build",
      ]);
      assert.deepEqual(targets(plan), [
        "website#typecheck",
        "@gitmatrix/remote#typecheck",
        "website#test",
        "website#build",
      ]);
      assert.equal(plan.e2e, true);
    });
  }
});

await test("stylesheet names, imports, configuration and mixed inputs widen conservatively", async () => {
  for (const change of ["add", "delete", "rename", "import", "comment-import", "mixed", "config"]) {
    await fixture(async (root, git, put) => {
      const path = "apps/website/src/styles/app.css";
      await put(path, '@import "./base.css";\n.a { color: blue; }\n');
      if (change === "add") {
        await git(["rm", "--cached", path]);
        await git(["commit", "-m", "remove stylesheet"]);
        await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
        await put(path);
      } else if (change === "delete") await rm(join(root, path));
      else if (change === "rename")
        await rename(join(root, path), join(root, "apps/website/src/styles/new.css"));
      else if (change === "import") await put(path, '@import "./new.css";\n.a { color: blue; }\n');
      else if (change === "comment-import")
        await put(path, '/* @import "./base.css"; */\n.a { color: blue; }\n');
      else if (change === "mixed") await put("apps/website/src/routes/Home.tsx");
      else await put("apps/website/vite.config.ts");
      const plan = await readinessPlan(root, options);
      assert.ok(targets(plan).includes("@gitmatrix/agent#test"), change);
      assert.ok(targets(plan).includes("@gitmatrix/preview#test"), change);
      assert.equal(plan.e2e, true, change);
    });
  }
});

await test("full and website profiles generate bindings exactly once before their consumers", async () => {
  await fixture(async (root, _git, put) => {
    await rm(join(root, "apps/website/.cloudflare"), { recursive: true });
    await put("apps/website/worker/index.test.ts");
    for (const all of [false, true]) {
      const plan = await readinessPlan(root, { ...options, all });
      assert.ok(names(plan).indexOf("website-types") < names(plan).indexOf("check"));
      assert.ok(names(plan).indexOf("remote-types") < names(plan).indexOf("check"));
      assert.equal(names(plan).filter((name) => name === "remote-types").length, 1);
      assert.equal(names(plan).filter((name) => name === "website-types").length, 1);
      assert.ok(!names(plan).includes("bindings"));
    }
  });
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
    const prefix = "tools/preview/src/";
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
    assert.deepEqual(targets(plan), [
      "@gitmatrix/remote#typecheck",
      "@gitmatrix/preview#typecheck",
      "@gitmatrix/preview#test",
    ]);
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
    await put("tools/preview/ours.ts");
    await git(["add", "."]);
    await git(["commit", "-m", "ours"]);
    const plan = await readinessPlan(root, { ...options, base: "upstream" });
    assert.equal(plan.base, base);
    assert.deepEqual(plan.changed, ["tools/preview/ours.ts"]);
    assert.equal(plan.full, false);
  });
});

await test("missing base, invalid Git repository and unreadable graph select full coverage with reasons", async () => {
  await fixture(async (root, git, put) => {
    await git(["update-ref", "-d", "refs/remotes/origin/main"]);
    for (const base of ["origin/main", "does-not-exist", "--invalid"]) {
      const plan = await readinessPlan(root, { ...options, base });
      assert.equal(plan.full, true);
      assert.equal(plan.e2e, true);
      assert.equal(plan.e2eAll, true, "No change list: every scenario runs");
      assert.equal(plan.base, null);
      assert.ok(plan.reasons[0].includes(base));
    }
    await rm(join(root, "tools/preview/package.json"));
    // A missing known manifest is itself a conservative global configuration change.
    const graph = await readinessPlan(root, { ...options, base: "HEAD" });
    assert.equal(graph.full, true);
    assert.equal(graph.e2eAll, false);
    // An unreadable task graph is failed change discovery too: every scenario runs (CORE-406).
    await put("tools/preview/package.json", "{not json");
    await git(["add", "."]);
    await git(["commit", "-m", "break a manifest"]);
    const broken = await readinessPlan(root, { ...options, base: "HEAD" });
    assert.equal(broken.full, true);
    assert.equal(broken.e2eAll, true);
    assert.ok(broken.reasons[0].includes("Cannot load workspace task graph"));
    await rm(join(root, ".git"), { recursive: true });
    const plan = await readinessPlan(root, options);
    assert.equal(plan.full, true);
    assert.equal(plan.e2eAll, true);
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
    assert.equal(all.e2eAll, true);
    assert.equal(selected.e2eAll, false);
    assert.deepEqual(all.changed, []);
    assert.ok(all.reasons[0].includes("--all"));
  });
});

await test("CI build selection covers all changes since proven success, not only the latest commit", async () => {
  await fixture(async (root, git, put) => {
    const base = (await git(["rev-parse", "HEAD"])).trim();
    const env = {
      GITMATRIX_COMMIT: base,
      GITMATRIX_VERIFIED_BASE: JSON.stringify({ commit: base, runNumber: 1, jobId: "build-1" }),
    };
    await put("README.md");
    assert.equal((await ciBuildPlan(root, env)).build, false);
    await put("apps/site/src/content/docs/guide.md");
    assert.equal((await ciBuildPlan(root, env)).build, true);
    await git(["add", "."]);
    await git(["commit", "-m", "site content"]);
    await put("README.md", "Later documentation change\n");
    await git(["add", "."]);
    await git(["commit", "-m", "readme"]);
    env.GITMATRIX_COMMIT = (await git(["rev-parse", "HEAD"])).trim();
    assert.equal((await ciBuildPlan(root, env)).build, true);
  });
});

await test("CI build selection takes the newest candidate that is an ancestor", async () => {
  await fixture(async (root, git, put) => {
    const base = (await git(["rev-parse", "HEAD"])).trim();
    await put("README.md");
    await git(["add", "."]);
    await git(["commit", "-m", "other branch"]);
    const other = (await git(["rev-parse", "HEAD"])).trim();
    await git(["checkout", "--detach", base]);
    const entry = (commit: string, runNumber: number) => ({
      commit,
      runNumber,
      jobId: `build-${runNumber}`,
    });
    const env = {
      GITMATRIX_COMMIT: base,
      GITMATRIX_VERIFIED_BASES: JSON.stringify([
        entry("f".repeat(40), 3),
        entry(other, 2),
        entry(base, 1),
      ]),
    };
    assert.equal((await ciBuildPlan(root, env)).build, false);
    // Without an ancestor, or with only malformed entries, everything builds.
    for (const list of [[entry(other, 2)], [entry(other, 2), { commit: base }]]) {
      assert.equal(
        (await ciBuildPlan(root, { ...env, GITMATRIX_VERIFIED_BASES: JSON.stringify(list) })).build,
        true,
      );
    }
    // A usable list wins over the single object; an unusable one falls back to it.
    const single = JSON.stringify(entry(base, 1));
    const stale = JSON.stringify([entry(other, 2)]);
    assert.equal(
      (
        await ciBuildPlan(root, {
          ...env,
          GITMATRIX_VERIFIED_BASES: stale,
          GITMATRIX_VERIFIED_BASE: single,
        })
      ).build,
      true,
    );
    for (const bases of [undefined, "not-json", "null"])
      assert.equal(
        (
          await ciBuildPlan(root, {
            GITMATRIX_COMMIT: base,
            GITMATRIX_VERIFIED_BASES: bases,
            GITMATRIX_VERIFIED_BASE: single,
          })
        ).build,
        false,
      );
  });
});

await test("CI build selection cannot use absent, shallow, unrelated or mismatched evidence", async () => {
  await fixture(async (root, git, put) => {
    const base = (await git(["rev-parse", "HEAD"])).trim();
    const proof = (commit: string) => JSON.stringify({ commit, runNumber: 1, jobId: "build-1" });
    for (const baseline of [undefined, "null", "not-json", proof("f".repeat(40))]) {
      assert.equal(
        (
          await ciBuildPlan(root, {
            GITMATRIX_COMMIT: base,
            GITMATRIX_VERIFIED_BASE: baseline,
          })
        ).build,
        true,
      );
    }
    assert.equal(
      (
        await ciBuildPlan(root, {
          GITMATRIX_COMMIT: "f".repeat(40),
          GITMATRIX_VERIFIED_BASE: proof(base),
        })
      ).build,
      true,
    );
    await put("README.md");
    await git(["add", "."]);
    await git(["commit", "-m", "other branch"]);
    const other = (await git(["rev-parse", "HEAD"])).trim();
    await git(["checkout", "--detach", base]);
    assert.equal(
      (
        await ciBuildPlan(root, {
          GITMATRIX_COMMIT: base,
          GITMATRIX_VERIFIED_BASE: proof(other),
        })
      ).build,
      true,
    );
  });
});

const local = async (root: string, opts = options) => {
  const plan = await readinessPlan(root, opts);
  return { plan, gates: await localGates(root, plan) };
};
const localNames = (gates: ReadyPlan["gates"]) => gates.map((gate) => gate.name);

await test("local ready runs only website unit tests related to a worker change", async () => {
  await fixture(async (root, _git, put) => {
    await put("apps/website/worker/ci/trigger.ts");
    const { plan, gates } = await local(root);
    assert.deepEqual(plan.direct, ["apps/website"]);
    const found = localNames(gates);
    assert.equal(
      found.some((name) => name === "build" || name.endsWith("-build")),
      false,
    );
    assert.equal(found.includes("tests"), false);
    assert.ok(found.includes("website-types") && found.includes("check"));
    const tests = gates.find((gate) => gate.name === "website-tests")!;
    assert.equal(tests.cwd, "website");
    assert.ok(tests.args.includes(`--changed=${plan.base}`));
    assert.deepEqual(tests.args.slice(1, 3), ["--project", "unit"]);
    assert.equal(found.includes("website-browser-tests"), false);
  });
});

await test("local ready selects colocated and changed browser tests by path", async () => {
  await fixture(async (root, git, put) => {
    await put("apps/website/src/components/X.browser.test.tsx");
    await put("apps/website/src/components/Y.browser.test.tsx");
    await git(["add", "."]);
    await git(["commit", "-m", "browser tests"]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await put("apps/website/src/components/X.tsx");
    await put("apps/website/src/components/Z.tsx");
    const { gates } = await local(root);
    const browser = gates.find((gate) => gate.name === "website-browser-tests")!;
    assert.deepEqual(browser.args.slice(1), [
      "--project",
      "browser",
      "src/components/X.browser.test.tsx",
    ]);
    await put("apps/website/src/components/Y.browser.test.tsx", "edited\n");
    const both = (await local(root)).gates.find((gate) => gate.name === "website-browser-tests")!;
    assert.deepEqual(both.args.slice(3), [
      "src/components/X.browser.test.tsx",
      "src/components/Y.browser.test.tsx",
    ]);
  });
});

await test("local ready keeps tests of directly changed workspaces and a package's consumers", async () => {
  await fixture(async (root, _git, put) => {
    await put("packages/formats/src/index.ts");
    const { plan, gates } = await local(root);
    assert.deepEqual(plan.direct, ["packages/formats"]);
    const found = localNames(gates);
    assert.ok(found.includes("formats-tests"));
    assert.ok(found.includes("website-types"));
    assert.ok(found.includes("website-tests"));
    assert.equal(
      found.some((name) => name.endsWith("-build")),
      false,
    );
  });
});

await test("local ready runs the full website unit project for untraceable changes", async () => {
  await fixture(async (root, _git, put) => {
    await put("apps/website/migrations/20990101000000_throwaway.sql", "select 1;\n");
    const { gates } = await local(root);
    const tests = gates.find((gate) => gate.name === "website-tests")!;
    assert.deepEqual(tests.args.slice(1), ["--project", "unit"]);
  });
  await fixture(async (root, _git, put) => {
    await put("packages/testing/src/index.ts");
    const { plan, gates } = await local(root);
    assert.deepEqual(plan.direct, ["packages/testing"]);
    const tests = gates.find((gate) => gate.name === "website-tests")!;
    assert.deepEqual(tests.args.slice(1), ["--project", "unit"]);
  });
});

await test("local ready runs the website unit tests a README change reaches", async () => {
  await fixture(async (root, _git, put) => {
    await put("apps/website/worker/ci/fake.test.ts", "// reads ../../README.md\n");
    await put("apps/website/README.md");
    const { gates } = await local(root);
    const website = gates.find((gate) => gate.name === "website-tests");
    assert.ok(website);
    assert.ok(website.args.some((arg) => arg.startsWith("--changed=")));
    // Vitest ANDs filters with --changed, so the README's readers run by name in their own gate.
    const readme = gates.find((gate) => gate.name === "website-readme-tests");
    assert.ok(readme);
    assert.deepEqual(readme.args.slice(1, 4), ["--project", "unit", "worker/ci/fake.test.ts"]);
    assert.equal(
      readme.args.some((arg) => arg.startsWith("--changed")),
      false,
    );
    assert.equal(localNames(gates).includes("website-browser-tests"), false);
  });
});

await test("--all keeps the full gates and failed discovery is not slimmed", async () => {
  await fixture(async (root, _git, put) => {
    await put("apps/website/worker/ci/trigger.ts");
    const all = await readinessPlan(root, { ...options, all: true });
    assert.ok(names(all).includes("tests") && names(all).includes("build"));
    const lost = await readinessPlan(root, { ...options, base: "no-such-ref" });
    assert.equal(lost.base, null);
    assert.deepEqual(await localGates(root, lost), lost.gates);
  });
});

await test("--resume fingerprints read each workspace's transitive dependencies", async () => {
  await fixture(async (root, _git, put) => {
    await put("apps/website/worker/new.ts");
    const { dependencies } = await readinessPlan(root, options);
    assert.ok(dependencies);
    for (const consumer of ["tools/agent", "tools/preview", "tools/remote"]) {
      assert.ok(dependencies[consumer]!.includes("apps/website"), consumer);
      for (const dependency of dependencies["apps/website"]!)
        assert.ok(dependencies[consumer]!.includes(dependency), `${consumer} ${dependency}`);
    }
    assert.ok(dependencies["apps/site"]!.includes("apps/cli"));
    for (const [workspace, list] of Object.entries(dependencies))
      assert.ok(!list.includes(workspace), workspace);
  });
  // The stylesheet shortcut omits the harness's relative-import edge from selection, not from reads.
  await fixture(async (root, _git, put) => {
    await put("apps/website/src/styles/app.css", '@import "./base.css";\n.a { color: blue; }\n');
    const plan = await readinessPlan(root, options);
    assert.ok(plan.reasons.some((reason) => reason.startsWith("Content-only audited stylesheets")));
    assert.ok(plan.dependencies!["tools/agent"]!.includes("apps/website"));
    assert.ok(plan.dependencies!["tools/preview"]!.includes("apps/website"));
  });
  // A full-coverage fallback has no task graph: every gate then reads every change.
  await fixture(async (root, _git, put) => {
    await put("unknown.txt");
    assert.equal((await readinessPlan(root, options)).dependencies, undefined);
  });
});
