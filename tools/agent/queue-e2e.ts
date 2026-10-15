import { contentHeaders, fixtureMutationBody, fixtureSpace } from "./content-fixtures.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { QueueEntry } from "../../apps/website/shared/merge-queue.ts";
import type { CiRunDetail, CiRunList, RepoDetail } from "../../apps/website/shared/api.ts";
import type { DeploymentList } from "../../apps/website/shared/deployments.ts";
import type { Snapshot } from "../../apps/website/shared/tracker.ts";
import type { StepPage, StepVersions } from "../../apps/website/shared/steps.ts";
import { redact } from "./environment.ts";
import type { HarnessContext, Persona, SeedManifest } from "./types.ts";

export type QueueGm = (
  args: string[],
  persona?: Persona | "read",
  cwd?: string,
  failure?: RegExp | true,
  extra?: NodeJS.ProcessEnv,
) => Promise<string>;

export interface QueueFixture {
  repo: string;
  root: string;
  api: string;
  json<T>(
    path: string,
    method?: string,
    body?: unknown,
    statuses?: number[],
    credential?: string | null,
  ): Promise<T>;
  git(args: string[], cwd?: string, raw?: boolean): Promise<string>;
  tip(): Promise<string>;
  show(id: string): Promise<QueueEntry>;
  wait(id: string, done?: (entry: QueueEntry) => boolean, timeoutMs?: number): Promise<QueueEntry>;
  landed(id: string): Promise<QueueEntry>;
  idle(): Promise<void>;
}

