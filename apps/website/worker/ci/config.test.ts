import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import readme from "../../README.md?raw";
import {
  branchMatches,
  ConfigError,
  evaluate,
  jobRuns,
  parsePipeline,
  stages,
  type ConditionContext,
} from "./config.ts";

const ok = `
on:
  push:
    branches: [main, "release/*"]
env:
  CI: true
jobs:
  check:
    steps:
      - name: Install
        run: pnpm install
      - vp check
  test:
    needs: check
    steps: [vp test]
  deploy:
    needs: [test]
    if: branch == "main" && trigger == 'push'
    secrets: [CLOUDFLARE_API_TOKEN]
    timeout_minutes: 15
    steps:
      - run: cf deploy
`;

describe("parsePipeline", () => {
  test("reads jobs, steps and defaults", () => {
    const pipeline = parsePipeline(ok);
    expect(pipeline.branches).toEqual(["main", "release/*"]);
    expect(pipeline.env).toEqual({ CI: "true" });
    const [check, test_, deploy] = pipeline.jobs;
    expect(check?.steps).toEqual([
      { name: "Install", run: "pnpm install" },
      { name: "vp check", run: "vp check" },
    ]);
    expect(check?.image).toBe("default");
    expect(check?.timeoutMinutes).toBe(20);
    expect(test_?.needs).toEqual(["check"]);
    expect(deploy?.secrets).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(stages(pipeline.jobs).map((s) => s.map((j) => j.name))).toEqual([
      ["check"],
      ["test"],
      ["deploy"],
    ]);
  });

  test("rejects unknown needs, cycles and missing steps", () => {
    expect(() => parsePipeline("jobs:\n  a:\n    needs: [b]\n    steps: [x]")).toThrow(
      /unknown job "b"/,
    );
    expect(() =>
      parsePipeline(
        "jobs:\n  a:\n    needs: [b]\n    steps: [x]\n  b:\n    needs: [a]\n    steps: [y]",
      ),
    ).toThrow(/cycle/);
    expect(() => parsePipeline("jobs:\n  a: {}")).toThrow(ConfigError);
    expect(() => parsePipeline("jobs: [")).toThrow(/not valid YAML/);
  });
});

test("branch filters use globs", () => {
  expect(branchMatches("main", null)).toBe(true);
  expect(branchMatches("release/1.0", ["release/*"])).toBe(true);
  expect(branchMatches("release/1.0/hotfix", ["release/*"])).toBe(false);
  expect(branchMatches("release/1.0/hotfix", ["release/**"])).toBe(true);
  expect(branchMatches("feature", ["main"])).toBe(false);
});

test("conditions", () => {
  const ctx = { branch: "main", trigger: "push" as const, commit: "abc", runner: "local" as const };
  expect(evaluate('branch == "main"', ctx)).toBe(true);
  expect(evaluate("branch != 'main' || trigger == 'push'", ctx)).toBe(true);
  expect(evaluate('(branch == "x" || branch == "main") && trigger == "manual"', ctx)).toBe(false);
  expect(() => evaluate("branch = main", ctx)).toThrow(ConfigError);
  expect(() => evaluate('owner == "x"', ctx)).toThrow(/Unknown name/);
  expect(evaluate('runner == "local"', ctx)).toBe(true);
  expect(evaluate('runner == "local"', { ...ctx, runner: "sandbox" })).toBe(false);
});

