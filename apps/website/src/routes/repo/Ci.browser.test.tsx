import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { CiJob, CiRunDetail } from "../../../shared/api.ts";
import { commitId } from "../../testing/atlas.ts";
import { cannedFiles } from "../../testing/git.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { visual } from "../../testing/visual.ts";

test("verified reuse links to the executed producer without inventing execution or fetching logs", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const commit = commitId();
  await server.push("orbit/engine", "main", commit);
  cannedFiles(server, commit);
  const skipped: CiJob = {
    id: "conditional-job",
    name: "deploy",
    needs: [],
    status: "skipped",
    runner: "local",
    claimedBy: null,
    exitCode: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    logsRemovedAt: null,
    steps: [
      {
        position: 0,
        name: "Publish release",
        status: "skipped",
        exitCode: null,
        startedAt: null,
        finishedAt: null,
      },
    ],
  };
  const reused: CiJob = {
    ...skipped,
    id: "reused-job",
    name: "checks",
    verifiedBy: {
      runId: "candidate-run",
      runNumber: 41,
      jobId: "producer-job",
      queueId: "queue-evidence",
      attempt: 2,
      commit,
      sourceId: "canonical",
      contract: "context-invariant-v1",
      executionIdentity: "private-execution-identity",
    },
    steps: [{ ...skipped.steps[0]!, name: "Check types" }],
  };
  const createdAt = "2026-10-09T10:00:00.000Z";
  const finishedAt = "2026-10-09T10:01:00.000Z";
  const producer: CiJob = {
    ...reused,
    id: "producer-job",
    name: "candidate checks",
    verifiedBy: null,
    status: "succeeded",
    claimedBy: "build-runner",
    exitCode: 0,
    startedAt: createdAt,
    finishedAt,
    steps: [
      {
        ...reused.steps[0]!,
        status: "succeeded",
        exitCode: 0,
        startedAt: createdAt,
        finishedAt,
      },
    ],
  };
  const run: CiRunDetail = {
    id: "merge-run",
    number: 42,
    commit,
    ref: "main",
    trigger: "landing",
    preview: null,
    landing: null,
    queueId: "queue-evidence",
    title: "Queue verification",
    status: "succeeded",
    actor: null,
    agent: null,
    createdAt,
    startedAt: null,
    finishedAt,
    heldAt: null,
    coveredBy: null,
    configError: null,
    jobs: [reused, skipped],
  };
  server.on("GET", "/api/repos/:space/:name/ci/runs/:number", ({ params }): CiRunDetail =>
    params.number === "41"
      ? { ...run, id: "candidate-run", number: 41, jobs: [skipped, producer] }
      : run,
  );
  server.on("GET", "/api/packages/-/published", () => ({ rows: [] }));
  server.on("GET", "/api/repos/:space/:name/deployments", () => ({ deployments: [], next: null }));
  const logRequests: string[] = [];
  server.on("GET", "/api/repos/:space/:name/ci/jobs/:job/logs", ({ params }) => {
    logRequests.push(params.job!);
    return {
      chunks:
        params.job === producer.id ? [{ seq: 1, step: 0, text: "Producer checks passed\n" }] : [],
      next: 1,
      done: true,
    };
  });

  const app = renderApp("/orbit/engine/ci/42?job=checks");
  const jobs = page.getByRole("navigation", { name: "Jobs" });
  const detail = page.getByRole("region", { name: "checks job" });
  await expect.element(jobs.getByRole("button", { name: "checks Verified" })).toBeVisible();
  await expect.element(jobs.getByRole("button", { name: /deploy Skipped/ })).toBeVisible();
  await expect.element(detail.getByText("Verified", { exact: true })).toBeVisible();
  await expect.element(detail.getByText(commit, { exact: true })).toBeVisible();
  await expect.element(detail.getByText("queue-evidence", { exact: true })).toBeVisible();
  await expect.element(detail.getByText(/attempt 2/)).toBeVisible();
  // Reuse has provenance, not executable step panels, runner identity, timings or output.
  expect(detail.element().querySelectorAll("details, pre")).toHaveLength(0);
  expect(detail.element().textContent).not.toContain("build-runner");
  expect(document.body.textContent).not.toContain("private-execution-identity");
  const evidence = detail.getByRole("link", { name: /run #41/ });
  await expect.element(evidence).toHaveAttribute("href", "/orbit/engine/ci/41?job=producer-job");

  await jobs.getByRole("button", { name: /deploy Skipped/ }).click();
  const conditional = page.getByRole("region", { name: "deploy job" });
  await expect.element(conditional.getByText("Skipped", { exact: true })).toBeVisible();
  await conditional.getByText("Publish release", { exact: true }).click();
  await expect.element(conditional.getByText("Did not run.", { exact: true })).toBeVisible();
  expect(conditional.getByRole("link", { name: /run #41/ }).elements()).toHaveLength(0);
  await expect.poll(() => logRequests.includes(skipped.id)).toBe(true);
  expect(logRequests).not.toContain(reused.id);

  await jobs.getByRole("button", { name: "checks Verified" }).click();
  await evidence.click();
  await app.waitForUrl(
    (url) => url.pathname === "/orbit/engine/ci/41" && url.searchParams.get("job") === producer.id,
  );
  const executed = page.getByRole("region", { name: "candidate checks job" });
  await expect.element(executed).toBeVisible();
  await executed.getByText("Check types", { exact: true }).click();
  await expect
    .element(executed.getByText("Producer checks passed", { exact: false }))
    .toBeVisible();
  await expect.element(executed.getByText(/build-runner/)).toBeVisible();
  await visual("CI run - job log");
  expect(logRequests).toContain(producer.id);
  expect(logRequests).not.toContain(reused.id);
});
