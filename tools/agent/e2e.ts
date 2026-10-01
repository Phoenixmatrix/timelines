import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type BrowserContext } from "@playwright/test";
import type {
  CiLogs,
  CiRunDetail,
  CiRunList,
  CreatedAccessToken,
  RepoDetail,
} from "../../apps/website/shared/api.ts";
import type { Published } from "../../apps/website/shared/packages.ts";
import { runProviderE2E } from "./provider-e2e.ts";
import type { HarnessContext, Persona, SeedManifest } from "./types.ts";

type Evidence = {
  scenario: string;
  status: "passed" | "failed";
  elapsedMs: number;
  observations: unknown[];
  error?: string;
};

/** Real clients against the isolated server. A failed scenario always fails the command. */
export async function runE2E(ctx: HarnessContext, fixtures: SeedManifest): Promise<void> {
  assert.equal(fixtures.origin, ctx.origin, "Fixture/server identity mismatch");
  const work = join(ctx.work, `e2e-${randomUUID()}`);
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(ctx.artifacts, { recursive: true, mode: 0o700 });
  const secrets = new Set([fixtures.readToken, ...Object.values(fixtures.tokens)]);
  const redact = (text: string) => {
    for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
    return text.replace(/gm[xj]_[A-Za-z0-9_-]+/g, "[REDACTED]");
  };
  const report: Evidence[] = [];
  let observations: unknown[] = [];
  const record = (value: unknown) => observations.push(JSON.parse(redact(JSON.stringify(value))));
  async function scenario(name: string, body: () => Promise<void>) {
    const started = Date.now();
    observations = [];
    try {
      await body();
      report.push({
        scenario: name,
        status: "passed",
        elapsedMs: Date.now() - started,
        observations,
      });
    } catch (error) {
      report.push({
        scenario: name,
        status: "failed",
        elapsedMs: Date.now() - started,
        observations,
        error: redact(String(error)),
      });
      throw new Error(`${name}: ${redact(String(error))}`);
    } finally {
      await writeFile(join(ctx.artifacts, "e2e.json"), JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
      console.log(JSON.stringify(report.at(-1)));
    }
  }
  async function request(
    path: string,
    token: string | null,
    method = "GET",
    body?: unknown,
    statuses = [200],
  ) {
    const response = await fetch(`${ctx.origin}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    const text = await response.text();
    record({ method, path, status: response.status });
    assert(
      statuses.includes(response.status),
      `${method} ${path}: expected ${statuses.join(", ")}, got ${response.status}: ${redact(text)}`,
    );
    return text;
  }
  async function json<T>(
    path: string,
    token: string | null,
    method = "GET",
    body?: unknown,
    statuses = [200],
  ): Promise<T> {
    return JSON.parse(await request(path, token, method, body, statuses)) as T;
  }
  async function gm(
    args: string[],
    persona: Persona | "read" = "marco",
    cwd = work,
    failure?: RegExp,
    extra: NodeJS.ProcessEnv = {},
  ) {
    const token = persona === "read" ? fixtures.readToken : fixtures.tokens[persona];
    const env: NodeJS.ProcessEnv = { ...ctx.env, GM_SERVER: ctx.origin, GM_TOKEN: token, ...extra };
    // No inherited global Git configuration, SSH agent, or credential helper.
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_CONFIG_") || key === "SSH_AUTH_SOCK" || key === "GITMATRIX_TOKEN")
        delete env[key];
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    const { promise, resolve, reject } = Promise.withResolvers<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>();
    const child = spawn(ctx.gm, ["--output", "json", ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, 180_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`gm ${args[0]} exceeded 180 seconds`));
      else resolve({ code, stdout, stderr });
    });
    const result = await promise;
    record({ client: "gm", args, persona, code: result.code, stderr: result.stderr });
    if (failure) {
      assert.notEqual(result.code, 0, `gm ${args.join(" ")} unexpectedly succeeded`);
      assert.match(
        result.stderr + result.stdout,
        failure,
        "Failure must be the intended product rejection",
      );
    } else assert.equal(result.code, 0, `gm ${args.join(" ")}: ${redact(result.stderr)}`);
    return result.stdout;
  }
  async function poll<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    label: string,
    timeout = 180_000,
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    while (true) {
      const value = await read();
      if (done(value)) return value;
      assert(Date.now() < deadline, `Timed out waiting for ${label}`);
      await delay(750);
    }
  }
  const repo = fixtures.repos.find((r) => r.owner === "orbit" && r.visibility === "private");
  const outsiderRepo = fixtures.repos.find((r) => r.owner === "sam" && r.visibility === "private");
  const publicRepo = fixtures.repos.find((r) => r.visibility === "public");
  assert(
    repo && outsiderRepo && publicRepo,
    "Seed must contain private orbit/sam and public repositories",
  );
  const fullName = `${repo.owner}/${repo.name}`;
  const api = `/api/repos/${fullName}`;
  const ownerToken = fixtures.tokens.marco;
  const checkout = join(work, "checkout");
  const packageName = `agent-e2e-${randomUUID().slice(0, 8)}`;
  const bytes = "gitmatrix live regression artifact\n";

  await scenario("authorization-and-token-revocation", async () => {
    await request(`/api/repos/${publicRepo.owner}/${publicRepo.name}`, null);
    await request(api, null, "GET", undefined, [401, 404]);
    await request(api, "gmx_invalid", "GET", undefined, [401, 404]);
    for (const persona of ["priya", "marco", "jun", "sam"] as const)
      await request(api, fixtures.tokens[persona]);
    await request(api, fixtures.readToken);
    await request(
      `/api/repos/${outsiderRepo.owner}/${outsiderRepo.name}`,
      ownerToken,
      "GET",
      undefined,
      [404],
    );
    for (const token of [fixtures.readToken, fixtures.tokens.sam]) {
      await request(
        `${api}/ci/secrets/AGENT_DENIED`,
        token,
        "PUT",
        { value: "not-secret" },
        [403, 404],
      );
      await request(`${api}/ci/runs`, token, "POST", { ref: "main" }, [403, 404]);
    }
    await request(`${api}/ci/secrets/AGENT_GATE`, ownerToken, "PUT", { value: "live-value" });
    await request(`${api}/ci/secrets/AGENT_GATE`, ownerToken, "DELETE");
    const issued = await json<CreatedAccessToken>(
      "/api/tokens",
      ownerToken,
      "POST",
      { name: "agent-e2e-revoke", scope: "write" },
      [201],
    );
    secrets.add(issued.secret);
    await request(api, issued.secret);
    await request(`/api/tokens/${issued.id}`, ownerToken, "DELETE", undefined, [204]);
    await request(api, issued.secret, "GET", undefined, [401, 404]);
  });

  await scenario("gm-clone-commit-push-and-denied-push", async () => {
    await gm(["clone", fullName, checkout]);
    await writeFile(join(checkout, "agent-e2e.txt"), bytes);
    await gm(["commit", "-m", "Agent live transport regression"], "jun", checkout);
    await gm(["push", "--bookmark", "agent-e2e"], "jun", checkout);
    const detail = await json<RepoDetail>(api, ownerToken);
    const branch = detail.branches.find((b) => b.shortName === "agent-e2e");
    assert(
      branch && /^[a-f0-9]{40}$/.test(branch.oid),
      "Pushed ref must be visible through the server",
    );
    const mirror = join(work, "ref-reader");
    await gm(["clone", fullName, mirror], "sam");
    const bookmarks = await gm(["bookmark", "list"], "sam", mirror);
    assert(
      bookmarks.includes(branch.oid) || bookmarks.includes("agent-e2e"),
      "Independent clone must see pushed ref",
    );
    await writeFile(join(checkout, "agent-e2e.txt"), `${bytes}denied change\n`);
    await gm(["commit", "-m", "Denied transport regression"], "jun", checkout);
    for (const persona of ["sam", "read"] as const)
      await gm(
        ["push", "--bookmark", "agent-e2e"],
        persona,
        checkout,
        /403|denied|forbidden|read.only|write access|permission/i,
      );
    const after = await json<RepoDetail>(api, ownerToken);
    assert.equal(
      after.branches.find((b) => b.shortName === "agent-e2e")?.oid,
      branch.oid,
      "Denied pushes must not move the server ref",
    );
    record({ ref: branch.shortName, oid: branch.oid, deniedRefUnchanged: true });
  });

  await scenario("tracker-claim-sync-complete-and-blocked-transitions", async () => {
    const owner = fixtures.tracker.owner;
    await gm(["tracker", "use", owner]);
    await gm(["tracker", "sync", "--owner", owner]);
    await gm(
      ["issue", "claim", fixtures.tracker.blocked, "--owner", owner, "--agent", "e2e"],
      "marco",
      work,
      /blocked|blocker|not.ready/i,
    );
    const claimed = JSON.parse(
      await gm(["issue", "claim", fixtures.tracker.ready, "--owner", owner, "--agent", "e2e"]),
    ) as { results: { leaseToken: string }[] };
    const lease = claimed.results[0]?.leaseToken;
    assert(lease, "Claim must return a fencing token");
    secrets.add(lease);
    await gm(
      ["issue", "claim", fixtures.tracker.ready, "--owner", owner, "--agent", "contender"],
      "jun",
      work,
      /claim|lease|conflict|owned/i,
    );
    await gm(
      [
        "issue",
        "complete",
        fixtures.tracker.ready,
        "--owner",
        owner,
        "--evidence",
        "invalid lease must not complete",
      ],
      "marco",
      work,
      /lease|fenc|token|conflict/i,
      { GM_LEASE_TOKEN: "invalid-fencing-token" },
    );
    await gm(
      [
        "issue",
        "complete",
        fixtures.tracker.ready,
        "--owner",
        owner,
        "--evidence",
        "Real gm claim and fenced completion verified",
      ],
      "marco",
      work,
      undefined,
      { GM_LEASE_TOKEN: lease },
    );
    await gm(["tracker", "sync", "--owner", owner]);
    const completed = JSON.parse(
      await gm(["issue", "show", fixtures.tracker.ready, "--owner", owner, "--offline"]),
    ) as { issue: { status: string }; notes: { body: string }[] };
    assert.equal(completed.issue.status, "done");
    assert(completed.notes.some((n) => n.body === "Real gm claim and fenced completion verified"));
    await gm(
      ["tracker", "use", owner],
      "sam",
      work,
      /403|404|access|forbidden|not.found|permission/i,
    );
    record({ issue: fixtures.tracker.ready, status: completed.issue.status, evidenceSynced: true });
  });

  await scenario("package-upload-download-and-write-boundary", async () => {
    const file = join(work, "artifact.txt");
    await writeFile(file, bytes);
    await gm(["pkg", "upload", file, `${packageName}/1.0.0/artifact.txt`, "--owner", repo.owner]);
    assert.equal(
      await request(`/generic/${repo.owner}/${packageName}/1.0.0/artifact.txt`, ownerToken),
      bytes,
    );
    await gm(
      ["pkg", "upload", file, `${packageName}/forbidden/artifact.txt`, "--owner", repo.owner],
      "read",
      work,
      /403|denied|forbidden|read.only|permission/i,
    );
    await gm(["pkg", "grant", `generic/${packageName}`, fullName, "--owner", repo.owner]);
  });

  async function pushPipeline(jobs: Record<string, unknown>, branch: string, automatic = false) {
    await mkdir(join(checkout, ".gitmatrix"), { recursive: true });
    // JSON is a YAML subset. Manual scenarios must not also launch an automatic run.
    await writeFile(
      join(checkout, ".gitmatrix", "ci.yml"),
      JSON.stringify({
        on: { push: { branches: [automatic ? branch : "never-agent-auto"] } },
        jobs,
      }),
    );
    await gm(["commit", "-m", `Agent ${branch}`], "marco", checkout);
    await gm(["push", "--bookmark", branch], "marco", checkout);
    if (automatic) {
      const run = await poll(
        async () =>
          (await json<CiRunList>(`${api}/ci`, ownerToken)).runs.find((r) => r.ref === branch),
        (value) => value !== undefined,
        "push-triggered run",
      );
      assert(run);
      assert.equal(run.trigger, "push");
      return run.number;
    }
    return (
      await json<{ number: number }>(`${api}/ci/runs`, ownerToken, "POST", { ref: branch }, [201])
    ).number;
  }
  const runDetail = async (number: number) => {
    const run = await json<CiRunDetail>(`${api}/ci/runs/${number}`, ownerToken);
    if (terminal(run)) {
      record({ run });
      for (const job of run.jobs.filter((job) => job.status === "failed"))
        record({ job: job.name, logs: await json(`${api}/ci/jobs/${job.id}/logs`, ownerToken) });
    }
    return run;
  };
  const terminal = (run: CiRunDetail) => !["queued", "running"].includes(run.status);
  const publish = `printf 'gitmatrix live regression artifact\\n' > artifact.txt\ncurl --fail --silent --show-error -X PUT -H "Authorization: Bearer $GITMATRIX_TOKEN" --data-binary @artifact.txt "\${GITMATRIX_GENERIC_URL}${packageName}/2.0.0/artifact.txt"`;

  await scenario("ci-push-triggered-local-dag-and-provenance", async () => {
    const number = await pushPipeline(
      {
        build: {
          steps: [{ run: "test -f agent-e2e.txt && printf 'AGENT_CI_WORKSPACE=%s\\n' \"$PWD\"" }],
        },
        publish: { needs: ["build"], steps: [{ run: publish }] },
      },
      "agent-ci-success",
      true,
    );
    const successRun = await poll(() => runDetail(number), terminal, "successful local DAG");
    assert.equal(successRun.status, "succeeded");
    assert.deepEqual(
      successRun.jobs.map((j) => [j.name, j.status]),
      [
        ["build", "succeeded"],
        ["publish", "succeeded"],
      ],
    );
    for (const job of successRun.jobs) {
      assert.equal(job.runner, "local");
      assert(job.claimedBy, "Real runner must claim each job");
    }
    assert(
      successRun.jobs[1]!.startedAt! >= successRun.jobs[0]!.finishedAt!,
      "Dependent starts after prerequisite finishes",
    );
    const buildLogs = await json<CiLogs>(
      `${api}/ci/jobs/${successRun.jobs[0]!.id}/logs`,
      ownerToken,
    );
    const workspace = buildLogs.chunks
      .map((chunk) => chunk.text)
      .join("")
      .match(/^AGENT_CI_WORKSPACE=(.+)$/m)?.[1];
    assert(
      workspace?.startsWith(`${join(ctx.work, "tmp")}/`),
      `CI workspace escaped environment: ${workspace}`,
    );
    record({ workspace });
    const published = await json<Published>(
      `/api/packages/-/published?repo=${fullName}&run=${number}`,
      ownerToken,
    );
    const row = published.rows.find((r) => r.package === packageName && r.version === "2.0.0");
    assert(row, "CI must publish through the registry");
    assert.equal(row.repo, fullName);
    assert.equal(row.runNumber, number);
    assert.equal(row.commit, successRun.commit);
    assert.equal(row.ref, "agent-ci-success");
    assert.equal(
      await request(`/generic/${repo.owner}/${packageName}/2.0.0/artifact.txt`, ownerToken),
      bytes,
    );
    record({ publish: row });
  });

  await scenario("ci-failing-prerequisite-skips-dependent", async () => {
    const number = await pushPipeline(
      {
        fail: { steps: [{ run: "printf 'intentional agent failure\\n'; exit 23" }] },
        blocked: { needs: ["fail"], steps: [{ run: "echo must-not-run; exit 0" }] },
      },
      "agent-ci-failure",
    );
    const run = await poll(() => runDetail(number), terminal, "failed prerequisite DAG");
    assert.equal(run.status, "failed");
    assert.equal(run.jobs.find((j) => j.name === "fail")?.exitCode, 23);
    const blocked = run.jobs.find((j) => j.name === "blocked");
    assert.equal(blocked?.status, "skipped");
    assert.equal(blocked?.claimedBy, null);
    record({ run });
  });

  await scenario("ci-cancellation-and-job-token-lifetime", async () => {
    const capability = randomUUID();
    let liveToken: string | undefined;
    let waiting: ServerResponse | undefined;
    const collector = createServer((req, res) => {
      if (req.method === "GET" && req.url === `/${capability}/wait`) {
        waiting = res;
        res.setTimeout(60_000, () => res.writeHead(504).end());
        return;
      }
      if (req.method !== "POST" || req.url !== `/${capability}`) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 1024) req.destroy();
      });
      req.on("end", () => {
        if (/^gmj_[A-Za-z0-9_-]+$/.test(body)) {
          liveToken = body;
          secrets.add(body);
          res.writeHead(204).end();
        } else res.writeHead(400).end();
      });
    });
    const listening = Promise.withResolvers<void>();
    collector.once("error", listening.reject);
    collector.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = collector.address();
      assert(address && typeof address !== "string");
      const capture = `curl --fail --silent --show-error --max-time 20 --data-binary "$GITMATRIX_TOKEN" http://127.0.0.1:${address.port}/${capability}\nexec >/dev/null 2>&1\ncurl --fail --silent --show-error --max-time 65 http://127.0.0.1:${address.port}/${capability}/wait`;
      for (const expected of ["succeeded", "cancelled"] as const) {
        liveToken = undefined;
        waiting = undefined;
        const number = await pushPipeline(
          { hold: { env: { AGENT_EXPECTED_OUTCOME: expected }, steps: [{ run: capture }] } },
          `agent-ci-token-${expected}`,
        );
        const token = await poll<string | undefined>(
          async () => liveToken,
          (value) => Boolean(value),
          "running job credential",
        );
        assert(token);
        const gate = await poll<ServerResponse | undefined>(
          async () => waiting,
          (value) => Boolean(value),
          "runner release gate",
        );
        assert(gate);
        // Registry authentication, not the normal user-token API, accepts job credentials.
        await request(`/api/packages/${repo.owner}/generic/${packageName}`, token);
        assert.equal(gate.destroyed, false, "held step exited before cancellation/release");
        if (expected === "cancelled") {
          await gm(["runs", "cancel", String(number), "--repo", fullName]);
          // Do not release the request: cancellation must stop the closed-output
          // process itself, not merely mark its database row as cancelled.
          await poll(async () => gate.destroyed, Boolean, "cancelled process disconnect", 20_000);
          assert.equal(gate.writableEnded, false, "collector must not release the cancelled step");
          record({ closedOutputProcessStopped: true });
        } else {
          gate.writeHead(204).end();
        }
        const run = await poll(() => runDetail(number), terminal, `job token ${expected} run`);
        assert.equal(run.status, expected);
        assert(run.jobs.every((job) => job.status === expected));
        await request(
          `/api/packages/${repo.owner}/generic/${packageName}`,
          token,
          "GET",
          undefined,
          [401, 403],
        );
        record({ run, jobTokenAcceptedWhileRunning: true, jobTokenRejectedAfterEnd: true });
      }
    } finally {
      collector.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      collector.close((error) => (error ? closed.reject(error) : closed.resolve()));
      await closed.promise;
    }
  });

  await scenario("browser-personas-persisted-product-state", async () => {
    const browser = await chromium.launch({ headless: true });
    const contexts: BrowserContext[] = [];
    try {
      for (const persona of ["marco", "sam"] as const) {
        const context = await browser.newContext({ baseURL: ctx.origin });
        contexts.push(context);
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        try {
          await page.goto("/signin");
          await page
            .getByRole("button", { name: new RegExp(`Continue as ${persona}`, "i") })
            .click();
          await page.waitForURL((url) => url.pathname !== "/signin");
          const persistent = async (path: string, check: () => Promise<void>) => {
            await page.goto(path);
            await check();
            await page.reload();
            await check();
          };
          await persistent(`/${fullName}`, async () => {
            await expect(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();
            await expect(
              page.getByRole("link", { name: "Packages", exact: true }).first(),
            ).toBeVisible();
          });
          await persistent(`/${fullName}/ci`, async () => {
            await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
            await expect(page.getByRole("link", { name: /Agent agent-ci-success/ })).toBeVisible();
            if (persona === "sam")
              await expect(page.getByRole("button", { name: /^Run / })).toHaveCount(0);
            else await expect(page.getByRole("button", { name: /^Run / })).toBeVisible();
          });
          if (persona === "marco") {
            await persistent(
              `/tracker/${fixtures.tracker.owner}/issues/${fixtures.tracker.ready}`,
              async () => {
                await expect(
                  page.getByText("Agent ready fixture", { exact: true }).first(),
                ).toBeVisible();
                await expect(
                  page.getByText("Real gm claim and fenced completion verified", { exact: true }),
                ).toBeVisible();
              },
            );
            await persistent(`/${repo.owner}/-/packages/generic/${packageName}`, async () => {
              await expect(
                page.getByRole("heading", { name: packageName, exact: true }),
              ).toBeVisible();
              await expect(page.getByText("2.0.0", { exact: true }).first()).toBeVisible();
            });
          } else {
            await persistent(`/tracker/${fixtures.tracker.owner}`, async () => {
              await expect(
                page.getByText(/not found|not available|access|permission|forbidden/i).first(),
              ).toBeVisible();
              await expect(page.getByText("Agent ready fixture", { exact: true })).toHaveCount(0);
            });
          }
          await page.screenshot({
            path: join(ctx.artifacts, `browser-${persona}.png`),
            fullPage: true,
          });
          await context.tracing.stop();
          record({ persona, independentContext: true, reloadAssertions: true });
        } catch (error) {
          await page
            .screenshot({
              path: join(ctx.artifacts, `browser-${persona}-failure.png`),
              fullPage: true,
            })
            .catch(() => {});
          await context.tracing
            .stop({ path: join(ctx.artifacts, `browser-${persona}-failure.zip`) })
            .catch(() => {});
          throw error;
        }
      }
    } finally {
      for (const context of contexts) await context.close();
      await browser.close();
    }
  });

  await scenario("provider-boundaries", () => runProviderE2E(ctx, fixtures));
}