describe("the preview contract (CORE-79)", () => {
  const previews = `
on:
  push: {}
  preview: {}
jobs:
  test:
    steps: [vp test]
  preview:
    if: trigger == "preview" && action == "create"
    steps: [cf previews deploy "timeline-$GITMATRIX_TIMELINE"]
  preview-teardown:
    if: trigger == "preview" && action == "teardown"
    steps: [./scripts/preview-teardown.sh]
`;
  const push: ConditionContext = {
    branch: "timeline/x",
    trigger: "push",
    commit: "c",
    runner: "sandbox",
  };
  const create: ConditionContext = { ...push, trigger: "preview", action: "create" };
  const teardown: ConditionContext = { ...push, trigger: "preview", action: "teardown" };

  test("a project opts in with on: preview, in any of its spellings", () => {
    expect(parsePipeline(previews).preview).toBe(true);
    expect(parsePipeline("on:\n  preview:\njobs:\n  a:\n    steps: [x]").preview).toBe(true);
    expect(parsePipeline("on: preview\njobs:\n  a:\n    steps: [x]").preview).toBe(true);
    expect(parsePipeline("on: [push, preview]\njobs:\n  a:\n    steps: [x]").preview).toBe(true);
    expect(parsePipeline(ok).preview).toBe(false);
    expect(parsePipeline("jobs:\n  a:\n    steps: [x]").preview).toBe(false);
    expect(() =>
      parsePipeline("on:\n  preview:\n    branches: [x]\njobs:\n  a:\n    steps: [x]"),
    ).toThrow(/takes no options/);
    expect(() => parsePipeline("on: [1]\njobs:\n  a:\n    steps: [x]")).toThrow(ConfigError);
  });

  test("jobs pick an action with if:, and only jobs that ask run in a preview run", () => {
    const jobs = parsePipeline(previews).jobs;
    const running = (context: ConditionContext) =>
      jobs.filter((job) => jobRuns(job, context)).map((job) => job.name);
    expect(running(push)).toEqual(["test"]);
    expect(running(create)).toEqual(["preview"]);
    expect(running(teardown)).toEqual(["preview-teardown"]);
    expect(running({ ...push, trigger: "manual" })).toEqual(["test"]);
  });

  test("the README's worked example opts in and splits create from teardown", () => {
    const section = readme.slice(readme.indexOf("#### The preview contract"));
    const example = /```yaml\n([\s\S]*?)```/.exec(section)![1]!;
    const pipeline = parsePipeline(example);
    expect(pipeline.preview).toBe(true);
    const running = (context: ConditionContext) =>
      pipeline.jobs.filter((job) => jobRuns(job, context)).map((job) => job.name);
    expect([running(push), running(create), running(teardown)]).toEqual([
      ["test"],
      ["preview"],
      ["preview-teardown"],
    ]);
  });

  test("action is empty outside preview runs, and conditions can name it", () => {
    expect(evaluate('action == ""', push)).toBe(true);
    expect(evaluate('trigger != "preview" || action == "create"', create)).toBe(true);
    expect(evaluate('trigger != "preview" || action == "create"', teardown)).toBe(false);
    expect(() => evaluate('event == "x"', push)).toThrow(
      /branch, trigger, commit, runner or action/,
    );
  });
});

test("this repository's pipeline is set up to run in Sandbox containers", () => {
  const path = fileURLToPath(new URL("../../../../.gitmatrix/ci.yml", import.meta.url).href);
  const source = readFileSync(path, "utf8");
  const pipeline = parsePipeline(source);
  const job = (name: string) => pipeline.jobs.find((j) => j.name === name)!;
  for (const name of ["check", "test", "build"]) expect(job(name).instance).toBe("standard-4");
  // A Sandbox has no Docker to build the CI image with during `vite build`.
  expect(job("build").env.GITMATRIX_CONTAINER_IMAGES).toBe("skip");
  // Deploys run once the gates pass, only on main and only in production.
  const deploy = job("deploy");
  expect([...deploy.needs].sort()).toEqual(["build", "check", "cli", "test"]);
  // gm's Rust work is skipped on pushes that leave apps/cli unchanged.
  expect(job("cli").paths).toEqual(["apps/cli"]);
  expect(pipeline.coalesceAfter).toBe(4);
  // The owner's identifiers are secrets, never the repository's (tools/agent/deploy.ts).
  expect(deploy.secrets).toEqual([
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "GITMATRIX_PRODUCTION_HOST",
    "GITMATRIX_SITE_HOST",
    "GITMATRIX_PRODUCTION_DB_ID",
    "GITMATRIX_PRODUCTION_REGISTRY_DB_ID",
    "GITMATRIX_PRODUCTION_SECRETS_STORE_ID",
    "GITMATRIX_PRODUCTION_OWNER_EMAIL",
    "GITMATRIX_PRODUCTION_EMAIL_FROM",
  ]);
  for (const name of ["preview", "preview-teardown", "preview-reconcile"])
    expect(job(name).secrets, name).toContain("CLOUDFLARE_ACCOUNT_ID");
  expect(job("preview").secrets).toEqual(
    expect.arrayContaining(["GITMATRIX_PREVIEW_ACCESS_ISSUER", "GITMATRIX_PREVIEW_ACCESS_AUD"]),
  );
  for (const { name, env } of pipeline.jobs)
    expect(
      Object.keys(env).filter((key) => /ACCOUNT_ID|_HOST|_DB_ID|ACCESS_/.test(key)),
      name,
    ).toEqual([]);
  expect(deploy.concurrency).toBe("production");
  const at = (branch: string, runner: "local" | "sandbox") =>
    evaluate(deploy.if!, { branch, trigger: "push", commit: "abc", runner });
  expect([at("main", "sandbox"), at("main", "local"), at("feature", "sandbox")]).toEqual([
    true,
    false,
    false,
  ]);
  const e2e = job("e2e").if!;
  const base = { branch: "main", trigger: "push" as const, commit: "abc" };
  expect(evaluate(e2e, { ...base, runner: "local" })).toBe(true);
  expect(evaluate(e2e, { ...base, runner: "sandbox" })).toBe(false);
});