/** Owned fixture only: credentials travel in environment/headers, never URLs or evidence. */
export async function queueFixture(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  record: (value: unknown) => void,
): Promise<QueueFixture> {
  const name = `queue-${randomUUID().slice(0, 8)}`;
  const repo = `orbit/${name}`;
  const root = join(ctx.work, name);
  await mkdir(root, { recursive: true });
  const api = `/api/repos/${repo}`;
  const token = fixtures.tokens.marco;
  async function json<T>(
    path: string,
    method = "GET",
    body?: unknown,
    statuses = [200],
    credential: string | null = token,
  ): Promise<T> {
    body = await fixtureMutationBody(ctx.origin, path, credential, body);
    const response = await fetch(`${ctx.origin}${path}`, {
      method,
      headers: {
        ...contentHeaders,
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
    record({ method, path, status: response.status });
    assert(statuses.includes(response.status), `${method} ${path}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
  const env = {
    ...ctx.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(env))
    if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key) || key === "SSH_AUTH_SOCK")
      delete (env as NodeJS.ProcessEnv)[key];
  const git = (args: string[], cwd = root, raw = false) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: 180_000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...env,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `http.${ctx.origin}/.extraHeader`,
            GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
          },
        },
        (error, stdout, stderr) =>
          error
            ? reject(
                new Error(
                  `Queue fixture git ${args[0]} failed (${error.code}):\n${redact(stderr.replaceAll(token, "[REDACTED]")).slice(-6000)}`,
                ),
              )
            : resolve(raw ? stdout : stdout.trim()),
      );
    });
  const spaceId = (await fixtureSpace(ctx.origin, "orbit", token)).space.id;
  await json("/api/repos", "POST", { spaceId, name, visibility: "private" }, [201]);
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Queue Fixture"]);
  await git(["config", "user.email", "queue@example.invalid"]);
  await mkdir(join(root, ".gitmatrix"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "guide.md"), "# Parcel guide\n\nParcels have labels.\n");
  await writeFile(join(root, "value.ts"), "export const value = 0;\n");
  await writeFile(
    join(root, ".gitmatrix", "ci.yml"),
    JSON.stringify({
      on: { push: { branches: ["main"] }, step: {} },
      jobs: {
        "step-only": {
          on: "step",
          steps: ["exit 1"],
        },
        gate: {
          if: 'trigger == "landing"',
          steps: [
            {
              run: `test "$(git log -1 --format=%P | wc -w)" = 2 && echo QUEUE_GATE_OK`,
            },
          ],
        },
        deploy: {
          if: 'trigger == "push"',
          env: { AGENT_GM: ctx.gm },
          steps: [
            {
              run: '"$AGENT_GM" deploy record --url "https://queue-e2e.example.com/run-$GITMATRIX_RUN_NUMBER" --environment staging --expires 2d',
            },
          ],
        },
      },
    }),
  );
  await git(["add", "."]);
  await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "Queue fixture base"]);
  await git(["remote", "add", "origin", `${ctx.origin}/${repo}.git`]);
  await git(["push", "origin", "HEAD:main"]);
  const tip = async () => {
    const detail = await json<RepoDetail>(api);
    const oid = detail.branches.find((branch) => branch.shortName === "main")?.oid;
    assert(oid, "Queue fixture main must exist");
    return oid;
  };
  const show = async (id: string) =>
    (await json<{ entry: QueueEntry }>(`${api}/queue/${id}`)).entry;
  async function wait(
    id: string,
    done = (entry: QueueEntry) =>
      ["landed", "failed", "cancelled", "covered"].includes(entry.status),
    timeoutMs = 300_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const entry = await show(id);
      if (done(entry)) {
        record({ entry });
        return entry;
      }
      assert(
        Date.now() < deadline,
        `Queue ${id}: timed out in ${entry.status} (deploy ${entry.deployStatus ?? "none"})`,
      );
      await delay(250);
    }
  }
  async function landed(id: string) {
    const entry = await wait(id);
    assert.equal(entry.status, "landed", JSON.stringify(entry.failure));
    assert(entry.candidate && entry.base && entry.gateRun && entry.mergeRun);
    const gates = await json<CiRunDetail>(`${api}/ci/runs/${entry.gateRun}`);
    assert.equal(gates.status, "succeeded");
    assert.equal(gates.commit, entry.candidate);
    assert.equal(gates.trigger, "landing");
    assert.equal(gates.jobs.find((job) => job.name === "gate")?.status, "succeeded");
    assert.equal(gates.jobs.find((job) => job.name === "step-only")?.status, "skipped");
    await git(["fetch", "origin", "main"]);
    assert.equal(
      await git(["show", "-s", "--format=%P", entry.candidate]),
      `${entry.base} ${entry.commit}`,
    );
    await git(["merge-base", "--is-ancestor", entry.candidate, "origin/main"]);
    return entry;
  }
  // The environment has two runner slots (GITMATRIX_CI_RUNNERS), shared by
  // every repository: a step that times a gate first lets this fixture's
  // earlier runs (deploys of each landing) finish (CORE-266).
  async function idle() {
    const deadline = Date.now() + 600_000;
    while (true) {
      const busy = (await json<CiRunList>(`${api}/ci`)).runs.filter(
        (run) => run.status === "queued" || run.status === "running",
      );
      if (!busy.length) return;
      assert(
        Date.now() < deadline,
        `${repo}: runs still busy: ${busy.map((run) => `#${run.number} ${run.trigger} ${run.status}`).join(", ")}`,
      );
      await delay(250);
    }
  }
  return { repo, root, api, json, git, tip, show, wait, landed, idle };
}

export async function runQueueE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  gm: QueueGm,
  record: (value: unknown) => void,
) {
  const f = await queueFixture(ctx, fixtures, record);
  const clone = async (name: string) => {
    const directory = join(f.root, name);
    await gm(["clone", f.repo, directory]);
    return directory;
  };
  const commit = async (directory: string, file: string, content: string) => {
    await writeFile(join(directory, file), content);
    await gm(["commit", "-m", `Queue ${file}`], "marco", directory);
  };
  const submit = async (directory: string, issues: string[] = []) => {
    const result = JSON.parse(
      await gm(
        ["push", "--queue", ...issues.flatMap((issue) => ["--issue", issue])],
        "marco",
        directory,
      ),
    ) as { queue: QueueEntry };
    assert(result.queue?.id, "gm push must report queue acceptance");
    return result.queue.id;
  };
  const left = await clone("left"),
    right = await clone("right");
  const contextFile = join(f.root, "queued-context.md");
  await writeFile(
    contextFile,
    "## Instructions\n- Preserve the left contribution\n\n## Steering\n- Keep admission separate from landing\n\n## Why\nQueued source context must survive candidate merging.\n\n## Challenges\nThe candidate has a different revision from the source.\n",
  );
  await writeFile(join(left, "left.txt"), "left contribution\n");
  await gm(["commit", "-m", "Queue left.txt", "--context", contextFile], "marco", left);
  assert.deepEqual((await f.json<StepPage>(`${f.api}/steps`)).steps, []);
  await commit(right, "right.txt", "right contribution\n");
  const [a, b] = await Promise.all([submit(left), submit(right)]);
  const sourceSteps = (await f.json<StepPage>(`${f.api}/steps`)).steps;
  assert.equal(sourceSteps.length, 1, "Queued push uploads its journaled context");
  const step = sourceSteps[0]!;
  assert.equal(step.commitOid, a, "Context belongs to the admitted source, not the candidate");
  assert.equal(step.verified, true, "The server verifies the staged source revision");
  assert.equal(step.summary, "Queue left.txt");
  assert.deepEqual(step.context.instructions, [
    { text: "Preserve the left contribution", source: "agent" },
  ]);
  assert.deepEqual(step.context.steering, [
    { text: "Keep admission separate from landing", source: "agent" },
  ]);
  assert.equal(step.context.why, "Queued source context must survive candidate merging.");
  assert.equal(step.context.challenges, "The candidate has a different revision from the source.");
  assert.deepEqual((await f.json<StepVersions>(`${f.api}/steps/${step.changeId}`)).versions, [
    step,
  ]);
  await commit(left, "next.txt", "unsubmitted independent work\n");
  const leftLanded = await f.landed(a);
  assert.notEqual(
    leftLanded.candidate,
    step.commitOid,
    "Verified source context is not proof of landing",
  );
  assert.deepEqual((await f.json<StepPage>(`${f.api}/steps`)).steps, [step]);
  await f.landed(b);
  for (const [file, text] of [
    ["left.txt", "left contribution\n"],
    ["right.txt", "right contribution\n"],
  ])
    assert.equal(await f.git(["show", `origin/main:${file}`], f.root, true), text);
  const files = (await f.git(["ls-tree", "--name-only", "origin/main"])).split("\n");
  assert(!files.includes("next.txt"), "Queue must not consume subsequent local work");
  const finalEntry = (await f.show(a)).candidate === (await f.tip()) ? a : b;
  const waited = JSON.parse(
    await gm(["queue", "wait", finalEntry, "-R", f.repo, "--deploy", "--timeout", "300"]),
  ) as { entry: QueueEntry };
  assert(waited.entry.deployRun, "gm queue wait --deploy reports the main pipeline run");
  assert.equal(waited.entry.deployStatus, "succeeded");
  // gm reads the pipeline run's verdict; the stored entry records it a moment later.
  const deployed = await f.wait(
    finalEntry,
    (entry) => ["succeeded", "failed", "cancelled"].includes(entry.deployStatus ?? ""),
    30_000,
  );
  assert.equal(deployed.deployStatus, "succeeded");
  assert(deployed.deployRun);
  const deployments = await f.json<DeploymentList>(
    `${f.api}/deployments?run=${deployed.deployRun}`,
  );
  assert.equal(deployments.deployments.length, 1);
  assert.equal(deployments.deployments[0]!.commit, deployed.candidate);
  assert.equal(deployments.deployments[0]!.status, "active");
  record({ deployment: deployments.deployments[0] });

  const sourceIssue = randomUUID();
  const tracker = `/api/tracker/${fixtures.tracker.space}`;
  await f.json(`${tracker}/mutate`, "POST", {
    operationId: randomUUID(),
    mutations: [
      {
        kind: "issue.create",
        id: sourceIssue,
        data: { teamId: fixtures.tracker.team, title: "Queue conflict source" },
      },
    ],
  });
  const conflict = await clone("conflict"),
    main = await clone("main-writer");
  await commit(conflict, "value.ts", "export const value = 17;\n");
  await commit(main, "value.ts", "export const value = 29;\n");
  await gm(["push"], "marco", main);
  const beforeConflict = await f.tip();
  const conflictId = await submit(conflict, [sourceIssue]);
  const stopped = await f.wait(conflictId);
  assert.equal(stopped.status, "failed");
  assert(stopped.failure?.conflictPaths.includes("value.ts"));
  assert.equal(await f.tip(), beforeConflict);
  // The terminal verdict and its durable remediation outbox precede publication.
  const remediated = await f.wait(conflictId, (entry) => entry.remediationIssueId !== null);
  await f.show(conflictId);
  const snapshot = await f.json<Snapshot>(`${tracker}/snapshot`);
  const remediation = snapshot.issues.filter(
    (issue) => issue.type === "remediation" && issue.queueFailure?.queueId === conflictId,
  );
  assert.equal(remediation.length, 1, "Repeated observation must not create duplicate remediation");
  const issue = remediation[0]!;
  assert.equal(issue.priority, 0);
  assert.equal(issue.status, "todo");
  assert.equal(issue.id, remediated.remediationIssueId);
  assert.deepEqual(
    snapshot.issues.find((item) => item.id === sourceIssue)?.queueFailure,
    issue.queueFailure,
  );
  const claimed = JSON.parse(
    await gm([
      "issue",
      "claim",
      issue.id,
      "--space",
      fixtures.tracker.space,
      "--agent",
      "queue-remediation",
    ]),
  ) as { results: { leaseToken?: string }[] };
  assert(claimed.results[0]?.leaseToken, "Remediation requires a real fenced claim");
  await gm(
    [
      "issue",
      "complete",
      issue.id,
      "--space",
      fixtures.tracker.space,
      "--evidence",
      "Rejected stale lease",
    ],
    "marco",
    f.root,
    /lease|fenc|token|conflict/i,
    { GM_LEASE_TOKEN: "invalid-queue-lease" },
  );

  const beforeDenied = await f.json(`${f.api}/queue`);
  const refsBefore = (await f.json<RepoDetail>(f.api)).branches;
  await gm(
    ["push", "--queue"],
    "read",
    left,
    /403|404|access|forbidden|permission|denied|authentication/i,
  );
  for (const credential of [null, fixtures.readToken, fixtures.tokens.sam]) {
    for (const action of ["cancel", "retry"])
      await f.json(
        `${f.api}/queue/${conflictId}/${action}`,
        "POST",
        {},
        [401, 403, 404],
        credential,
      );
    await f.json(`${f.api}/queue`, "POST", { commit: conflictId }, [401, 403, 404], credential);
  }
  for (const credential of [null, fixtures.tokens.sam]) {
    await f.json(`${f.api}/queue`, "GET", undefined, [401, 403, 404], credential);
    await f.json(`${f.api}/queue/${conflictId}`, "GET", undefined, [401, 403, 404], credential);
  }
  await f.json(`${f.api}/queue/${conflictId}/resolve`, "POST", { files: [] }, [401, 403, 404]);
  assert.deepEqual(await f.json(`${f.api}/queue`), beforeDenied);
  assert.deepEqual((await f.json<RepoDetail>(f.api)).branches, refsBefore);

  const recovery = await clone("recovery");
  await writeFile(join(recovery, "value.ts"), "export const values = [17, 29];\n");
  await commit(recovery, "recovered.txt", "queued recovery succeeds\n");
  const fixed = await f.landed(await submit(recovery));
  assert.equal(await f.git(["show", "origin/main:value.ts"]), "export const values = [17, 29];");
  await gm(
    [
      "issue",
      "complete",
      issue.id,
      "--space",
      fixtures.tracker.space,
      "--evidence",
      `Manually retained both values; queue ${fixed.id} gates passed at ${fixed.candidate}`,
    ],
    "marco",
    f.root,
    undefined,
    { GM_LEASE_TOKEN: claimed.results[0]!.leaseToken },
  );
  const resolved = await f.json<Snapshot>(`${tracker}/snapshot`);
  assert.equal(resolved.issues.find((item) => item.id === issue.id)?.status, "done");
  const direct = await clone("direct-recovery");
  await commit(direct, "direct.txt", "ordinary push remains available\n");
  await gm(["push"], "marco", direct);
  await f.git(["fetch", "origin", "main"]);
  assert.equal(await f.git(["show", "origin/main:direct.txt"]), "ordinary push remains available");
  record({
    repo: f.repo,
    concurrent: [a, b],
    manual: conflictId,
    directMain: await f.tip(),
  });
  await f.idle();
}

// Node-side wire shape, kept separate from Worker-only runtime types.
export interface RepoInventory {
  repoId: string;
  repo: { name: string; deletedAt: string | null } | null;
  d1: Record<string, number>;
  registry: { packageSources: number; publishes: number };
  durable: { purgedAt: string | null }[];
  artifacts: { name: string | null; exists: boolean | null };
  vectors: number | null;
  searchItems: number | null;
  previews: { live: number; teardownsOpen: number };
  deletion: {
    phase: string;
    progress: {
      stop?: { cancelled?: number };
      rows?: Record<string, number>;
      artifacts?: { deleted?: boolean };
    };
  } | null;
}
