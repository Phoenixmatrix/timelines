// Gitmatrix's own previews (CORE-80), as this repository's .gitmatrix/ci.yml
// sets them up: the reference implementation of the preview contract.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { jobRuns, parsePipeline, type ConditionContext } from "../ci/config.ts";

const path = fileURLToPath(new URL("../../../../.gitmatrix/ci.yml", import.meta.url).href);
const pipeline = parsePipeline(readFileSync(path, "utf8"));

function running(context: Partial<ConditionContext>): string[] {
  const full: ConditionContext = {
    branch: "timeline/faster-search",
    trigger: "preview",
    commit: "abc",
    runner: "sandbox",
    action: "create",
    ...context,
  };
  return pipeline.jobs.filter((job) => jobRuns(job, full)).map((job) => job.name);
}

test("a preview run runs only its action's job, and only in a Sandbox", () => {
  expect(running({})).toEqual(["preview"]);
  expect(running({ action: "teardown" })).toEqual(["preview-teardown"]);
  // After a timeline lands, its teardown and revivals run on main: still never a deploy.
  expect(running({ action: "teardown", branch: "main" })).toEqual(["preview-teardown"]);
  expect(running({ branch: "main" })).toEqual(["preview"]);
  // A local server's preview runs deploy nothing (and run no E2E).
  expect(running({ runner: "local" })).toEqual([]);
  expect(running({ runner: "local", action: "teardown" })).toEqual([]);
});

test("pushes run the gates as before, never the preview jobs", () => {
  const push = { trigger: "push" as const, action: "" };
  expect(running({ ...push, branch: "main" })).toEqual(["check", "test", "build", "cli", "deploy"]);
  expect(running({ ...push, runner: "local" })).toEqual(["check", "test", "build", "cli", "e2e"]);
});