describe("step runs (CORE-235)", () => {
  const STEPS = `
on:
  push: {}
  step: {}
jobs:
  lint:
    on: step
    local: true
    steps: [vp check]
  unit:
    on: [push, step]
    needs: [lint]
    steps: [vp test run]
  build:
    steps: [vp build]
  e2e:
    if: trigger != "preview"
    steps: [vp run e2e]
`;
  const at = (trigger: ConditionContext["trigger"]): ConditionContext => ({
    branch: "timeline/search",
    trigger,
    commit: "c",
    runner: "sandbox",
  });

  test("a project opts in with on: step; jobs join with their own on:", () => {
    const pipeline = parsePipeline(STEPS);
    expect(pipeline.step).toBe(true);
    expect(parsePipeline("on: [push, step]\njobs:\n  a:\n    on: step\n    steps: [x]").step).toBe(
      true,
    );
    expect(parsePipeline("jobs:\n  a:\n    steps: [x]").step).toBe(false);
    const byName = new Map(pipeline.jobs.map((job) => [job.name, job]));
    expect(byName.get("lint")).toMatchObject({ on: ["step"], local: true });
    expect(byName.get("unit")).toMatchObject({ on: ["push", "step"], local: false });
    expect(byName.get("build")).toMatchObject({ on: null, local: false });
  });

  test("a step run has only step jobs; other runs keep their jobs", () => {
    const jobs = parsePipeline(STEPS).jobs;
    const running = (trigger: ConditionContext["trigger"]) =>
      jobs.filter((job) => jobRuns(job, at(trigger))).map((job) => job.name);
    // e2e only excludes previews: it still stays out of step runs.
    expect(running("step")).toEqual(["lint", "unit"]);
    expect(running("push")).toEqual(["unit", "build", "e2e"]);
    expect(running("manual")).toEqual(["unit", "build", "e2e"]);
    expect(running("preview")).toEqual([]);
  });

  test("step jobs explain what's wrong", () => {
    const fails = (source: string, message: RegExp) =>
      expect(() => parsePipeline(source)).toThrow(message);
    fails("jobs:\n  a:\n    on: step\n    steps: [x]", /doesn't opt in to step runs \(on: step\)/);
    fails("on: step\njobs:\n  a:\n    local: true\n    steps: [x]", /local is for step jobs/);
    fails(
      "on: step\njobs:\n  a:\n    on: step\n    local: yes please\n    steps: [x]",
      /local must be true or false/,
    );
    fails("on: step\njobs:\n  a:\n    on: nightly\n    steps: [x]", /lists push, preview or step/);
    fails("on: step\njobs:\n  a:\n    on: []\n    steps: [x]", /lists no trigger/);
    fails(
      "on: step\njobs:\n  a:\n    steps: [x]\n  b:\n    on: step\n    needs: [a]\n    steps: [y]",
      /runs on step, so what it needs must too: a/,
    );
    fails(
      "on:\n  step:\n    branches: [x]\njobs:\n  a:\n    steps: [x]",
      /on.step takes no options/,
    );
  });
});
