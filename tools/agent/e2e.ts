import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, expect as playwrightExpect, type BrowserContext } from "@playwright/test";
import type {
  Agent,
  AgentCapabilities,
  CiLogs,
  CiRunDetail,
  CiRunList,
  CreatedAccessToken,
  HistoryPage,
  RefUpdateList,
  RepoDetail,
} from "../../apps/website/shared/api.ts";
import type { Deployment, DeploymentList } from "../../apps/website/shared/deployments.ts";
import type { Published } from "../../apps/website/shared/packages.ts";
import type { Snapshot } from "../../apps/website/shared/tracker.ts";
import type { Chronicle, LinkedWork } from "../../apps/website/shared/chronicle.ts";
import type { Checkpoint, Landing, TimelineDetail } from "../../apps/website/shared/timelines.ts";
import type { SourceSnapshot } from "../../apps/website/shared/code-source.ts";
import type { UsageReport } from "../../apps/website/shared/usage.ts";
import type { WhyResponse } from "../../apps/website/shared/why.ts";
import type { StepFeedRecord, StepPage } from "../../apps/website/shared/steps.ts";
import { atlasRevocationScenario, atlasSmokeScenario } from "./atlas-e2e.ts";
import { chronicleScenario } from "./chronicle-e2e.ts";
import type { HarnessContext, Persona, SeedManifest } from "./types.ts";
import { runQueueE2E } from "./queue-e2e.ts";
import { runSourceMigrationE2E } from "./source-migration-e2e.ts";
import { runSourceRetentionE2E } from "./source-retention-e2e.ts";
import { runSourceAuthE2E } from "./source-auth-e2e.ts";
import { runSourceLandingE2E } from "./source-landing-e2e.ts";
import { runSourceSyncE2E } from "./source-sync-e2e.ts";

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
    failure?: RegExp | true,
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
    // A command that waits with its own --timeout gets that long, and a minute more.
    const asked = Number(args[args.indexOf("--timeout") + 1]);
    const limit = Math.max(180, args.includes("--timeout") && asked > 0 ? asked + 60 : 0);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, limit * 1000);
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
      if (timedOut) reject(new Error(`gm ${args[0]} exceeded ${limit} seconds`));
      else resolve({ code, stdout, stderr });
    });
    const result = await promise;
    record({ client: "gm", args, persona, code: result.code, stderr: result.stderr });
    if (failure) {
      assert.notEqual(result.code, 0, `gm ${args.join(" ")} unexpectedly succeeded`);
      if (failure !== true)
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

  async function timelineSource(slug: string) {
    const detail = await json<TimelineDetail>(
      `/api/tracker/${fixtures.tracker.owner}/timelines/${slug}`,
      ownerToken,
    );
    const entry = detail.timeline.repos.find(
      (entry) => `${entry.owner}/${entry.name}` === fullName,
    );
    assert(entry?.source, "An owned timeline exposes its source identity");
    assert.match(entry.source.sourceId, /^work_[0-9a-f-]+$/);
    assert.equal(entry.source.kind, "timeline-work");
    assert.equal(entry.source.timelineId, detail.timeline.id);
    assert.equal(entry.source.ref, "refs/heads/work");
    assert.equal(entry.bookmark, "work");
    return entry.source;
  }
  async function sourceTip(slug: string) {
    const source = await timelineSource(slug);
    return (await json<RepoDetail>(`${api}?source=${source.sourceId}`, ownerToken)).branches.find(
      (branch) => branch.shortName === "work",
    )?.oid;
  }
  async function nativeGit(args: string[], cwd = work, token = ownerToken) {
    const env: NodeJS.ProcessEnv = { ...ctx.env };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_CONFIG_") || key === "SSH_AUTH_SOCK") delete env[key];
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${ctx.origin}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    });
    return (
      await promisify(execFile)("git", args, {
        cwd,
        env,
        timeout: 90_000,
        maxBuffer: 16 << 20,
      })
    ).stdout.trim();
  }

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
    await gm(
      [
        "commit",
        "-m",
        "Agent live transport regression\n\nCo-authored-by: Fixture Agent <agent@gitmatrix.invalid>",
      ],
      "jun",
      checkout,
    );
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

  await scenario("repository-file-history-and-attribution", async () => {
    const history = await json<HistoryPage>(`${api}/history?at=agent-e2e&entries=true`, ownerToken);
    assert.equal(history.next, null);
    assert.equal(history.commits.length, 2);
    assert.equal(history.entries["agent-e2e.txt"]?.count, 1);
    assert.equal(history.entries["agent-e2e.txt"]?.latest.oid, history.head);
    assert.match(history.entries["agent-e2e.txt"]!.latest.message, /Co-authored-by: Fixture Agent/);
    const file = await json<HistoryPage>(
      `${api}/history?at=${history.head}/agent-e2e.txt`,
      ownerToken,
    );
    assert.equal(file.commits.length, 1);
    assert.equal(file.commits[0]?.oid, history.head);
    const readme = await json<HistoryPage>(
      `${api}/history?at=${history.head}/README.md`,
      ownerToken,
    );
    assert.equal(readme.commits.length, 1);
    assert.notEqual(readme.commits[0]?.oid, history.head);
    await request(`${api}/history`, null, "GET", undefined, [401, 404]);
    await request(
      `/api/repos/${outsiderRepo.owner}/${outsiderRepo.name}/history`,
      ownerToken,
      "GET",
      undefined,
      [404],
    );
    await request(`${api}/history?ref=main&path=../README.md`, ownerToken, "GET", undefined, [400]);
    record({
      pinnedHead: history.head,
      repoCommits: history.commits.length,
      fileCommits: file.commits.length,
      coAuthor: "Fixture Agent",
    });
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

  await scenario("chronicle-history-and-linked-work-over-api", async () => {
    // CORE-250: real gm work on a fresh issue, read back by time from the
    // Tracker Durable Object in workerd: its states, its work span and markers.
    const owner = fixtures.tracker.owner;
    const from = new Date(Date.now() - 5_000).toISOString();
    const id = randomUUID();
    const created = await json<{ events: { entity: { key?: string } | null }[] }>(
      `/api/tracker/${owner}/mutate`,
      ownerToken,
      "POST",
      {
        operationId: randomUUID(),
        mutations: [
          {
            kind: "issue.create",
            id,
            data: { teamId: fixtures.tracker.team, title: "Chronicle fixture" },
          },
        ],
      },
    );
    const key = created.events.find((event) => event.entity?.key)?.entity?.key;
    assert(key, "The new issue has a key");
    await gm(["tracker", "sync", "--owner", owner]);
    const claimed = JSON.parse(
      await gm(["issue", "claim", key, "--owner", owner, "--agent", "chronicle-e2e"]),
    ) as { results: { leaseToken: string }[] };
    const lease = claimed.results[0]?.leaseToken;
    assert(lease, "Claim must return a fencing token");
    secrets.add(lease);
    await gm(["issue", "renew", key, "--owner", owner], "marco", work, undefined, {
      GM_LEASE_TOKEN: lease,
    });
    await gm(
      ["issue", "complete", key, "--owner", owner, "--evidence", "Chronicle verified"],
      "marco",
      work,
      undefined,
      { GM_LEASE_TOKEN: lease },
    );
    const to = new Date(Date.now() + 1_000).toISOString();
    const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const chronicle = await json<Chronicle>(
      `/api/tracker/${owner}/chronicle?${range}&q=${encodeURIComponent("chronicle fixture")}`,
      ownerToken,
    );
    const row = chronicle.issues.find((issue) => issue.id === id);
    assert(row, `${key} is a row of the Chronicle`);
    assert.equal(row.start.status, null, "It didn't exist at the range's start");
    assert.deepEqual(
      row.segments.map((segment) => segment.status),
      ["todo", "in_progress", "done"],
    );
    assert.equal(row.spans.length, 1);
    const span = row.spans[0]!;
    assert.equal(span.endedBy, "complete");
    assert.equal(span.session, "chronicle-e2e");
    assert.equal(span.renewals.length, 1, "The renewal is on the span");
    assert.equal(chronicle.actors[span.holder]?.kind, "person");
    assert.deepEqual(
      row.markers.map((marker) => marker.kind),
      ["created", "evidence"],
    );
    assert(chronicle.density && chronicle.density.counts.some((n) => n > 0));
    const linked = await json<LinkedWork>(
      `/api/tracker/${owner}/issues/${encodeURIComponent(key)}/work`,
      ownerToken,
    );
    assert.equal(linked.issue.key, key);
    assert.equal(linked.issue.status, "done");
    // Outside the tracker: no Chronicle, no linked work.
    await request(
      `/api/tracker/${owner}/chronicle?${range}`,
      fixtures.tokens.sam,
      "GET",
      undefined,
      [403],
    );
    await request(
      `/api/tracker/${owner}/issues/${encodeURIComponent(key)}/work`,
      fixtures.tokens.sam,
      "GET",
      undefined,
      [403],
    );
    record({ key, span: { endedBy: span.endedBy, renewals: span.renewals.length } });
  });

  await scenario("timeline-fork-owned-source-and-abandon-permissions", async () => {
    // Forks allocate a separate source; abandonment archives it without changing main.
    const timelines = `/api/tracker/${fixtures.tracker.owner}/timelines`;
    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    const jun = fixtures.tokens.jun;
    await request(timelines, fixtures.tokens.sam, "POST", { slug, repos: [fullName] }, [403]);
    const before = await json<RepoDetail>(api, ownerToken);
    const created = await json<{
      timeline: { id: string; slug: string; forkPoint: { commits: Record<string, string> } };
      bookmarks: { ok: boolean }[];
    }>(timelines, jun, "POST", { slug, repos: [fullName] }, [201]);
    assert(
      created.bookmarks.every((b) => b.ok),
      "Every work source must be ready",
    );
    const forked = Object.values(created.timeline.forkPoint.commits)[0];
    const main = before.branches.find((b) => b.shortName === before.defaultBranch)?.oid;
    assert.equal(forked, main, "A fork from main starts at the default branch's tip");
    const source = await timelineSource(slug);
    assert.equal(await sourceTip(slug), forked);
    const canonical = await json<RepoDetail>(api, ownerToken);
    assert(!canonical.branches.some((b) => b.shortName === `timeline/${slug}`));
    assert(!canonical.branches.some((b) => b.shortName === "work"));
    const retried = await json<typeof created>(
      timelines,
      jun,
      "POST",
      { slug, repos: [fullName] },
      [201],
    );
    assert.equal(retried.timeline.id, created.timeline.id, "A retry reuses the timeline");
    assert.deepEqual(retried.timeline.forkPoint, created.timeline.forkPoint);
    assert.deepEqual(await timelineSource(slug), source, "A retry reuses the owned source");
    await request(`${timelines}/${slug}/abandon`, ownerToken, "POST", undefined, [403]);
    const abandoned = await json<{ timeline: { status: string }; bookmarks: { ok: boolean }[] }>(
      `${timelines}/${slug}/abandon`,
      jun,
      "POST",
    );
    assert.equal(abandoned.timeline.status, "abandoned");
    assert(
      abandoned.bookmarks.every((b) => b.ok),
      "Every work source is archived",
    );
    assert.equal(await sourceTip(slug), forked, "Abandoned work remains readable");
    assert.equal(
      (await json<RepoDetail>(api, ownerToken)).branches.find(
        (b) => b.shortName === before.defaultBranch,
      )?.oid,
      main,
      "Abandoning does not mutate canonical main",
    );
    const detail = await json<{ events: { kind: string; lastCommits?: Record<string, string> }[] }>(
      `${timelines}/${slug}`,
      ownerToken,
    );
    assert.deepEqual(
      detail.events.map((e) => e.kind),
      ["fork", "abandon"],
    );
    assert.equal(Object.values(detail.events[1]!.lastCommits ?? {})[0], forked);
    record({ timeline: slug, source, forked, abandoned: true, archiveReadable: true });
  });

  await scenario("gm-timeline-start-push-and-abandon", async () => {
    // A bound checkout pushes to its owned source, never a canonical timeline branch.
    const owner = fixtures.tracker.owner;
    const slug = `gm-e2e-${randomUUID().slice(0, 8)}`;
    const bookmark = "work";
    const clone = join(work, "timeline-checkout");
    await gm(["clone", fullName, clone], "jun");
    const binding = () =>
      readFile(join(clone, ".gitmatrix/agent.local.yml"), "utf8").catch(() => "");
    const mainTip = async () => {
      const detail = await json<RepoDetail>(api, ownerToken);
      return detail.branches.find((b) => b.shortName === detail.defaultBranch)?.oid;
    };
    const main = await mainTip();

    const dry = JSON.parse(
      await gm(["timeline", "start", slug, "--owner", owner, "--dry-run"], "jun", clone),
    ) as { dry_run: boolean; request: { slug: string; repos: string[] } };
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.request.repos, [fullName], "The checkout's repository is the default");
    assert.equal(await binding(), "", "A dry run binds nothing");

    const started = JSON.parse(
      await gm(["timeline", "start", slug, "--owner", owner, "--policy", "approval"], "jun", clone),
    ) as { timeline: { slug: string; policy: string }; use: { timeline: string } };
    assert.equal(started.timeline.slug, slug);
    assert.equal(started.timeline.policy, "approval");
    assert.equal(started.use.timeline, slug, "Starting binds the checkout");
    assert.match(await binding(), new RegExp(`timeline: ${slug}`));
    const source = await timelineSource(slug);
    const beforeMigration = await json<TimelineDetail>(
      `/api/tracker/${owner}/timelines/${slug}`,
      ownerToken,
    );
    await gm(["timeline", "migrate", slug, "--owner", owner], "jun", clone);
    await gm(["timeline", "migrate", slug, "--owner", owner], "jun", clone);
    const afterMigration = await json<TimelineDetail>(
      `/api/tracker/${owner}/timelines/${slug}`,
      ownerToken,
    );
    assert.deepEqual(
      afterMigration.timeline,
      beforeMigration.timeline,
      "Migrating an already-owned timeline is an exact no-op",
    );
    assert.deepEqual(afterMigration.events, beforeMigration.events);

    await writeFile(join(clone, "timeline-e2e.txt"), "timeline work\n");
    await gm(["commit", "-m", "Timeline work from gm"], "jun", clone);
    await gm(["push"], "jun", clone);
    const tip = await poll(
      () => json<RepoDetail>(`${api}?source=${source.sourceId}`, ownerToken),
      (detail) => detail.branches.some((b) => b.shortName === bookmark && b.oid !== main),
      "the pushed owned work source",
    );
    await gm(["push", "-b", "main"], "jun", clone, /timeline_bound/);
    assert.equal(await mainTip(), main, "Main never moves from a bound checkout");
    await gm(["timeline", "merge", "main", "--dry-run"], "jun", clone);

    const list = JSON.parse(await gm(["timeline", "list", "--owner", owner], "jun", clone)) as {
      timelines: { slug: string }[];
      current: string;
    };
    assert(list.timelines.some((t) => t.slug === slug));
    assert.equal(list.current, slug);
    const shown = JSON.parse(await gm(["timeline", "show", "--owner", owner], "jun", clone)) as {
      events: { kind: string }[];
    };
    assert.equal(shown.events[0]?.kind, "fork");

    // CORE-86: any writer flags it experimental and clears the flag; stalled
    // lists leave experimental timelines out (and a fresh one hasn't stalled).
    const flagged = JSON.parse(
      await gm(["timeline", "flag", "--experimental", "--owner", owner], "marco", clone),
    ) as { timeline: { experimental: boolean } };
    assert.equal(flagged.timeline.experimental, true);
    const stalled = JSON.parse(
      await gm(["timeline", "list", "--stalled", "--owner", owner], "jun", clone),
    ) as { timelines: { slug: string }[]; idleDays: number };
    assert(!stalled.timelines.some((t) => t.slug === slug), "Experimental never stalls");
    assert(stalled.idleDays > 0);
    const cleared = JSON.parse(
      await gm(["timeline", "update", "--no-experimental", "--owner", owner], "jun", clone),
    ) as { timeline: { experimental: boolean } };
    assert.equal(cleared.timeline.experimental, false);

    // Only its accountable person (or the agent that started it) abandons it.
    await gm(["timeline", "abandon", "--owner", owner], "marco", clone, /"forbidden"/);
    const abandoned = JSON.parse(
      await gm(["timeline", "abandon", "--owner", owner], "jun", clone),
    ) as { timeline: { status: string } };
    assert.equal(abandoned.timeline.status, "abandoned");
    assert.match(await binding(), new RegExp(`timeline: ${slug}`));
    await gm(["push"], "jun", clone, /timeline_ended/);
    await gm(["timeline", "use", "main", "--owner", owner], "jun", clone);
    assert.doesNotMatch(await binding(), /timeline:/);
    assert.equal(
      await sourceTip(slug),
      tip.branches.find((b) => b.shortName === bookmark)?.oid,
      "Abandon preserves the archived source head",
    );
    record({
      timeline: slug,
      pushed: tip.branches.find((b) => b.shortName === bookmark)?.oid,
      mainUnchanged: true,
      abandoned: true,
    });
  });

  await scenario("agent-capabilities-self-reporting-and-claim-identity", async () => {
    const name = `capabilities-${randomUUID().slice(0, 8)}`;
    const skillDir = join(work, "capability-skills");
    const home = join(work, "capability-home");
    await mkdir(home, { recursive: true });
    // Keep reports independent of the developer's installed skills and ancestors.
    const profileGm = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
      gm(args, "marco", checkout, undefined, { HOME: home, USERPROFILE: home, ...extra });
    await mkdir(join(skillDir, "native-review"), { recursive: true });
    await writeFile(
      join(skillDir, "native-review", "SKILL.md"),
      "---\nname: native-review\ndescription: Review native changes.\n---\nPRIVATE_SKILL_BODY_NOT_FOR_PROFILE\n",
    );
    const detection = await profileGm(["agent", "detect", "--skill-dir", skillDir]);
    const detected = JSON.parse(detection) as AgentCapabilities;
    assert.equal(
      detected.environment.os,
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : process.platform,
    );
    assert.deepEqual(detected.skills, [
      { name: "native-review", description: "Review native changes.", source: "detected" },
    ]);
    assert(
      !detection.includes("PRIVATE_SKILL_BODY_NOT_FOR_PROFILE"),
      "Skill prompts must not be exposed as capability metadata",
    );
    const created = JSON.parse(
      await profileGm([
        "agent",
        "configure",
        name,
        "--model",
        "fixture-model",
        "--tag",
        "native-e2e",
        "--skill",
        "fixture-review",
        "--skill-dir",
        skillDir,
      ]),
    ) as { agent: Agent };
    const agent = created.agent;
    assert.equal(agent.name, name);
    assert.equal(agent.capabilities?.model, "fixture-model");
    assert.deepEqual(agent.capabilities?.tags, ["native-e2e"]);
    assert(
      agent.capabilities?.skills.some(
        (skill) => skill.name === "fixture-review" && skill.source === "declared",
      ),
    );
    assert(agent.capabilitiesUpdatedAt && !Number.isNaN(Date.parse(agent.capabilitiesUpdatedAt)));

    const writeToken = await json<CreatedAccessToken>(
      `/api/agents/${agent.id}/tokens`,
      ownerToken,
      "POST",
      { scope: "write" },
      [201],
    );
    const readToken = await json<CreatedAccessToken>(
      `/api/agents/${agent.id}/tokens`,
      ownerToken,
      "POST",
      { scope: "read" },
      [201],
    );
    secrets.add(writeToken.secret);
    secrets.add(readToken.secret);
    const agentEnv = { GM_TOKEN: writeToken.secret };
    const refreshed = JSON.parse(
      await profileGm(["agent", "configure", "--skill-dir", skillDir], agentEnv),
    ) as { agent: Agent };
    assert.equal(refreshed.agent.id, agent.id);
    assert.equal(refreshed.agent.capabilities?.model, "fixture-model");
    assert.deepEqual(refreshed.agent.capabilities?.tags, ["native-e2e"]);
    assert(
      refreshed.agent.capabilities?.skills.some(
        (skill) => skill.name === "fixture-review" && skill.source === "declared",
      ),
    );
    const shown = JSON.parse(await profileGm(["agent", "show"], agentEnv)) as {
      agent: Agent;
    };
    assert.deepEqual(shown.agent.capabilities, refreshed.agent.capabilities);
    const visible = JSON.parse(
      await gm(["agent", "list", "--owner", fixtures.tracker.owner], "jun"),
    ) as { agents: Pick<Agent, "id" | "capabilities">[] };
    assert.deepEqual(
      visible.agents.find((candidate) => candidate.id === agent.id)?.capabilities,
      shown.agent.capabilities,
    );

    assert(shown.agent.capabilities);
    const capabilities = shown.agent.capabilities;
    await request(`/api/agents/self/capabilities`, readToken.secret, "PUT", capabilities, [403]);
    await request(
      `/api/agents/${agent.id}/capabilities`,
      fixtures.tokens.sam,
      "PUT",
      capabilities,
      [404],
    );
    await request(
      `/api/agents/${agent.id}/tokens`,
      writeToken.secret,
      "POST",
      { scope: "write" },
      [403],
    );
    const other = await json<{ agent: Agent }>(
      "/api/agents",
      ownerToken,
      "POST",
      { name: `${name}-other` },
      [201],
    );
    await request(
      `/api/agents/${other.agent.id}/capabilities`,
      writeToken.secret,
      "PUT",
      capabilities,
      [403, 404],
    );

    const claim = JSON.parse(
      await gm(
        [
          "issue",
          "claim",
          fixtures.tracker.blocker,
          "--owner",
          fixtures.tracker.owner,
          "--agent",
          name,
        ],
        "marco",
        work,
        undefined,
        agentEnv,
      ),
    ) as { results: { leaseToken: string }[] };
    const lease = claim.results[0]?.leaseToken;
    assert(lease, "Agent claim must return a fencing token");
    secrets.add(lease);
    const claimed = JSON.parse(
      await gm(
        ["issue", "show", fixtures.tracker.blocker, "--owner", fixtures.tracker.owner],
        "marco",
        work,
        undefined,
        agentEnv,
      ),
    ) as { issue: { claim: { actorId: string; accountableId: string } } };
    assert.equal(claimed.issue.claim.actorId, agent.id);
    assert.equal(claimed.issue.claim.accountableId, agent.accountable.id);
    await gm(
      ["issue", "release", fixtures.tracker.blocker, "--owner", fixtures.tracker.owner],
      "marco",
      work,
      undefined,
      { ...agentEnv, GM_LEASE_TOKEN: lease },
    );

    // Requirements (CORE-32): next passes over what the agent doesn't meet and
    // says so, a claim names what's missing, and people can lift them.
    const owner = fixtures.tracker.owner;
    const key = `R${randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase()}`;
    await json(`/api/tracker/${owner}/mutate`, ownerToken, "POST", {
      operationId: randomUUID(),
      mutations: [{ kind: "team.create", id: randomUUID(), data: { key, name: "Requirements" } }],
    });
    const create = async (title: string, priority: string, requires: string) =>
      (
        JSON.parse(
          await gm([
            "issue",
            "create",
            title,
            "--team",
            key,
            "--priority",
            priority,
            "--requires",
            requires,
            "--owner",
            owner,
          ]),
        ) as { entities: { id: string; key: string | null; requires?: unknown }[] }
      ).entities[0]!;
    const gpu = await create("Needs a GPU", "0", "tag:gpu memory>=1TiB");
    const native = await create("Native work", "1", "tag:NATIVE-E2E model:fixture-*");
    assert.deepEqual(native.requires, { tags: ["native-e2e"], models: ["fixture-*"] });
    const asAgent = (args: string[], failure?: RegExp) =>
      gm([...args, "--owner", owner], "marco", work, failure, agentEnv);
    const picked = JSON.parse(await asAgent(["issue", "next", "--team", key, "--agent", name])) as {
      claimed: { issueId: string; leaseToken: string } | null;
      skipped: { requirements: number; keys: string[]; message: string };
    };
    assert.equal(picked.claimed?.issueId, native.id, "next takes the issue it meets");
    secrets.add(picked.claimed!.leaseToken);
    assert.equal(picked.skipped.requirements, 1);
    assert.deepEqual(picked.skipped.keys, [`${key}-1`]);
    await asAgent(["issue", "release", native.id]);
    // Refused, naming each requirement it misses.
    await asAgent(
      ["issue", "claim", gpu.id, "--agent", name],
      /requirements_unmet[\s\S]*needs tag gpu[\s\S]*needs at least 1TiB of memory/,
    );
    const eligibility = JSON.parse(await asAgent(["issue", "show", gpu.id])) as {
      issue: { requiresText: string };
      eligibility: { eligible: boolean; unmet: { wanted: string }[] };
    };
    assert.equal(eligibility.issue.requiresText, "tag:gpu memory>=1TiB");
    assert.equal(eligibility.eligibility.eligible, false);
    assert.deepEqual(
      eligibility.eligibility.unmet.map((u) => u.wanted),
      ["tag:gpu", "memory>=1TiB"],
    );
    await gm(["issue", "update", gpu.id, "--clear-requires", "--owner", owner]);
    const lifted = JSON.parse(await asAgent(["issue", "claim", gpu.id, "--agent", name])) as {
      results: { leaseToken: string }[];
    };
    secrets.add(lifted.results[0]!.leaseToken);
    await asAgent(["issue", "release", gpu.id]);

    await gm(["agent", "revoke", other.agent.id]);
    await gm(["agent", "revoke", agent.id]);
    record({
      requirementsSkipped: picked.skipped.requirements,
      requirementsRefused: true,
      agent: name,
      model: capabilities.model,
      tags: capabilities.tags,
      selfRefreshPreservedDeclarations: true,
      trackerCapabilitiesVisible: true,
      claimIdentity: claimed.issue.claim.actorId,
    });
  });

  await scenario("tags-one-vocabulary-and-old-spellings", async () => {
    // CORE-271: issue tags from the tracker's tag catalog through the real gm and
    // API, with every old spelling kept: --label, `labels` in --data and the API,
    // and label: in search.
    const owner = fixtures.tracker.owner;
    const key = `T${randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase()}`;
    const suffix = randomUUID().slice(0, 6);
    const [ux, data] = [`ux-${suffix}`, `data-${suffix}`];
    await json(`/api/tracker/${owner}/mutate`, ownerToken, "POST", {
      operationId: randomUUID(),
      mutations: [{ kind: "team.create", id: randomUUID(), data: { key, name: "Tags" } }],
    });
    const create = async (title: string, flag: string, tag: string) =>
      JSON.parse(
        await gm(["issue", "create", title, "--team", key, flag, tag, "--owner", owner]),
      ) as { entities: { id: string; labels: string[] }[]; tagCatalog?: { added: string[] } };
    const tagged = await create("Tagged with --tag", "--tag", ux);
    assert.deepEqual(tagged.entities[0]!.labels, [ux]);
    assert.deepEqual(tagged.tagCatalog?.added, [ux]);
    const old = await create("Tagged with --label", "--label", data);
    assert.deepEqual(old.entities[0]!.labels, [data]);
    const id = old.entities[0]!.id;
    await gm(["issue", "update", id, "--tag", ux, "--owner", owner]);
    await gm([
      "issue",
      "update",
      id,
      "--data",
      JSON.stringify({ tags: [data, ux] }),
      "--owner",
      owner,
    ]);
    const shown = await gm(["issue", "show", id, "--owner", owner, "--output", "text"]);
    assert.match(shown, new RegExp(`Tags: ${data}, ${ux}\n`));
    // The API takes `tags` and still `labels`; the catalog lists both with counts.
    const snapshot = await json<{ issues: { id: string; version: number; labels: string[] }[] }>(
      `/api/tracker/${owner}/snapshot`,
      ownerToken,
    );
    const issue = snapshot.issues.find((i) => i.id === id)!;
    await json(`/api/tracker/${owner}/mutate`, ownerToken, "POST", {
      operationId: randomUUID(),
      mutations: [
        { kind: "issue.update", id, expectedVersion: issue.version, data: { labels: [data] } },
      ],
    });
    const catalog = await json<{ tags: { name: string; issues: number; open: number }[] }>(
      `/api/tracker/${owner}/tags`,
      ownerToken,
    );
    assert.deepEqual(
      catalog.tags.filter((t) => t.name.endsWith(suffix)),
      [
        { name: data, issues: 1, open: 1 },
        { name: ux, issues: 1, open: 1 },
      ],
    );
    const listed = JSON.parse(await gm(["issue", "tags", "--owner", owner])) as {
      tags: { name: string }[];
    };
    assert(listed.tags.some((t) => t.name === ux) && listed.tags.some((t) => t.name === data));
    // An unknown tag: requirement warns and is still saved.
    const required = JSON.parse(
      await gm(["issue", "update", id, "--requires", `tag:${ux}x`, "--owner", owner]),
    ) as { tagCatalog: { unknownRequired: { tag: string; suggestion: string | null }[] } };
    assert.deepEqual(required.tagCatalog.unknownRequired, [{ tag: `${ux}x`, suggestion: ux }]);
    record({ tags: [ux, data], aliases: ["--label", "labels", "tags"] });
  });

  await scenario("tightening-requirements-on-a-claimed-issue", async () => {
    // CORE-272: a real agent claims; a person tightens the requirements. gm says
    // who's affected and keeps the claim (recorded), --release-claim releases it,
    // --require-issue-tags turns tags into requirements, and next names what blocked it.
    const owner = fixtures.tracker.owner;
    const key = `Q${randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase()}`;
    const suffix = randomUUID().slice(0, 6);
    const [ux, gpu] = [`ux-${suffix}`, `gpu-${suffix}`];
    await json(`/api/tracker/${owner}/mutate`, ownerToken, "POST", {
      operationId: randomUUID(),
      mutations: [{ kind: "team.create", id: randomUUID(), data: { key, name: "Tighten" } }],
    });
    const { agent } = await json<{ agent: Agent }>(
      "/api/agents",
      ownerToken,
      "POST",
      { name: `tight-${suffix}` },
      [201],
    );
    await json(`/api/agents/${agent.id}/capabilities`, ownerToken, "PUT", {
      version: 1,
      harness: "claude-code",
      model: "fixture-model",
      environment: {
        os: "linux",
        arch: "x86_64",
        runtime: "host",
        cpuCount: 4,
        memoryBytes: 8 * 2 ** 30,
      },
      tags: [ux],
      skills: [],
    });
    const token = await json<CreatedAccessToken>(
      `/api/agents/${agent.id}/tokens`,
      ownerToken,
      "POST",
      { scope: "write" },
      [201],
    );
    secrets.add(token.secret);
    const agentEnv = { GM_TOKEN: token.secret };
    const created = JSON.parse(
      await gm([
        "issue",
        "create",
        "Tighten me",
        "--team",
        key,
        "--tag",
        ux,
        "--tag",
        gpu,
        "--requires",
        `tag:${ux}`,
        "--owner",
        owner,
      ]),
    ) as { entities: { id: string }[] };
    const id = created.entities[0]!.id;
    const claim = JSON.parse(
      await gm(
        ["issue", "claim", id, "--agent", "e2e-session", "--owner", owner],
        "marco",
        work,
        undefined,
        agentEnv,
      ),
    ) as { results: { leaseToken: string }[] };
    secrets.add(claim.results[0]!.leaseToken);

    type Effect = {
      claimEffect?: {
        agent: string;
        session: string;
        released: boolean;
        unmet: { wanted: string }[];
      };
    };
    // --require-issue-tags asks for tag:gpu-… too: the holder misses it, so the claim is kept and said.
    const kept = JSON.parse(
      await gm(["issue", "update", id, "--require-issue-tags", "--owner", owner]),
    ) as Effect;
    assert.equal(kept.claimEffect?.agent, agent.name);
    assert.equal(kept.claimEffect?.session, "e2e-session");
    assert.equal(kept.claimEffect?.released, false);
    assert.deepEqual(
      kept.claimEffect?.unmet.map((u) => u.wanted),
      [`tag:${gpu}`],
    );
    const text = await gm([
      "issue",
      "update",
      id,
      "--requires",
      `tag:${gpu} cpus>=64`,
      "--owner",
      owner,
      "--output",
      "text",
    ]);
    assert.match(
      text,
      new RegExp(`^Kept the claim held by ${agent.name} \\(session e2e-session\\)`),
    );
    // Releasing it: the claim ends, the work is back, and the issue records it.
    const released = JSON.parse(
      await gm([
        "issue",
        "update",
        id,
        "--requires",
        `tag:${gpu} memory>=1TiB`,
        "--release-claim",
        "--owner",
        owner,
      ]),
    ) as Effect;
    assert.equal(released.claimEffect?.released, true);
    const snapshot = await json<{
      issues: { id: string; claim: unknown; requires?: unknown; status: string }[];
      comments: { issueId: string; body: string }[];
    }>(`/api/tracker/${owner}/snapshot`, ownerToken);
    const issue = snapshot.issues.find((i) => i.id === id)!;
    assert.equal(issue.claim, null);
    assert.equal(issue.status, "todo");
    const notes = snapshot.comments.filter((c) => c.issueId === id).map((c) => c.body);
    assert(notes.some((n) => n.startsWith(`Kept the claim held by ${agent.name}`)));
    assert(notes.some((n) => n.startsWith(`Released the claim held by ${agent.name}`)));
    // next passes it over and says what kept it.
    const next = JSON.parse(
      await gm(
        ["issue", "next", "--team", key, "--agent", "e2e-session", "--owner", owner],
        "marco",
        work,
        undefined,
        agentEnv,
      ),
    ) as {
      claimed: unknown;
      skipped: { blocking: { wanted: string; issues: number }[] };
      message: string;
    };
    assert.equal(next.claimed, null, "next must pass over the released issue");
    assert(next.skipped.blocking.some((b) => b.wanted === `tag:${gpu}` && b.issues === 1));
    assert.match(next.message, new RegExp(`gm agent setup --tag ${gpu}`));
    await gm(["agent", "revoke", agent.id]);
    record({ agent: agent.name, kept: true, released: true, blocking: next.skipped.blocking });
  });

  await scenario("agent-durable-interventions-and-resume", async () => {
    const owner = fixtures.tracker.owner;
    const directory = join(work, "autonomous-agent");
    await mkdir(join(directory, ".gitmatrix"), { recursive: true, mode: 0o700 });
    const { agent } = await json<{ agent: Agent }>(
      "/api/agents",
      ownerToken,
      "POST",
      { name: `autonomy-${randomUUID().slice(0, 8)}` },
      [201],
    );
    const token = await json<CreatedAccessToken>(
      `/api/agents/${agent.id}/tokens`,
      ownerToken,
      "POST",
      { scope: "write" },
      [201],
    );
    secrets.add(token.secret);
    const run = (args: string[]) =>
      gm(args, "marco", directory, undefined, { GM_TOKEN: token.secret });
    await run([
      "agent",
      "setup",
      "--no-identity",
      "--harness",
      "codex",
      "--owner",
      owner,
      "--team",
      "AUTO",
      "--intervention",
      "autonomous",
    ]);
    const team = randomUUID(),
      waiting = randomUUID(),
      independent = randomUUID(),
      dependent = randomUUID();
    await json(`/api/tracker/${owner}/mutate`, ownerToken, "POST", {
      operationId: randomUUID(),
      mutations: [
        { kind: "team.create", id: team, data: { key: "AUTO", name: "Autonomy regression" } },
        {
          kind: "issue.create",
          id: waiting,
          data: { teamId: team, title: "Needs owner input", priority: 0 },
        },
        {
          kind: "issue.create",
          id: independent,
          data: { teamId: team, title: "Independent scoped work", priority: 1 },
        },
        {
          kind: "issue.create",
          id: dependent,
          data: { teamId: team, title: "Dependent scoped work", priority: 2 },
        },
        {
          kind: "link.add",
          id: randomUUID(),
          data: { fromId: waiting, toId: dependent, kind: "blocks" },
        },
      ],
    });
    type Pick = {
      claimed: { issueId: string; leaseToken: string } | null;
      intervention: { mode: string };
    };
    type Requests = {
      requests: {
        id: string;
        kind: string;
        askedBy: string;
        routeTo: string;
        status: string;
        answer: string | null;
      }[];
    };
    const first = JSON.parse(await run(["issue", "next"])) as Pick;
    assert.equal(first.claimed?.issueId, waiting);
    assert.equal(first.intervention.mode, "autonomous");
    secrets.add(first.claimed!.leaseToken);
    const leaseDirectory = join(
      ctx.env.XDG_DATA_HOME!,
      "gitmatrix",
      "leases",
      createHash("sha256").update(ctx.origin).digest("hex"),
    );
    const parkedPath = join(leaseDirectory, `${waiting}.json`);
    const expiredPath = join(leaseDirectory, `expired-control-${randomUUID()}.json`);
    const kept = JSON.parse(await readFile(parkedPath, "utf8")) as {
      token: string;
      identity: unknown;
      issue: string;
      expires_at: string | null;
    };
    // Model a long-expired local deadline without waiting a day or changing the
    // server clock. An acknowledged park must remove that deadline before pruning.
    kept.expires_at = "2000-01-01T00:00:00Z";
    await writeFile(parkedPath, JSON.stringify(kept), { mode: 0o600 });
    await writeFile(
      expiredPath,
      JSON.stringify({ ...kept, token: "expired-control", issue: "EXPIRED-CONTROL" }),
      { mode: 0o600 },
    );
    await gm(
      [
        "issue",
        "ask",
        waiting,
        "--kind",
        "decision",
        "--prompt",
        "Invalid choice set",
        "--choice",
        "only",
      ],
      "marco",
      directory,
      /at least two choices/i,
      { GM_TOKEN: token.secret },
    );
    await run([
      "issue",
      "ask",
      waiting,
      "--kind",
      "question",
      "--prompt",
      "Preview only",
      "--dry-run",
    ]);
    assert.equal(
      JSON.parse(await readFile(parkedPath, "utf8")).expires_at,
      kept.expires_at,
      "Rejected and dry-run asks must not change the kept lease deadline",
    );
    await run([
      "issue",
      "ask",
      waiting,
      "--kind",
      "decision",
      "--prompt",
      "Which region?",
      "--choice",
      "EU",
      "--choice",
      "US",
    ]);
    await run([
      "issue",
      "ask",
      waiting,
      "--kind",
      "question",
      "--prompt",
      "Blocked by DNS ownership; please confirm the record is enabled.",
    ]);
    await run(["auth", "status"]);
    const parked = JSON.parse(await readFile(parkedPath, "utf8"));
    assert.equal(parked.token, kept.token);
    assert.deepEqual(parked.identity, kept.identity);
    assert.equal(parked.expires_at, null);
    await assert.rejects(stat(expiredPath), { code: "ENOENT" });
    const open = JSON.parse(await run(["request", "list", "--issue", waiting])) as Requests;
    assert.equal(open.requests.length, 2);
    assert(
      open.requests.every(
        (request) => request.askedBy === agent.id && request.routeTo === "acc_marco",
      ),
    );
    const decision = open.requests.find((request) => request.kind === "decision")!;
    const question = open.requests.find((request) => request.kind === "question")!;
    const next = JSON.parse(await run(["issue", "next"])) as Pick;
    assert.equal(next.claimed?.issueId, independent);
    secrets.add(next.claimed!.leaseToken);
    await run([
      "issue",
      "complete",
      independent,
      "--evidence",
      "Completed independent fixture while owner input was pending.",
    ]);
    assert.equal((JSON.parse(await run(["issue", "next"])) as Pick).claimed, null);
    await gm(["request", "answer", decision.id, "--choice", "EU", "--owner", owner]);
    const partial = JSON.parse(
      await run(["request", "list", "--issue", waiting, "--status", "answered"]),
    ) as Requests;
    assert.deepEqual(
      partial.requests.map((request) => [request.id, request.answer]),
      [[decision.id, "EU"]],
    );
    await gm(["issue", "resume", waiting], "marco", directory, /request|waiting|answer/i, {
      GM_TOKEN: token.secret,
    });
    await gm(["request", "answer", question.id, "--answer", "DNS enabled", "--owner", owner]);
    const resolved = JSON.parse(
      await run(["request", "list", "--issue", waiting, "--status", "all"]),
    ) as Requests;
    assert.equal(resolved.requests.length, 2);
    assert(resolved.requests.every((request) => request.status === "answered"));
    assert.equal(
      resolved.requests.find((request) => request.id === question.id)?.answer,
      "DNS enabled",
    );
    assert.equal(
      (
        JSON.parse(
          await run(["request", "list", "--issue", independent, "--status", "all"]),
        ) as Requests
      ).requests.length,
      0,
    );
    const resumed = JSON.parse(await run(["issue", "resume", waiting])) as {
      results: { leaseToken: string }[];
    };
    secrets.add(resumed.results[0]!.leaseToken);
    const active = JSON.parse(await readFile(parkedPath, "utf8"));
    assert.equal(active.token, resumed.results[0]!.leaseToken);
    assert.notEqual(active.token, kept.token);
    assert.deepEqual(active.identity, kept.identity);
    assert(Date.parse(active.expires_at) > Date.now(), "Resume restores a finite active deadline");
    await run(["auth", "status"]);
    assert.equal(JSON.parse(await readFile(parkedPath, "utf8")).token, active.token);
    await run([
      "issue",
      "complete",
      waiting,
      "--evidence",
      "Read both owner answers and resumed the parked lease.",
    ]);
    await assert.rejects(stat(parkedPath), { code: "ENOENT" });
    await run(["agent", "setup", "--no-identity", "--intervention", "harness"]);
    const last = JSON.parse(await run(["issue", "next"])) as Pick;
    assert.equal(last.claimed?.issueId, dependent);
    assert.equal(last.intervention.mode, "harness");
    secrets.add(last.claimed!.leaseToken);
    await run([
      "issue",
      "complete",
      dependent,
      "--evidence",
      "Dependency became ready after its prerequisite completed.",
    ]);
    await gm(["agent", "revoke", agent.id]);
    record({
      accountableHuman: "acc_marco",
      independentWorkContinued: true,
      partialAnswerKeptLeaseParked: true,
      answersReadableByIssue: true,
      resumedAfterAllAnswers: true,
      parkedTokenSurvivedExpiryPruning: true,
      expiredControlWasPruned: true,
      resumeRestoredFiniteExpiry: true,
      dependentWorkStayedBlocked: true,
      harnessOverrideApplied: true,
    });
  });

  await scenario("tracker-handoff-to-an-agent-created-after-sync", async () => {
    // marco's replica predates this agent: the handoff must still find it by name.
    const owner = fixtures.tracker.owner;
    const issue = fixtures.tracker.blocker;
    await gm(["tracker", "sync", "--owner", owner], "marco");
    const name = `late-${randomUUID().slice(0, 8)}`;
    const { agent } = await json<{ agent: Agent }>(
      "/api/agents",
      ownerToken,
      "POST",
      { name },
      [201],
    );
    const token = await json<CreatedAccessToken>(
      `/api/agents/${agent.id}/tokens`,
      ownerToken,
      "POST",
      { scope: "write" },
      [201],
    );
    secrets.add(token.secret);
    const claimed = JSON.parse(
      await gm(["issue", "claim", issue, "--owner", owner, "--agent", "e2e-handoff"], "marco"),
    ) as { results: { leaseToken: string }[] };
    const lease = claimed.results[0]?.leaseToken;
    assert(lease, "Claim must return a fencing token");
    secrets.add(lease);
    const offered = JSON.parse(
      await gm(
        ["issue", "handoff", issue, "--owner", owner, "--to", name],
        "marco",
        work,
        undefined,
        {
          GM_LEASE_TOKEN: lease,
        },
      ),
    ) as { results: { offerCode: string }[] };
    const code = offered.results[0]?.offerCode;
    assert(code, "Handoff must return a single-use code");
    secrets.add(code);
    const accepted = JSON.parse(
      await gm(["issue", "accept", code, "--owner", owner], "marco", work, undefined, {
        GM_TOKEN: token.secret,
      }),
    ) as { results: { leaseToken: string }[] };
    const handed = accepted.results[0]?.leaseToken;
    assert(handed, "Accepting must return the agent's fencing token");
    secrets.add(handed);
    const shown = JSON.parse(
      await gm(["issue", "show", issue, "--owner", owner], "marco", work, undefined, {
        GM_TOKEN: token.secret,
      }),
    ) as { issue: { claim: { actorId: string } } };
    assert.equal(shown.issue.claim.actorId, agent.id, "The agent now holds the lease");
    await gm(["issue", "release", issue, "--owner", owner], "marco", work, undefined, {
      GM_TOKEN: token.secret,
      GM_LEASE_TOKEN: handed,
    });
    await gm(["agent", "revoke", agent.id]);
    record({ agent: name, holder: shown.issue.claim.actorId });
  });

  await scenario("package-upload-download-and-write-boundary", async () => {
    const file = join(work, "artifact.txt");
    await writeFile(file, bytes);
    await gm(["pkg", "upload", file, `${packageName}/1.0.0/artifact.txt`, "--owner", repo.owner]);
    assert.equal(
      await request(`/generic/${repo.owner}/${packageName}/1.0.0/artifact.txt`, ownerToken),
      bytes,
    );
    const downloaded = join(work, "downloaded-artifact.txt");
    await gm([
      "pkg",
      "download",
      `${packageName}/latest/artifact.txt`,
      "--owner",
      repo.owner,
      "--dest",
      downloaded,
    ]);
    assert.deepEqual(await readFile(downloaded), Buffer.from(bytes));
    record({
      downloaded,
      version: "1.0.0",
      sha256: createHash("sha256")
        .update(await readFile(downloaded))
        .digest("hex"),
      exactBytes: true,
    });

    const executableName = `${packageName}-executable`;
    const platform = `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch}`;
    const executableFile = join(work, "executable-fixture");
    const binDir = join(work, "installed-bin");
    const installed = join(binDir, executableName);
    const payload = (version: string) =>
      `#!/bin/sh\nprintf '%s\\n' '${executableName} ${version}'\n`;
    const installArgs = [
      "pkg",
      "install",
      executableName,
      "--owner",
      repo.owner,
      "--bin-dir",
      binDir,
    ];
    const execute = promisify(execFile);
    async function checkInstalled(version: string) {
      const content = await readFile(installed);
      assert.deepEqual(content, Buffer.from(payload(version)));
      const mode = (await stat(installed)).mode & 0o777;
      assert.equal(mode, 0o755);
      const { stdout, stderr } = await execute(installed, [], {
        cwd: work,
        env: ctx.env,
        timeout: 10_000,
      });
      assert.equal(stdout, `${executableName} ${version}\n`);
      assert.equal(stderr, "");
      record({
        installed,
        platform,
        version,
        mode: mode.toString(8),
        sha256: createHash("sha256").update(content).digest("hex"),
        stdout,
      });
    }
    await writeFile(executableFile, payload("1.0.0"));
    await gm([
      "pkg",
      "upload",
      executableFile,
      `${executableName}/1.0.0/${platform}/${executableName}`,
      "--owner",
      repo.owner,
    ]);
    await gm([...installArgs, "--dry-run"]);
    await assert.rejects(stat(binDir), { code: "ENOENT" });
    record({ dryRun: true, binDirectoryCreated: false });
    await gm([...installArgs, "--version", "1.0.0"]);
    await checkInstalled("1.0.0");

    await writeFile(executableFile, payload("2.0.0"));
    await gm([
      "pkg",
      "upload",
      executableFile,
      `${executableName}/2.0.0/${platform}/${executableName}`,
      "--owner",
      repo.owner,
    ]);
    await gm(installArgs, "marco", work, /exist|overwrite|force/i);
    await checkInstalled("1.0.0");
    await gm([...installArgs, "--force"]);
    await checkInstalled("2.0.0");
    await gm(
      [...installArgs, "--version", "99.0.0", "--force"],
      "marco",
      work,
      /404|not.found|missing/i,
    );
    await checkInstalled("2.0.0");
    record({ rejectedOverwritePreserved: "1.0.0", missingVersionPreserved: "2.0.0" });
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

  await scenario("ci-job-records-and-updates-a-deployment", async () => {
    // The job runs this environment's gm, never a globally installed one.
    const number = await pushPipeline(
      {
        deploy: {
          env: { AGENT_GM: ctx.gm },
          steps: [
            {
              run: '"$AGENT_GM" deploy record --url "https://agent-e2e.example.com/run-$GITMATRIX_RUN_NUMBER" --environment staging --expires 2d',
            },
          ],
        },
      },
      "agent-ci-deploy",
    );
    const run = await poll(() => runDetail(number), terminal, "deploying run");
    assert.equal(run.status, "succeeded");
    const listed = await json<DeploymentList>(`${api}/deployments?run=${number}`, ownerToken);
    assert.equal(listed.deployments.length, 1, "The job records exactly one deployment");
    const deployment = listed.deployments[0]!;
    assert.equal(deployment.environment, "staging");
    assert.equal(deployment.url, `https://agent-e2e.example.com/run-${number}`);
    assert.equal(deployment.status, "active");
    assert.equal(deployment.run, number);
    assert.equal(deployment.job, "deploy");
    assert.equal(deployment.commit, run.commit);
    assert(deployment.expiresAt, "--expires sets the expiry");
    record({ deployment });

    // Outside CI: a person records for an explicit commit, and marks the
    // preview expired; the record stays.
    const recorded = JSON.parse(
      await gm([
        "deploy",
        "record",
        "--url",
        "https://agent-e2e.example.com/preview",
        "--timeline",
        "agent-e2e",
        "--commit",
        run.commit,
        "-R",
        fullName,
      ]),
    ) as Deployment;
    assert.equal(recorded.environment, "timeline/agent-e2e");
    assert.equal(recorded.run, null);
    await gm(["deploy", "update", String(recorded.id), "--status", "expired", "-R", fullName]);
    const kept = await json<Deployment>(`${api}/deployments/${recorded.id}`, ownerToken);
    assert.equal(kept.status, "expired");
    assert.equal(kept.url, "https://agent-e2e.example.com/preview");
    await gm(
      [
        "deploy",
        "record",
        "--url",
        "https://x.example.com",
        "--commit",
        run.commit,
        "-R",
        fullName,
      ],
      "read",
      work,
      /403|read.only|write access/i,
    );
    record({ recorded: kept });
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
        // Cancelling the run precedes the runner's durable shutdown acknowledgement.
        const run = await poll(
          () => runDetail(number),
          (run) =>
            terminal(run) && run.jobs.every((job) => !["queued", "running"].includes(job.status)),
          `job token ${expected} shutdown acknowledgement`,
        );
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

  await scenario("ci-retention-removes-logs-and-runs", async () => {
    // CORE-200, in the real runtime: two finished runs on one branch, moved
    // 40 days back; a manual dry run then run of "ci-logs" removes their log
    // text (the run page, the logs API and `gm runs` say so), then "ci-runs"
    // keeping one run per ref removes the older run (its page says it was
    // removed by retention) and keeps the latest.
    const branch = `agent-ci-retention-${randomUUID().slice(0, 6)}`;
    const jobs = { say: { steps: [{ run: "printf 'retention marker\\n'" }] } };
    const older = await pushPipeline(jobs, branch);
    await poll(() => runDetail(older), terminal, "older retention run");
    const newer = (
      await json<{ number: number }>(`${api}/ci/runs`, ownerToken, "POST", { ref: branch }, [201])
    ).number;
    const latest = await poll(() => runDetail(newer), terminal, "newer retention run");
    assert.equal(latest.status, "succeeded");
    await json("/api/dev/ci-age", ctx.env.GITMATRIX_AGENT_SECRET ?? "", "POST", {
      owner: repo.owner,
      name: repo.name,
      numbers: [older, newer],
      days: 40,
    });
    const runs = `/api/accounts/${repo.owner}/retention/runs`;
    interface Run {
      id: number;
      status: string;
      dryRun: boolean;
      items: number;
      bytes: number;
      categories: { category: string; status: string; items: number; error: string | null }[];
    }
    const retention = async (dryRun: boolean, category: string, thresholds: object) => {
      const started = await json<Run>(
        runs,
        ownerToken,
        "POST",
        { dryRun, categories: [category], thresholds: { [category]: thresholds } },
        [202],
      );
      const done = await poll(
        () => json<Run>(`${runs}/${started.id}`, ownerToken),
        (r) => r.status !== "queued" && r.status !== "running",
        `retention run ${started.id}`,
      );
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      return done;
    };
    const dry = await retention(true, "ci-logs", { days: 30 });
    assert(dry.items >= 2 && dry.bytes > 0, `the dry run lists both jobs' logs: ${dry.items}`);
    const removed = await retention(false, "ci-logs", { days: 30 });
    assert.equal(removed.items, dry.items, "the run removes what the dry run listed");
    assert.equal(removed.bytes, dry.bytes);
    for (const number of [older, newer]) {
      const run = await json<CiRunDetail>(`${api}/ci/runs/${number}`, ownerToken);
      const job = run.jobs[0]!;
      assert(job.logsRemovedAt, `run #${number}: the job records the removal`);
      const logs = await json<CiLogs>(`${api}/ci/jobs/${job.id}/logs`, ownerToken);
      assert.deepEqual([logs.chunks, logs.done, logs.removedAt], [[], true, job.logsRemovedAt]);
    }
    const cliLogs = JSON.parse(await gm(["runs", "logs", String(newer), "-R", fullName])) as {
      jobs: { log: string; logsRemovedAt?: string }[];
    };
    assert(cliLogs.jobs[0]?.logsRemovedAt, "gm runs logs reports the removal");
    assert.equal((await retention(false, "ci-logs", { days: 30 })).items, 0, "idempotent");

    const pruned = await retention(false, "ci-runs", { days: 30, keepLatest: 1 });
    assert(pruned.items >= 1, "the older run goes");
    const gone = await request(`${api}/ci/runs/${older}`, ownerToken, "GET", undefined, [404]);
    assert.match(gone, new RegExp(`Run #${older} was removed by retention`));
    await gm(
      ["runs", "show", String(older), "-R", fullName],
      "marco",
      work,
      /removed by retention/,
    );
    assert.equal((await json<CiRunDetail>(`${api}/ci/runs/${newer}`, ownerToken)).number, newer);
    record({ older, newer, dry, removed, pruned });

    const browserTimeout = 15_000;
    const expect = playwrightExpect.configure({ timeout: browserTimeout });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: ctx.origin });
    const page = await context.newPage();
    page.setDefaultTimeout(browserTimeout);
    try {
      await page.goto("/signin");
      await page.getByRole("button", { name: /Continue as marco/i }).click();
      await page.waitForURL((url) => url.pathname !== "/signin");
      await page.goto(`/${fullName}/ci/${newer}`);
      await expect(page.getByText(/Logs removed by retention on /)).toBeVisible();
      await expect(page.getByText("Output removed by retention.").first()).toBeAttached();
      await page.screenshot({ path: join(ctx.artifacts, "ci-retention-run.png"), fullPage: true });
      await page.goto(`/${fullName}/ci/${older}`);
      await expect(page.getByText(`Run #${older} was removed by retention.`)).toBeVisible();
      record({ browser: { logsRemovedShown: true, removedRunShown: true } });
    } catch (error) {
      await page
        .screenshot({ path: join(ctx.artifacts, "ci-retention-failure.png"), fullPage: true })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
      await browser.close();
    }
  });

  // Real runner gates evaluate a one-parent compact candidate before canonical CAS.
  const timelinesApi = `/api/tracker/${fixtures.tracker.owner}/timelines`;
  const mutateTracker = (token: string, mutations: unknown[], timeline?: string) =>
    json<{ results: { leaseToken?: string }[] }>(
      `/api/tracker/${fixtures.tracker.owner}/mutate`,
      token,
      "POST",
      { operationId: randomUUID(), mutations, ...(timeline ? { timeline } : {}) },
    );
  const trackerIssue = async (id: string) =>
    (
      await json<Snapshot>(`/api/tracker/${fixtures.tracker.owner}/snapshot`, fixtures.tokens.jun)
    ).issues.find((issue) => issue.id === id);
  const branchTip = async (name: string) =>
    (await json<RepoDetail>(api, ownerToken)).branches.find((b) => b.shortName === name)?.oid;
  type LandingRecord = Landing;
  /** Wait for a landing to stop working; its runs' logs go into the evidence on a stop. */
  async function settledLanding(slug: string): Promise<LandingRecord> {
    const landing = await poll(
      async () =>
        (
          await json<{ landing: LandingRecord | null }>(
            `${timelinesApi}/${slug}/landing`,
            ownerToken,
          )
        ).landing,
      (value) =>
        !!value && ["landed", "conflict", "failed", "blocked_dependency"].includes(value.state),
      `timeline ${slug} to land or stop`,
      300_000,
    );
    record({ landing });
    if (landing!.state !== "landed")
      for (const repo of landing!.repos)
        for (const run of [repo.mergeRun, repo.gateRun])
          if (run?.number) await runDetail(run.number);
    return landing!;
  }
  /** Start an auto timeline in a fresh clone bound to it. */
  async function landingTimeline(slug: string) {
    const clone = join(work, `landing-${slug}`);
    await gm(["clone", fullName, clone], "jun");
    await gm(
      ["timeline", "start", slug, "--owner", fixtures.tracker.owner, "--policy", "auto"],
      "jun",
      clone,
    );
    return clone;
  }
  /** Push owned work, then checkpoint it: an auto timeline queues itself. */
  async function pushAndCheckpoint(clone: string, slug: string, message: string) {
    const before = await sourceTip(slug);
    await gm(["commit", "-m", message], "jun", clone);
    await gm(["push"], "jun", clone);
    await poll(
      () => sourceTip(slug),
      (tip) => !!tip && tip !== before,
      "the pushed owned work source",
    );
    const checkpoint = JSON.parse(
      await gm(
        ["timeline", "checkpoint", "-m", message, "--owner", fixtures.tracker.owner],
        "jun",
        clone,
      ),
    ) as { checkpoint: Checkpoint };
    return checkpoint.checkpoint;
  }

  await scenario("timeline-compact-landing-gates-receipt-and-native-source", async () => {
    const slug = `land-e2e-${randomUUID().slice(0, 8)}`;
    const marker = `landing-e2e/${slug}.txt`;
    const clone = await landingTimeline(slug);
    const mainBefore = await branchTip("main");
    assert(mainBefore, "main must exist");

    // An issue done in the timeline: done there, its lease retained (CORE-75).
    const issueId = randomUUID();
    await mutateTracker(fixtures.tokens.jun, [
      {
        kind: "issue.create",
        id: issueId,
        data: { teamId: fixtures.tracker.team, title: `Land ${slug}` },
      },
    ]);
    const claimed = await mutateTracker(
      fixtures.tokens.jun,
      [{ kind: "issue.claim", id: issueId, data: { agent: "landing-e2e" } }],
      slug,
    );
    const lease = claimed.results[0]?.leaseToken;
    assert(lease, "Claim must return a lease token");
    secrets.add(lease);
    await mutateTracker(
      fixtures.tokens.jun,
      [{ kind: "issue.complete", id: issueId, data: { leaseToken: lease, evidence: "Landed" } }],
      slug,
    );
    const doneInTimeline = await trackerIssue(issueId);
    assert.equal(doneInTimeline?.status, "done_in_timeline");
    assert.equal(doneInTimeline?.claim?.retainedIn?.slug, slug, "Finishing retains the lease");

    // The gates check the compact candidate, not a merge with the WIP graph.
    await mkdir(join(clone, "landing-e2e"), { recursive: true });
    await writeFile(join(clone, marker), `${slug} in progress\n`);
    await gm(["commit", "-m", `Uncheckpointed progress ${slug}`], "jun", clone);
    await gm(["push"], "jun", clone);
    const progressCommit = await sourceTip(slug);
    assert(progressCommit && progressCommit !== mainBefore);
    await writeFile(join(clone, marker), `${slug}\n`);
    await mkdir(join(clone, ".gitmatrix"), { recursive: true });
    await writeFile(
      join(clone, ".gitmatrix", "ci.yml"),
      JSON.stringify({
        on: { push: { branches: ["never-agent-auto"] }, preview: {} },
        jobs: {
          gate: {
            if: 'trigger == "landing"',
            steps: [
              {
                run: `test -f ${marker} && test "$(git log -1 --format=%P | wc -w)" = 1 && echo LANDING_GATE_OK`,
              },
            ],
          },
          preview: {
            if: 'trigger == "preview" && action == "create"',
            steps: [
              {
                run: `test -f ${marker} && test "$(git rev-parse HEAD)" = "$GITMATRIX_COMMIT" && case "$GITMATRIX_SOURCE_ID" in work_*) echo SOURCE_PREVIEW_OK;; *) exit 1;; esac`,
              },
            ],
          },
        },
      }),
    );
    const checkpoint = await pushAndCheckpoint(clone, slug, `Landing E2E ${slug}`);
    const checkpointCommit = checkpoint.repos[0]!.commit;
    // Auto landing waits for this checkpoint's preview CI to become green.
    const landing = await settledLanding(slug);
    assert.equal(landing.checkpointId, checkpoint.id);
    assert.equal(landing.state, "landed", `Landing stopped: ${landing.reason}`);
    const [landed] = landing.repos;
    assert(landed?.gateRun?.number, "The gates ran on the compact candidate");
    const gates = await runDetail(landed.gateRun.number);
    assert.equal(gates.status, "succeeded");
    assert.equal(gates.ref, `gitmatrix/landing/${slug}`);
    assert.equal(gates.trigger, "landing", "Landing runs report their trigger");

    // Main advances by one single-parent commit; source progress stays outside canonical.
    const mainAfter = await branchTip("main");
    assert.equal(mainAfter, landed.merge);
    const [merge] = (
      await json<{ commits: { oid: string; parents: string[] }[] }>(
        `${api}/commits?ref=${mainAfter}`,
        ownerToken,
      )
    ).commits;
    assert.equal(merge?.oid, mainAfter);
    assert.deepEqual(
      merge?.parents,
      [mainBefore],
      "Compact landing has only the previous canonical main as parent",
    );
    const source = await timelineSource(slug);
    assert.equal(checkpoint.repos[0]?.source?.sourceId, source.sourceId);
    const lineage = await json<{
      status: string;
      integration: {
        source: SourceSnapshot;
        canonical: SourceSnapshot;
        logicalBase: SourceSnapshot;
      } | null;
      members: string[];
    }>(`${api}/sources/${source.sourceId}/lineage?commit=${checkpointCommit}`, ownerToken);
    assert.equal(lineage.status, "integrated");
    assert.equal(lineage.integration?.source.commit, checkpointCommit);
    assert.equal(lineage.integration?.canonical.commit, mainAfter);
    assert.equal(lineage.integration?.logicalBase.commit, mainBefore);
    assert.deepEqual(lineage.members, [checkpointCommit]);
    const sourceRemote = `${ctx.origin}/${fullName}@${slug}.git`;
    const sourceMirror = join(work, `${slug}-source.git`);
    const canonicalMirror = join(work, `${slug}-canonical.git`);
    await nativeGit(["clone", "--mirror", sourceRemote, sourceMirror]);
    await nativeGit(["clone", "--mirror", `${ctx.origin}/${fullName}.git`, canonicalMirror]);
    assert.equal(await nativeGit(["rev-parse", "refs/heads/work"], sourceMirror), checkpointCommit);
    assert.equal(await nativeGit(["show", `${checkpointCommit}:${marker}`], sourceMirror), slug);
    assert.equal(await nativeGit(["show", `${mainAfter}:${marker}`], canonicalMirror), slug);
    const canonicalObjects = (
      await nativeGit(
        ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
        canonicalMirror,
      )
    ).split("\n");
    assert(
      !canonicalObjects.includes(checkpointCommit),
      "Canonical Git contains no source WIP commit object",
    );
    const sourceProgress = (
      await nativeGit(["rev-list", checkpointCommit, `^${mainBefore}`], sourceMirror)
    ).split("\n");
    assert(sourceProgress.includes(progressCommit), "The work repository retains earlier progress");
    for (const oid of sourceProgress) {
      assert(!canonicalObjects.includes(oid), `Canonical Git excludes progress commit ${oid}`);
      await request(`${api}/commits?ref=${oid}`, ownerToken, "GET", undefined, [404]);
      const readable = await json<{ commits: { oid: string }[] }>(
        `${api}/commits?ref=${oid}&source=${source.sourceId}`,
        ownerToken,
      );
      assert.equal(
        readable.commits[0]?.oid,
        oid,
        "Source-qualified history retains exact progress",
      );
    }
    await assert.rejects(
      nativeGit(
        ["push", sourceRemote, "refs/heads/work:refs/heads/archive-write-probe"],
        sourceMirror,
      ),
      /read.only|archiv|ended|denied|403/i,
      "Archived source rejects native Git writes",
    );
    record({ source, lineage, canonicalSourceObjectAbsent: true, nativeArchiveReadable: true });

    const timeline = await json<{ timeline: { status: string; endedAt?: string } }>(
      `${timelinesApi}/${slug}`,
      ownerToken,
    );
    assert.equal(timeline.timeline.status, "landed");
    assert(timeline.timeline.endedAt, "A landed timeline records when it ended");
    const doneOnMain = await trackerIssue(issueId);
    assert.equal(doneOnMain?.status, "done", "The issue done in the timeline is done on main");
    assert.equal(doneOnMain?.claim, null, "Landing releases the retained lease");
    assert.equal(
      await sourceTip(slug),
      checkpointCommit,
      "The landed source is archived read-only",
    );
    assert.equal(await branchTip(`timeline/${slug}`), undefined);
    await poll(
      () => branchTip(`gitmatrix/landing/${slug}`),
      (tip) => tip === undefined,
      "the compact landing staging branch to go",
    );
    const revived = await json<{ runs: { number?: number; skipped?: string }[] }>(
      `${timelinesApi}/${slug}/checkpoints/${checkpoint.number}/revive`,
      fixtures.tokens.jun,
      "POST",
      {},
      [201],
    );
    assert.equal(revived.runs.length, 1);
    const revivedNumber = revived.runs[0]?.number;
    assert(revivedNumber, `Archived preview revival must start: ${JSON.stringify(revived.runs)}`);
    const revivedRun = await poll(
      () => runDetail(revivedNumber),
      terminal,
      "archived work preview revival",
    );
    assert.equal(revivedRun.status, "succeeded");
    assert.equal(revivedRun.commit, checkpointCommit);
    assert.equal(revivedRun.trigger, "preview");
    assert.equal(revivedRun.sourceId, source.sourceId);
    assert.equal(await sourceTip(slug), checkpointCommit, "Revival cannot mutate the archive");
    record({ archivedPreviewRevival: revivedNumber, sourceId: source.sourceId });
    const retention = await json<{
      run: { status: string; categories: { error: string | null }[] };
    }>("/api/dev/retention", ctx.env.GITMATRIX_AGENT_SECRET ?? "", "POST", {
      account: fixtures.tracker.owner,
      categories: { "tracker-activity": { eventDays: 365, endedTimelineDays: 180 } },
      daysAhead: 179,
      dryRun: false,
    });
    assert.equal(retention.run.status, "succeeded");
    assert(retention.run.categories.every((category) => category.error === null));
    assert.equal(
      await sourceTip(slug),
      checkpointCommit,
      "Archive survives before endedTimelineDays",
    );
    assert.equal(
      await nativeGit(["ls-remote", sourceRemote, "refs/heads/work"]),
      `${checkpointCommit}\trefs/heads/work`,
    );
    record({ archiveRetentionBeforeDeadline: retention.run });
    await gm(["timeline", "land", slug, "--owner", fixtures.tracker.owner], "jun", clone, /landed/);
    // Landing completion precedes the asynchronous push log's change index.
    // Wait for that input, then assert the authoritative queue provenance below.
    const why = await poll(
      async () => JSON.parse(await gm(["why", `${marker}:1`], "jun", clone)) as WhyResponse,
      (result) =>
        result.chains.some(
          (chain) =>
            chain.oid === checkpointCommit && chain.refs.some((ref) => ref.kind === "main"),
        ),
      "the landed change's main ref to be indexed",
    );
    record({ why, checkpoint });
    const provenance = why.chains.find((chain) => chain.oid === checkpointCommit)?.landing;
    assert.equal(provenance?.via, "compact", "gm why reads exact compact integration provenance");
    assert.equal(provenance.timeline, slug);
    assert.equal(provenance.commit, mainAfter);
    assert.equal(
      provenance.update,
      null,
      "Compact provenance comes from the integration receipt, not a work push",
    );
    assert.equal(provenance.queue?.id, landing.id);
    assert.equal(provenance.queue.checkpointId, checkpoint.id);
    assert.equal(provenance.queue.checkpointNumber, checkpoint.number);
    assert.deepEqual(provenance.queue.requestedBy, {
      actorId: "acc_jun",
      accountableId: "acc_jun",
      agentId: null,
    });
    assert.equal(provenance.queue.mergeRun?.number, landed.mergeRun?.number);
    assert.equal(provenance.queue.gateRun?.number, gates.number);
    const readerWhy = await json<WhyResponse>(
      `${api}/why?commit=${checkpointCommit}&source=${source.sourceId}`,
      fixtures.tokens.sam,
    );
    assert.equal(readerWhy.tracker.readable, false);
    const restricted = readerWhy.chains.find((chain) => chain.oid === checkpointCommit);
    assert(restricted);
    assert.equal(restricted.landing, null, "A work commit cannot imply a canonical push");
    assert.deepEqual(restricted.checkpoints, [], "Tracker-private checkpoint context is omitted");
    assert.equal(restricted.approval, null);
    record({ whyLanding: provenance, trackerRestricted: true });
    await writeFile(join(clone, "late-local.txt"), "Preserve unpushed local work after landing.\n");
    await gm(["commit", "-m", "Late local suffix"], "jun", clone);
    await gm(["push"], "jun", clone, /timeline_ended/);
    await gm(["sync"], "jun", clone);
    assert.equal(
      await readFile(join(clone, "late-local.txt"), "utf8"),
      "Preserve unpushed local work after landing.\n",
    );
    await gm(["push"], "jun", clone, /timeline_ended/);
    await gm(["timeline", "use", "main", "--owner", fixtures.tracker.owner], "jun", clone);
    record({
      timeline: slug,
      mainBefore,
      merge: mainAfter,
      checkpoint: checkpointCommit,
      gates: gates.number,
    });
  });

  /** gm with a harness event on stdin, as Claude Code runs its hook (CORE-241). */
  async function gmHook(clone: string, prompt: string) {
    const env: NodeJS.ProcessEnv = {
      ...ctx.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const child = execFile(
      ctx.gm,
      ["hook", "claude-code"],
      { cwd: clone, env, timeout: 30_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin!.end(
      JSON.stringify({
        session_id: "steps-e2e",
        hook_event_name: "UserPromptSubmit",
        cwd: clone,
        prompt,
      }),
    );
    const stdout = await promise;
    assert.equal(stdout, "", "A prompt hook never prints: its output would join the conversation");
  }

  /** `gm steps --follow --count 1` in the background: its first record, and when it came. */
  function followOneStep(clone: string) {
    const env: NodeJS.ProcessEnv = {
      ...ctx.env,
      GM_SERVER: ctx.origin,
      GM_TOKEN: fixtures.tokens.jun,
    };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_CONFIG_") || key === "SSH_AUTH_SOCK" || key === "GITMATRIX_TOKEN")
        delete env[key];
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    const { promise, resolve, reject } = Promise.withResolvers<{ line: string; at: number }>();
    const child = spawn(ctx.gm, ["--output", "json", "steps", "--follow", "--count", "1"], {
      cwd: clone,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim())
        resolve({ line: stdout.trim().split("\n")[0]!, at: Date.now() });
      else reject(new Error(`gm steps --follow exited ${code}: ${redact(stderr)}`));
    });
    return promise;
  }

  await scenario("steps-context-hook-live-run-landing-and-access", async () => {
    // CORE-226 (S01, S02, S04, S06, S07, S09): an agent steps through a
    // timeline: what the person said comes through the hook, the step carries
    // its why and local tests, arrives on the live feed within seconds, gets
    // its step run's summary, and after landing, gm why on its line shows it.
    const slug = `steps-e2e-${randomUUID().slice(0, 8)}`;
    const file = `steps-e2e/${slug}.txt`;
    const clone = await landingTimeline(slug);
    await mkdir(join(clone, "steps-e2e"), { recursive: true });
    await writeFile(join(clone, file), `${slug}\n`);
    await mkdir(join(clone, ".gitmatrix"), { recursive: true });
    await writeFile(
      join(clone, ".gitmatrix", "ci.yml"),
      JSON.stringify({
        on: { push: { branches: ["never-agent-auto"] }, step: {} },
        jobs: {
          "step-check": {
            on: "step",
            local: true,
            steps: [{ run: `test -f ${file} && echo STEP_OK` }],
          },
          gate: { if: 'trigger == "landing"', steps: [{ run: "echo LANDING_GATE_OK" }] },
        },
      }),
    );
    // S02: the person's own words, through the Claude Code hook.
    await gmHook(clone, "Mark the steps E2E file");
    await gmHook(clone, "Keep it to one line");
    const context = join(work, `${slug}-context.md`);
    await writeFile(context, "## Why\nProve steps end to end.\n\n## Challenges\nNone so far.\n");

    // S01: one command tests, commits with context and pushes; the live feed has it within seconds.
    const following = followOneStep(clone);
    await delay(1_500);
    const stepped = JSON.parse(
      await gm(["step", "-m", `Steps E2E ${slug}`, "--context", context], "jun", clone),
    ) as { tests: { jobs: { name: string; status: string }[] }; push: { bookmark: string } };
    const returnedAt = Date.now();
    assert.deepEqual(
      stepped.tests.jobs.map((job) => [job.name, job.status]),
      [["step-check", "passed"]],
      "gm step runs the repository's local step jobs",
    );
    assert.equal(stepped.push.bookmark, `timeline/${slug}`);
    const followed = await following;
    const live = JSON.parse(followed.line) as StepFeedRecord;
    const latencyMs = Math.max(0, followed.at - returnedAt);
    assert.equal(live.summary, `Steps E2E ${slug}`);
    assert.equal(live.timeline, slug);
    assert(latencyMs < 5_000, `The live feed took ${latencyMs} ms after gm step returned`);

    // The stored step: verified by the push, with the hook's words, its why and tests.
    const stepFor = () =>
      json<StepPage>(`${api}/steps?commits=${live.commitOid}`, fixtures.tokens.sam).then(
        (page) => page.steps[0],
      );
    // Verified once the push's ref log has shown the commit (it can trail the upload).
    const step = await poll(stepFor, (s) => !!s?.verified, "the step verified by its push");
    assert(step, "A reader of the repository reads the step");
    assert.deepEqual(
      step.context.instructions.map((e) => [e.text, e.source]),
      [["Mark the steps E2E file", "hook"]],
    );
    assert.deepEqual(
      step.context.steering.map((e) => [e.text, e.source]),
      [["Keep it to one line", "hook"]],
    );
    assert.equal(step.context.coverage.steering, "hook:claude-code");
    assert.equal(step.context.why, "Prove steps end to end.");
    assert.deepEqual(
      step.context.tests.map((t) => [t.command, t.exit, t.origin]),
      [["gm test: step-check", 0, "local"]],
    );
    // S06: the push's step run attaches its summary to the step.
    const withRun = await poll(
      stepFor,
      (s) => !!s && s.artifacts.length > 0,
      "the step run's summary",
    );
    const summary = withRun!.artifacts[0]!;
    assert.equal(summary.kind, "test-summary");
    assert.equal(summary.kind === "test-summary" && summary.data.status, "succeeded");

    // S04: an agent's commit without context warns and still commits.
    await writeFile(join(clone, `${file}.more`), "more\n");
    const quiet = JSON.parse(
      await gm(["commit", "-m", "No context here"], "jun", clone, undefined, { GM_AGENT: "1" }),
    ) as { warnings?: string[] };
    assert.match(quiet.warnings?.[0] ?? "", /has no context/);

    // S09: someone who can't read the repository sees neither steps nor the feed.
    await request(`${api}/steps?timeline=${slug}`, null, "GET", undefined, [404]);
    await request(`${api}/steps/live?timeline=${slug}`, null, "GET", undefined, [404]);

    // S07: the timeline lands; gm why on the landed line still shows its step.
    await writeFile(join(clone, `${file}.done`), "done\n");
    await pushAndCheckpoint(clone, slug, `Steps E2E checkpoint ${slug}`);
    const landing = await settledLanding(slug);
    assert.equal(landing.state, "landed", `Landing stopped: ${landing.reason}`);
    const why = JSON.parse(await gm(["why", `${file}:1`], "jun", clone)) as WhyResponse;
    const chain = why.chains.find((c) => c.oid === live.commitOid);
    assert(chain, "gm why leads the landed line to the step's commit");
    assert.equal(chain.step?.context.why, "Prove steps end to end.");
    record({
      steps: { slug, commit: live.commitOid, latencyMs, artifact: summary.kind, landed: true },
    });
  });

  await scenario("timeline-landing-conflict-asks-for-a-sync", async () => {
    const slug = `clash-e2e-${randomUUID().slice(0, 8)}`;
    const file = `landing-e2e/${slug}.txt`;
    const clone = await landingTimeline(slug);
    const mainBefore = await branchTip("main");
    // Main changes the same file after the fork.
    const mainClone = join(work, `main-${slug}`);
    await gm(["clone", fullName, mainClone], "marco");
    await mkdir(join(mainClone, "landing-e2e"), { recursive: true });
    await writeFile(join(mainClone, file), "main's version\n");
    await gm(["commit", "-m", `Main clashes with ${slug}`], "marco", mainClone);
    await gm(["push", "-b", "main"], "marco", mainClone);
    const mainTip = await poll(
      () => branchTip("main"),
      (tip) => !!tip && tip !== mainBefore,
      "main after the clashing push",
    );
    await mkdir(join(clone, "landing-e2e"), { recursive: true });
    await writeFile(join(clone, file), "the timeline's version\n");
    try {
      await pushAndCheckpoint(clone, slug, `Clashing E2E ${slug}`);
      const landing = await settledLanding(slug);
      assert.equal(landing.state, "conflict", `Expected a conflict, got: ${landing.reason}`);
      assert.equal(landing.repos[0]?.gateRun, null, "A conflicting merge is never tested");
      assert.equal(await branchTip("main"), mainTip, "Main never moves on a conflict");
      const timeline = await json<{
        timeline: { status: string };
        events: { kind: string; outcome?: string }[];
      }>(`${timelinesApi}/${slug}`, ownerToken);
      assert.equal(timeline.timeline.status, "active");
      assert.equal(timeline.events.at(-1)?.outcome, "conflict");
      const shown = JSON.parse(
        await gm(["timeline", "show", slug, "--owner", fixtures.tracker.owner], "jun", clone),
      ) as { landing?: { state: string; reason: string } };
      assert.equal(shown.landing?.state, "conflict", "gm timeline show reports the landing");
      record({ timeline: slug, main: mainTip, conflict: landing.reason });
    } finally {
      await request(`${timelinesApi}/${slug}/abandon`, fixtures.tokens.jun, "POST").catch(() => {});
    }
  });

  await scenario("timeline-nested-admission-and-canonical-revert", async () => {
    const parent = `parent-${randomUUID().slice(0, 8)}`;
    const child = `child-${randomUUID().slice(0, 8)}`;
    const parentClone = await landingTimeline(parent);
    const parentFile = `${parent}.txt`;
    const laterFile = `${parent}-later.txt`;
    const childFile = `${child}.txt`;
    await writeFile(join(parentClone, parentFile), "Parent P0\n");
    await gm(["commit", "-m", "Parent P0"], "jun", parentClone);
    await gm(["push"], "jun", parentClone);
    const p0 = await sourceTip(parent);
    assert(p0);
    await json(
      timelinesApi,
      fixtures.tokens.jun,
      "POST",
      { slug: child, parent, policy: "auto", repos: [fullName] },
      [201],
    );
    const parentSource = await timelineSource(parent);
    const childSource = await timelineSource(child);
    assert.notEqual(childSource.sourceId, parentSource.sourceId);
    assert.equal(await sourceTip(child), p0);
    const childClone = join(work, child);
    await gm(["clone", fullName, childClone], "jun");
    await gm(["timeline", "use", child, "--owner", fixtures.tracker.owner], "jun", childClone);
    await writeFile(join(childClone, childFile), "Child delta\n");
    const checkpoint = await pushAndCheckpoint(childClone, child, "Child before parent lands");
    assert.equal(checkpoint.repos[0]?.logicalBase?.commit, p0);
    const blocked = await settledLanding(child);
    assert.equal(blocked.state, "blocked_dependency");
    // A separate child imports the parent's later P1; its fresh checkpoint must
    // review P1 as B rather than permanently inheriting its original P0.
    const importedChild = `${child}-imported`;
    await json(
      timelinesApi,
      fixtures.tokens.jun,
      "POST",
      { slug: importedChild, parent, policy: "auto", repos: [fullName] },
      [201],
    );
    const importedClone = join(work, importedChild);
    const importedFile = `${importedChild}.txt`;
    await gm(["clone", fullName, importedClone], "jun");
    await gm(
      ["timeline", "use", importedChild, "--owner", fixtures.tracker.owner],
      "jun",
      importedClone,
    );
    await writeFile(join(importedClone, importedFile), "Imported child's own delta\n");
    await gm(["commit", "-m", "Child delta before importing P1"], "jun", importedClone);
    await writeFile(join(parentClone, laterFile), "Parent P1\n");
    const parentCheckpoint = await pushAndCheckpoint(parentClone, parent, "Parent P1 includes P0");
    const parentLanding = await settledLanding(parent);
    assert.equal(parentLanding.state, "landed", parentLanding.reason ?? "");
    const integrated = await json<{
      status: string;
      integration: { source: SourceSnapshot } | null;
      members: string[];
    }>(`${api}/sources/${parentSource.sourceId}/lineage?commit=${p0}`, ownerToken);
    assert.equal(integrated.status, "integrated");
    assert.equal(integrated.integration?.source.commit, parentCheckpoint.repos[0]?.commit);
    assert.deepEqual(integrated.members, [p0]);
    await gm(["timeline", "merge", parent], "jun", importedClone);
    const importedCheckpoint = await pushAndCheckpoint(
      importedClone,
      importedChild,
      "Review imported P1 baseline",
    );
    assert.equal(importedCheckpoint.repos[0]?.logicalBase?.sourceId, parentSource.sourceId);
    assert.equal(
      importedCheckpoint.repos[0]?.logicalBase?.commit,
      parentCheckpoint.repos[0]?.commit,
    );
    const importedLanding = await settledLanding(importedChild);
    assert.equal(importedLanding.state, "landed", importedLanding.reason ?? "");
    const importedCompact = importedLanding.repos[0]?.merge;
    assert(importedCompact);
    await nativeGit(["fetch", "origin", "main"], importedClone);
    assert.equal(
      await nativeGit(["show", "-s", "--format=%P", importedCompact], importedClone),
      parentLanding.repos[0]?.merge,
    );
    assert.equal(
      await nativeGit(["show", `${importedCompact}:${importedFile}`], importedClone),
      "Imported child's own delta",
    );
    assert.equal(
      await nativeGit(["show", `${importedCompact}:${laterFile}`], importedClone),
      "Parent P1",
    );
    record({
      importedChild,
      importedCompact,
      reviewedBase: importedCheckpoint.repos[0]?.logicalBase,
    });

    // Reverting the compact parent must not cause the child to replay parent content.
    const reverted = join(work, `${parent}-revert`);
    await nativeGit(["clone", `${ctx.origin}/${fullName}.git`, reverted]);
    const parentCompact = parentLanding.repos[0]?.merge;
    assert(parentCompact);
    await nativeGit(
      [
        "-c",
        "user.name=Agent Fixture",
        "-c",
        "user.email=agent@gitmatrix.invalid",
        "revert",
        "--no-edit",
        parentCompact,
      ],
      reverted,
    );
    await nativeGit(["push", "origin", "HEAD:main"], reverted);
    const revertTip = await nativeGit(["rev-parse", "HEAD"], reverted);
    await gm(["timeline", "land", child, "--owner", fixtures.tracker.owner], "jun", childClone);
    const childLanding = await settledLanding(child);
    assert.equal(childLanding.state, "landed", childLanding.reason ?? "");
    const childCompact = childLanding.repos[0]?.merge;
    assert(childCompact);
    await nativeGit(["fetch", "origin", "main"], reverted);
    assert.equal(
      await nativeGit(["show", `${childCompact}:${childFile}`], reverted),
      "Child delta",
    );
    const files = (await nativeGit(["ls-tree", "-r", "--name-only", childCompact], reverted)).split(
      "\n",
    );
    assert(!files.includes(parentFile), "Child does not replay reverted P0 content");
    assert(!files.includes(laterFile), "Child does not replay reverted P1 content");
    assert.equal(await nativeGit(["show", "-s", "--format=%P", childCompact], reverted), revertTip);
    record({ parent, child, p0, parentCompact, childCompact, revertTip, integrated });
  });

  await scenario("queue-concurrency-failure-fencing-and-push-recovery", async () => {
    await runQueueE2E(ctx, fixtures, gm, record);
  });

  await scenario("agent-setup-memorable-persistent-identities", async () => {
    const home = join(work, "setup-names-home");
    const first = join(work, "setup-names-first");
    const second = join(work, "setup-names-second");
    const explicit = join(work, "setup-names-explicit");
    for (const dir of [first, second, explicit])
      await mkdir(join(dir, ".gitmatrix"), { recursive: true });
    const machine = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "config"),
      GM_TOKEN: "",
      GM_AGENT: "0",
    };
    await gm(["auth", "login", "--token", ownerToken], "marco", first, undefined, machine);
    const list = async () => (await json<{ agents: Agent[] }>("/api/agents", ownerToken)).agents;
    const before = await list();
    const args = ["agent", "setup", "--harness", "codex", "--owner", fixtures.tracker.owner];
    await gm([...args, "--check"], "marco", first, /"stale"/, machine);
    assert.deepEqual(await readdir(first), [".gitmatrix"]);
    assert.deepEqual(await readdir(join(first, ".gitmatrix")), []);
    assert.deepEqual(await list(), before, "Checking a fresh checkout never registers an identity");
    type Setup = {
      agent: string;
      identity: { id: string; name: string; created: boolean; accountable: string };
    };
    const setup = async (dir: string, extra: string[] = [], env = machine) =>
      JSON.parse(await gm([...args, ...extra], "marco", dir, undefined, env)) as Setup;
    const a = await setup(first);
    assert.match(a.agent, /^[a-z]+-[a-z]+(?:-[0-9a-f]{8})?$/);
    assert(!["agent", "codex", "claude-code"].includes(a.agent));
    assert.equal(a.identity.created, true);
    const b = await setup(second);
    assert.match(b.agent, /^[a-z]+-[a-z]+(?:-[0-9a-f]{8})?$/);
    assert.notEqual(b.agent, a.agent);
    assert.notEqual(b.identity.id, a.identity.id);
    assert.equal(b.identity.created, true);
    const afterNew = await list();
    assert.equal(afterNew.length, before.length + 2);
    for (const result of [a, b]) {
      const registered = afterNew.find((agent) => agent.id === result.identity.id);
      assert(registered);
      assert.equal(registered.accountable.id, "acc_marco");
      assert.equal(registered.tokens.length, 1);
    }
    const rerun = await setup(first);
    assert.equal(rerun.agent, a.agent);
    assert.equal(rerun.identity.id, a.identity.id);
    assert.equal(rerun.identity.created, false);
    const asAgent = await setup(first, [], { ...machine, GM_AGENT: "1" });
    assert.equal(asAgent.identity.id, a.identity.id);
    assert.equal(asAgent.identity.accountable, a.identity.accountable);
    const afterRerun = await list();
    assert.equal(afterRerun.length, afterNew.length);
    assert.deepEqual(
      afterRerun.find((agent) => agent.id === a.identity.id)?.tokens.map((token) => token.id),
      afterNew.find((agent) => agent.id === a.identity.id)?.tokens.map((token) => token.id),
      "Rerunning setup keeps the existing token",
    );
    const local = await readFile(join(first, ".gitmatrix", "agent.local.yml"), "utf8");
    await gm([...args, "--check"], "marco", first, undefined, machine);
    assert.equal(await readFile(join(first, ".gitmatrix", "agent.local.yml"), "utf8"), local);
    assert.deepEqual(await list(), afterRerun);
    const chosen = `chosen-${randomUUID().slice(0, 8)}`;
    const named = await setup(explicit, ["--name", chosen]);
    assert.equal(named.agent, chosen);
    assert.equal(named.identity.created, true);
    const namedAgain = await setup(explicit, ["--name", chosen]);
    assert.equal(namedAgain.identity.id, named.identity.id);
    assert.equal(namedAgain.identity.created, false);
    const namedAgent = (await list()).find((agent) => agent.id === named.identity.id);
    assert.equal(namedAgent?.accountable.id, "acc_marco");
    assert.equal(namedAgent?.tokens.length, 1);
    record({
      generated: [a.agent, b.agent],
      explicit: chosen,
      accountable: a.identity.accountable,
    });
  });

  await scenario("agent-identity-provisioned-on-first-use", async () => {
    // A harness drives gm in a checkout set up for an agent, but this machine
    // holds no token for it: gm must act as the agent, never quietly as its person.
    const name = `harness-${randomUUID().slice(0, 8)}`;
    const home = join(work, "provision-home");
    const dir = join(work, "provision-checkout");
    await mkdir(join(dir, ".gitmatrix"), { recursive: true });
    await writeFile(join(dir, ".gitmatrix", "agent.local.yml"), `name: ${name}\n`);
    const machine = { HOME: home, XDG_CONFIG_HOME: join(home, "config"), GM_TOKEN: "" };
    const harness = { ...machine, GM_AGENT: "1" };
    await gm(["auth", "login", "--token", ownerToken], "marco", dir, undefined, {
      ...machine,
      GM_AGENT: "0",
    });
    const status = JSON.parse(await gm(["auth", "status"], "marco", dir, undefined, harness)) as {
      actingAs?: string;
      user: { id: string; agent: { id: string; name: string } | null };
    };
    assert.equal(status.user.agent?.name, name, "gm must act as the checkout's agent");
    assert.match(status.actingAs ?? "", new RegExp(`^${name} \\(for `));
    const claim = JSON.parse(
      await gm(
        ["issue", "claim", fixtures.tracker.blocker, "--owner", fixtures.tracker.owner],
        "marco",
        dir,
        undefined,
        harness,
      ),
    ) as { results: { leaseToken: string }[] };
    const lease = claim.results[0]?.leaseToken;
    assert(lease, "Agent claim must return a fencing token");
    secrets.add(lease);
    const shown = JSON.parse(
      await gm(
        ["issue", "show", fixtures.tracker.blocker, "--owner", fixtures.tracker.owner],
        "marco",
        dir,
        undefined,
        harness,
      ),
    ) as { issue: { claim: { actorId: string; accountableId: string } } };
    assert.equal(shown.issue.claim.actorId, status.user.agent?.id, "The agent holds the claim");
    assert.equal(shown.issue.claim.accountableId, status.user.id, "Its person is accountable");
    const { agents } = await json<{ agents: Agent[] }>("/api/agents", ownerToken);
    const agent = agents.find((candidate) => candidate.name === name);
    assert(agent, "gm must have created the checkout's agent");
    assert.equal(agent.tokens.length, 1, "Later commands reuse the kept token");
    await gm(
      ["issue", "release", fixtures.tracker.blocker, "--owner", fixtures.tracker.owner],
      "marco",
      dir,
      undefined,
      { ...harness, GM_LEASE_TOKEN: lease },
    );
    // CI keeps the agent too: a run it starts names it with its person.
    const started = JSON.parse(
      await gm(
        ["runs", "start", "--ref", "agent-ci-failure", "--repo", fullName],
        "marco",
        dir,
        undefined,
        harness,
      ),
    ) as { number: number };
    const run = await poll(() => runDetail(started.number), terminal, "agent-started run");
    assert.equal(run.agent, name, "The run records the agent that started it");
    assert.equal(run.actor, "marco", "…and the person it acts for");
    await gm(["agent", "revoke", agent.id]);
    record({
      agent: name,
      claimIdentity: shown.issue.claim.actorId,
      tokens: agent.tokens.length,
      run: { number: run.number, actor: run.actor, agent: run.agent },
    });
  });

  await scenario("profile-picture-upload-serve-and-remove", async () => {
    // CORE-116: a person's picture, stored in the AVATARS bucket.
    const token = fixtures.tokens.jun;
    const put = (bytes: Uint8Array, type: string) =>
      fetch(`${ctx.origin}/api/account/avatar`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": type },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(30_000),
      });
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const refused = await put(new TextEncoder().encode("<svg/>"), "image/svg+xml");
    assert.equal(refused.status, 415, "Only PNG, JPEG and WebP pictures are accepted");
    const saved = await put(png, "image/png");
    assert.equal(saved.status, 200, `upload: HTTP ${saved.status}`);
    const url = ((await saved.json()) as { viewer: { avatarUrl: string | null } }).viewer.avatarUrl;
    assert.match(url ?? "", /^\/api\/avatars\/[\w-]+\/[0-9a-f]{32}\.png$/);
    // Public, like the profile it belongs to, and cached for good.
    const served = await fetch(`${ctx.origin}${url}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png);
    const page = await json<{ avatarUrl: string | null }>("/api/accounts/jun", null);
    assert.equal(page.avatarUrl, url, "The profile shows the picture");
    // Generated options need AI, which this environment doesn't have: it says so.
    await request("/api/account/avatar/options", token, "POST", undefined, [503]);
    const removed = await json<{ viewer: { avatarUrl: string | null } }>(
      "/api/account/avatar",
      token,
      "DELETE",
    );
    assert.equal(removed.viewer.avatarUrl, null);

    // CORE-128: an organization's icon, by its owners only.
    const orgPut = (who: string) =>
      fetch(`${ctx.origin}/api/accounts/${repo.owner}/avatar`, {
        method: "PUT",
        headers: { authorization: `Bearer ${who}`, "content-type": "image/png" },
        body: new Uint8Array(png),
        signal: AbortSignal.timeout(30_000),
      });
    assert.equal((await orgPut(token)).status, 403, "A plain member can't change the org icon");
    const iconSaved = await orgPut(fixtures.tokens.marco);
    assert.equal(iconSaved.status, 200, `org icon: HTTP ${iconSaved.status}`);
    const icon = ((await iconSaved.json()) as { avatarUrl: string | null }).avatarUrl;
    const org = await json<{ avatarUrl: string | null; viewerCanManage: boolean }>(
      `/api/accounts/${repo.owner}`,
      fixtures.tokens.marco,
    );
    assert.equal(org.avatarUrl, icon, "The organization shows its icon");
    assert.equal(org.viewerCanManage, true);
    await request(`/api/accounts/${repo.owner}/avatar`, fixtures.tokens.marco, "DELETE");
    record({ avatar: url, removed: true, orgIcon: icon });
  });

  await scenario("durable-objects-register-and-purge", async () => {
    // CORE-197, in the real runtime: every Durable Object class, a fresh
    // instance each, recorded in the registry on use, given storage and an
    // alarm (retire()), then purged: no table, key or alarm left, and the
    // registry row records the purge.
    interface Report {
      bytes: number;
      tables: string[];
      keys: number;
      alarm: number | null;
    }
    const { results } = await json<{
      results: {
        class: string;
        name: string;
        registered: boolean;
        before: Report;
        purged: Report & { reason: string };
        row: { purged_at: string | null; purge_reason: string | null } | null;
      }[];
    }>("/api/dev/durable", ctx.env.GITMATRIX_AGENT_SECRET ?? "", "POST", {});
    assert.deepEqual(results.map((r) => r.class).sort(), [
      "Assistant",
      "CiSandbox",
      "KnowledgeCoordinator",
      "RegistryLogin",
      "RegistryRepo",
      "RegistryUpload",
      "StepFeed",
      "Tracker",
    ]);
    for (const result of results) {
      const label = `${result.class} ${result.name}`;
      assert(result.registered, `${label}: recorded in do_instances on first use`);
      assert(
        result.before.keys + result.before.tables.length > 0 && result.before.alarm !== null,
        `${label}: held storage and an alarm before the purge: ${JSON.stringify(result.before)}`,
      );
      assert.deepEqual(
        { tables: result.purged.tables, keys: result.purged.keys, alarm: result.purged.alarm },
        { tables: [], keys: 0, alarm: null },
        `${label}: purge leaves no storage and no alarm`,
      );
      assert(result.row?.purged_at, `${label}: the registry row records the purge`);
      assert.equal(result.row?.purge_reason, "probe");
    }
    record({
      durable: results.map((r) => ({ class: r.class, before: r.before, after: r.purged.bytes })),
    });
  });

  await scenario("usage-metering-collects-per-account", async () => {
    // CORE-207, in the real runtime: the cron's collection, run to the end,
    // meters what the earlier scenarios stored for the fixture repository's
    // owner: pushed pack bytes (Artifacts), D1 groups, Durable Objects.
    interface Figure {
      day: string;
      construct: string;
      item: string;
      metric: string;
      kind: string;
      quantity: number;
      estimated: number;
      method: string;
    }
    const { figures } = await json<{ runs: number; figures: Figure[] }>(
      "/api/dev/usage",
      ctx.env.GITMATRIX_AGENT_SECRET ?? "",
      "POST",
      { account: repo.owner },
    );
    const find = (construct: string, item: string, metric: string) =>
      figures.find((f) => f.construct === construct && f.item === item && f.metric === metric);
    const pushed = find("artifacts", "repositories", "bytes");
    assert(pushed && pushed.quantity > 0, "Pushes through the proxy count toward Artifacts");
    assert.equal(pushed.estimated, 1, "Artifacts bytes are labelled estimated");
    assert((find("d1", "repositories", "rows")?.quantity ?? 0) >= 1, "D1 rows are counted");
    assert.equal(find("d1", "repositories", "rows")?.estimated, 0);
    assert((find("d1", "repositories", "bytes")?.quantity ?? 0) > 0, "D1 bytes are sampled");
    assert.equal(find("d1", "repositories", "bytes")?.estimated, 1);
    assert(
      (find("durable_objects", "Tracker", "instances")?.quantity ?? 0) >= 1,
      "The account's tracker is metered from the instance registry",
    );
    for (const figure of figures)
      assert(figure.method.length > 0, `${figure.construct}/${figure.item} says how it was made`);
    record({ usage: figures.map((f) => `${f.construct}/${f.item}/${f.metric}=${f.quantity}`) });
  });

  await scenario("ai-gateway-log-bodies-site-default-and-account-override", async () => {
    // CORE-290: "Keep AI request and response bodies in gateway logs", per
    // component. Agent environments keep them by default; site administrators
    // set the site default and an account's administrators override it for
    // the account, through the API and `gm settings ai`; both show the
    // retention note; members, non-admins and agents are refused.
    type Entry = {
      component: string;
      site: boolean;
      siteFrom: string;
      account?: boolean | null;
      effective: boolean;
    };
    type View = { logBodies: { environmentDefault: boolean; note: string; components: Entry[] } };
    const find = (view: View, component: string) =>
      view.logBodies.components.find((e) => e.component === component)!;
    const site = await json<View & { canManage: boolean }>("/api/admin/ai", fixtures.tokens.priya);
    assert.equal(site.logBodies.environmentDefault, true, "Agent environments keep bodies");
    assert(site.logBodies.components.every((e) => e.effective && e.siteFrom === "environment"));
    assert.match(site.logBodies.note, /repository code and assistant conversations/);
    await request("/api/admin/ai", fixtures.tokens.marco, "GET", undefined, [403]);
    await request(
      "/api/admin/ai",
      fixtures.tokens.marco,
      "PATCH",
      { logBodies: { knowledge: false } },
      [403],
    );
    await gm(
      ["settings", "ai", "set", "--site", "--log-bodies", "off"],
      "marco",
      work,
      /site administrators|403/i,
    );

    try {
      // The site turns Knowledge bodies off; marco keeps them for his own account.
      const shown = JSON.parse(await gm(["settings", "ai", "show", "--site"], "priya")) as View;
      assert.equal(find(shown, "knowledge").effective, true);
      const off = JSON.parse(
        await gm(["settings", "ai", "set", "--site", "--log-bodies", "knowledge=off"], "priya"),
      ) as View;
      const knowledge = find(off, "knowledge");
      assert.equal(knowledge.site, false);
      assert.equal(knowledge.siteFrom, "site");
      assert.equal(knowledge.effective, false);
      const own = JSON.parse(
        await gm(["settings", "ai", "set", "--owner", "marco", "--log-bodies", "knowledge=on"]),
      ) as View;
      assert.equal(find(own, "knowledge").account, true);
      assert.equal(find(own, "knowledge").effective, true);
      // Orbit follows the site; jun (a member) reads but can't change it.
      const orbit = await json<View>("/api/accounts/orbit/settings/ai", fixtures.tokens.jun);
      assert.equal(find(orbit, "knowledge").effective, false);
      await gm(
        ["settings", "ai", "set", "--owner", "orbit", "--log-bodies", "knowledge=on"],
        "jun",
        work,
        /owner|site admin|403/i,
      );
      // --dry-run sends nothing.
      const dry = JSON.parse(
        await gm(["settings", "ai", "set", "--site", "--log-bodies", "on", "--dry-run"], "priya"),
      ) as { dry_run: boolean; path: string; request: { logBodies: Record<string, boolean> } };
      assert.equal(dry.path, "/admin/ai");
      assert.equal(Object.keys(dry.request.logBodies).length, 6);
      assert.equal(
        find(await json<View>("/api/admin/ai", fixtures.tokens.priya), "knowledge").site,
        false,
      );
      record({ site: "knowledge=off", marco: "knowledge=on", orbit: "follows site" });
    } finally {
      await gm(["settings", "ai", "set", "--owner", "marco", "--log-bodies", "default"]);
      await gm(["settings", "ai", "set", "--site", "--log-bodies", "default"], "priya");
    }
    const reset = await json<View>("/api/admin/ai", fixtures.tokens.priya);
    assert(reset.logBodies.components.every((e) => e.siteFrom === "environment" && e.effective));
  });

  await scenario("browser-usage-and-costs-account-and-site", async () => {
    // CORE-209: the account's Usage & costs page (its administrators) and the
    // site's (site administrators), from the collection the scenario above ran,
    // at desktop and phone widths; members and non-admins are refused.
    const owner = repo.owner;
    const report = await json<UsageReport>(`/api/accounts/${owner}/usage`, fixtures.tokens.marco);
    assert(report.asOf, "The collection above produced a report day");
    const lines = report.constructs.flatMap((c) => c.lines);
    assert(lines.length > 0, "The report has priced lines");
    assert(
      lines.some((l) => l.estimated),
      "Estimated figures (sampled D1 bytes, Artifacts) are labelled",
    );
    for (const line of lines)
      for (const cost of line.costs)
        assert(
          Math.abs(cost.monthlyUsd - (cost.quantity * cost.unitPriceUsd) / cost.unitQuantity) <
            1e-12,
          `${line.construct}/${line.item}: cost = quantity × price`,
        );
    await request(`/api/accounts/${owner}/usage`, fixtures.tokens.jun, "GET", undefined, [403]);
    await request(`/api/accounts/${owner}/usage`, fixtures.tokens.sam, "GET", undefined, [404]);
    await request("/api/admin/usage", fixtures.tokens.marco, "GET", undefined, [403]);
    const site = await json<UsageReport>("/api/admin/usage", fixtures.tokens.priya);
    assert(
      site.accounts?.some((a) => a.slug === owner),
      "The site report totals the fixture's owner",
    );

    const browserTimeout = 15_000;
    const expect = playwrightExpect.configure({ timeout: browserTimeout });
    const browser = await chromium.launch({ headless: true });
    const signIn = async (persona: Persona, viewport: { width: number; height: number }) => {
      const context = await browser.newContext({ baseURL: ctx.origin, viewport });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage();
      page.setDefaultTimeout(browserTimeout);
      await page.goto("/signin");
      await page.getByRole("button", { name: new RegExp(`Continue as ${persona}`, "i") }).click();
      await page.waitForURL((url) => url.pathname !== "/signin");
      return { context, page };
    };
    const noSideways = async (page: import("@playwright/test").Page, label: string) => {
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      assert(width <= page.viewportSize()!.width, `${label}: no horizontal scrolling (${width})`);
    };
    const contexts: BrowserContext[] = [];
    let current: import("@playwright/test").Page | null = null;
    try {
      for (const [width, height] of [
        [1280, 900],
        [390, 844],
      ] as const) {
        const label = `${width}px`;
        const { context, page } = await signIn("marco", { width, height });
        contexts.push(context);
        current = page;
        // Reached from the settings navigation's account group.
        await page.goto(`/settings/ai?owner=${owner}`);
        if (width < 768) await page.getByText("Settings /").click();
        await page.getByRole("link", { name: "Usage & costs", exact: true }).click();
        await page.waitForURL((url) => url.pathname === "/settings/usage");
        await expect(page.getByRole("heading", { name: "Usage & costs", level: 1 })).toBeVisible();
        await expect(page.getByText(`Usage for @${owner}`, { exact: true })).toBeVisible();
        await expect(page.locator("[data-usage-total]")).toBeVisible();
        await expect(page.getByText("Daily cost, last 30 days")).toBeVisible();
        for (const construct of report.constructs)
          await expect(
            page.getByRole("heading", { name: construct.label, level: 2, exact: true }),
          ).toBeVisible();
        await expect(page.locator("[data-usage-line]")).toHaveCount(lines.length);
        // Drill down: figures with how they were measured, the price, the category.
        const d1 = lines.find((l) => l.construct === "d1" && l.categories.length > 0);
        assert(d1, "A D1 group maps to a retention category");
        const detail = page.locator(`[data-usage-line="d1/${d1.item}"]`);
        await detail.locator("summary").click();
        await expect(detail.getByText("Estimated").first()).toBeVisible();
        await expect(detail.getByText(/per GB-month/).first()).toBeVisible();
        await expect(
          detail.locator(`[data-retention-category="${d1.categories[0]!.id}"]`),
        ).toContainText(d1.categories[0]!.label);
        await expect(page.getByRole("link", { name: "D1", exact: true })).toHaveAttribute(
          "href",
          /developers\.cloudflare\.com\/d1\//,
        );
        await noSideways(page, label);
        // CSV export: one row per figure.
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          page.getByRole("link", { name: "Download CSV" }).click(),
        ]);
        assert.equal(download.suggestedFilename(), `${owner}-usage-${report.asOf}.csv`);
        const csv = await readFile((await download.path())!, "utf8");
        const rows = csv.trim().split("\n");
        assert.match(rows[0]!, /^construct,item,label,kind,metric,quantity,estimated,/);
        assert.equal(
          rows.length - 1,
          lines.reduce((sum, l) => sum + l.figures.length, 0),
          `${label}: CSV has one row per figure`,
        );
        await context.tracing.stop();
        await context.close();
      }

      // A member who isn't an administrator is refused; the site page isn't theirs.
      {
        const { context, page } = await signIn("jun", { width: 390, height: 844 });
        contexts.push(context);
        current = page;
        await page.goto(`/settings/usage?owner=${owner}`);
        await expect(
          page.getByText("Only the account's administrators see its usage and costs."),
        ).toBeVisible();
        await expect(page.locator("[data-usage-report]")).toHaveCount(0);
        await page.goto("/settings/site-usage");
        await page.waitForURL((url) => url.pathname === "/");
        await context.tracing.stop();
        await context.close();
      }

      // The site administrator: every account and the site total, at both widths.
      for (const [width, height] of [
        [1280, 900],
        [390, 844],
      ] as const) {
        const { context, page } = await signIn("priya", { width, height });
        contexts.push(context);
        current = page;
        await page.goto("/settings/site-usage");
        await expect(
          page.getByRole("heading", { name: "Site usage & costs", level: 1 }),
        ).toBeVisible();
        await expect(page.locator('[data-usage-report="site"]')).toBeVisible();
        const accounts = page.getByRole("region", { name: "By account" });
        await expect(accounts.getByRole("listitem")).toHaveCount(site.accounts!.length);
        await noSideways(page, `site ${width}px`);
        await accounts.getByRole("link", { name: new RegExp(`@${owner}\\b`) }).click();
        await page.waitForURL(
          (url) => url.pathname === "/settings/usage" && url.searchParams.get("owner") === owner,
        );
        await expect(page.locator('[data-usage-report="account"]')).toBeVisible();
        await context.tracing.stop();
        await context.close();
      }
      record({ lines: lines.length, accounts: site.accounts!.length, widths: [1280, 390] });
    } catch (error) {
      await current
        ?.screenshot({ path: join(ctx.artifacts, "browser-usage-failure.png"), fullPage: true })
        .catch(() => {});
      await contexts
        .at(-1)
        ?.tracing.stop({ path: join(ctx.artifacts, "browser-usage-failure.zip") })
        .catch(() => {});
      throw error;
    } finally {
      for (const context of contexts) await context.close().catch(() => {});
      await browser.close();
    }
  });

  await scenario("browser-data-retention-account-and-site", async () => {
    // CORE-210: the account's Data retention page (its administrators) and
    // the site's (site administrators), at desktop and phone widths, driven
    // from the keyboard. marco turns assistant chat expiration on, previews it
    // (exactly the stale chats seeded here), deletes them, and the history
    // records both runs; the cron never schedules a category that's off;
    // the usage report links each category to its row and "Clean up now";
    // `gm retention` matches; members and non-admins are refused.
    const owner = "marco";
    const token = fixtures.tokens.marco;
    const secret = ctx.env.GITMATRIX_AGENT_SECRET ?? "";
    const settings = `/api/accounts/${owner}/settings/retention`;
    const runs = `/api/accounts/${owner}/retention/runs`;
    type Run = {
      id: number;
      dryRun: boolean;
      status: string;
      items: number;
      bytes: number;
      categories: { category: string; items: number; cost: { monthlyUsd: number } | null }[];
    };
    type Chat = { id: string; updatedAt: string };

    // Authorization, API: a member of orbit and an outsider see nothing; only
    // site administrators reach the site level.
    const orbit = `/api/accounts/${repo.owner}`;
    await request(`${orbit}/settings/retention`, fixtures.tokens.jun, "GET", undefined, [403]);
    await request(`${orbit}/retention/runs`, fixtures.tokens.jun, "GET", undefined, [403]);
    await request(
      `${orbit}/retention/runs`,
      fixtures.tokens.jun,
      "POST",
      {
        dryRun: true,
        categories: ["ci-logs"],
      },
      [403],
    );
    await request(
      `${orbit}/settings/retention`,
      fixtures.tokens.jun,
      "PATCH",
      {
        categories: { "ci-logs": { enabled: true } },
      },
      [403],
    );
    await request(`${orbit}/settings/retention`, fixtures.tokens.sam, "GET", undefined, [404]);
    await request("/api/admin/retention", token, "GET", undefined, [403]);
    await request(
      "/api/admin/retention/runs",
      token,
      "POST",
      {
        dryRun: true,
        categories: ["auth-hygiene"],
      },
      [403],
    );
    await gm(["retention", "show", "--owner", repo.owner], "jun", work, /owners|forbidden|403/i);

    // Seed: stale chats (last used 120 days ago) and one used today.
    const tag = randomUUID().replaceAll("-", "").slice(0, 10);
    const staleIds = [`ret-stale-a-${tag}`, `ret-stale-b-${tag}`];
    const freshId = `ret-fresh-${tag}`;
    for (const id of staleIds)
      await json("/api/dev/assistant-chat", secret, "POST", {
        account: owner,
        id,
        title: `Stale ${id}`,
        updatedAt: new Date(Date.now() - 120 * 86_400_000).toISOString(),
      });
    await json("/api/dev/assistant-chat", secret, "POST", {
      account: owner,
      id: freshId,
      title: `Fresh ${tag}`,
    });
    const chats = async () => (await json<{ chats: Chat[] }>("/api/assistant/chats", token)).chats;
    // Everything of marco's the default (90 days unused) selects: the seeded
    // stale chats, plus any older ones another scenario left.
    const idle = (await chats()).filter(
      (c) => Date.parse(c.updatedAt) < Date.now() - 90 * 86_400_000,
    );
    for (const id of staleIds)
      assert(
        idle.some((c) => c.id === id),
        `${id} is idle for the policy`,
      );

    // gm parity: show, set, and a dry run that deletes nothing.
    const shown = JSON.parse(await gm(["retention", "show", "--owner", owner])) as {
      categories: { id: string; enabled: boolean }[];
    };
    assert.equal(shown.categories.find((c) => c.id === "assistant-chats")?.enabled, false);
    const gmDry = JSON.parse(
      await gm(["retention", "run", "assistant-chats", "--owner", owner, "--dry-run"]),
    ) as Run;
    assert.equal(gmDry.dryRun, true);
    assert.equal(gmDry.items, idle.length, "gm's dry run lists exactly the idle chats");
    await gm(
      ["retention", "run", "assistant-chats", "--owner", owner],
      "marco",
      work,
      /--yes|confirm/i,
    );

    const browserTimeout = 20_000;
    const expect = playwrightExpect.configure({ timeout: browserTimeout });
    const browser = await chromium.launch({ headless: true });
    const signIn = async (persona: Persona, viewport: { width: number; height: number }) => {
      const context = await browser.newContext({ baseURL: ctx.origin, viewport });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage();
      page.setDefaultTimeout(browserTimeout);
      await page.goto("/signin");
      await page.getByRole("button", { name: new RegExp(`Continue as ${persona}`, "i") }).click();
      await page.waitForURL((url) => url.pathname !== "/signin");
      return { context, page };
    };
    const noSideways = async (page: import("@playwright/test").Page, label: string) => {
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      assert(width <= page.viewportSize()!.width, `${label}: no horizontal scrolling (${width})`);
    };
    const contexts: BrowserContext[] = [];
    let current: import("@playwright/test").Page | null = null;
    try {
      // Desktop, from the settings navigation; everything by keyboard.
      {
        const { context, page } = await signIn("marco", { width: 1280, height: 900 });
        contexts.push(context);
        current = page;
        await page.goto(`/settings/usage?owner=${owner}`);
        await page.getByRole("link", { name: "Data retention", exact: true }).click();
        await page.waitForURL((url) => url.pathname === "/settings/retention");
        await expect(page.getByRole("heading", { name: "Data retention", level: 1 })).toBeVisible();
        const all = (await json<{ categories: { id: string; scope: string }[] }>(settings, token))
          .categories;
        await expect(page.locator("[data-retention-row]")).toHaveCount(all.length);
        await noSideways(page, "account 1280px");

        // Turn assistant chat expiration on: Space on the switch, Enter to save.
        const row = page.locator('[data-retention-row="assistant-chats"]');
        const toggle = row.getByRole("switch", { name: "Enable: Assistant chats" });
        await expect(toggle).toHaveAttribute("aria-checked", "false");
        await toggle.focus();
        await page.keyboard.press("Space");
        await expect(toggle).toHaveAttribute("aria-checked", "true");
        await row.getByRole("button", { name: "Save Assistant chats" }).focus();
        await page.keyboard.press("Enter");
        await expect(row.getByText("Assistant chats: saved.")).toBeVisible();
        const after = await json<{ categories: { id: string; enabled: boolean }[] }>(
          settings,
          token,
        );
        assert.equal(after.categories.find((c) => c.id === "assistant-chats")?.enabled, true);

        // Clean up now: choose it, preview, confirm, watch it finish.
        await row.getByRole("button", { name: "Clean up now: Assistant chats" }).focus();
        await page.keyboard.press("Enter");
        const cleanup = page.locator("#clean-up-now");
        await expect(cleanup.locator('[data-cleanup-category="assistant-chats"]')).toBeChecked();
        await cleanup.getByRole("button", { name: "Preview cleanup" }).focus();
        await page.keyboard.press("Enter");
        const status = cleanup.locator("[data-cleanup-status]");
        await expect(status).toContainText(`would be deleted`, { timeout: 60_000 });
        const previewRow = cleanup.locator(
          "[data-cleanup-preview] [data-run-category='assistant-chats'] [data-items]",
        );
        await expect(previewRow).toHaveAttribute("data-items", String(idle.length));
        // Nothing is deleted by a preview.
        for (const id of staleIds)
          assert(
            (await chats()).some((c) => c.id === id),
            `${id} survives the preview`,
          );
        const deleteButton = cleanup.getByRole("button", { name: /^Delete / });
        await deleteButton.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText(`Delete ${idle.length} record`);
        await dialog.getByRole("button", { name: "Delete", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(status).toContainText(`removed ${idle.length} record`, { timeout: 60_000 });
        const left = await chats();
        for (const id of staleIds)
          assert(!left.some((c) => c.id === id), `${id} was deleted by the cleanup`);
        assert(
          left.some((c) => c.id === freshId),
          "The chat used today is kept",
        );

        // The history records both, newest first, and the row its last run.
        const history = await json<{ runs: Run[] }>(runs, token);
        const [real, dry] = history.runs;
        assert(real && dry && !real.dryRun && dry.dryRun, "History: the run, then its preview");
        assert.equal(real.items, dry.items, "The run removed exactly what the preview listed");
        assert.equal(real.categories[0]!.cost !== null, true, "Its estimated cost is priced");
        await expect(page.locator(`[data-run="${real.id}"]`)).toContainText(`Cleanup #${real.id}`);
        await expect(page.locator(`[data-run="${dry.id}"]`)).toContainText(`Preview #${dry.id}`);
        await expect(row.locator("[data-last-run]")).toContainText(`#${real.id}`);

        // Previews: the existing preview settings, as a category.
        const previews = page.locator('[data-retention-row="previews"]');
        await previews.getByLabel("Days without pushes").fill("9");
        await previews.getByRole("button", { name: "Save Timeline previews" }).click();
        await expect(previews.getByText("Timeline previews: saved.")).toBeVisible();
        const previewSettings = await json<{ idleDays: number }>(
          `/api/accounts/${owner}/settings/previews`,
          token,
        );
        assert.equal(previewSettings.idleDays, 9, "The preview sweep reads what the page saved");

        // Turn it off again, with a harmless category on so the cron has a run to make.
        await toggle.focus();
        await page.keyboard.press("Space");
        await row.getByRole("button", { name: "Save Assistant chats" }).click();
        await expect(row.getByText("Assistant chats: saved.")).toBeVisible();
        await context.tracing.stop();
        await context.close();
      }

      // The schedule never runs a category that's off: a stale chat stays.
      const stale = `ret-stale-c-${tag}`;
      await json("/api/dev/assistant-chat", secret, "POST", {
        account: owner,
        id: stale,
        title: `Stale ${stale}`,
        updatedAt: new Date(Date.now() - 120 * 86_400_000).toISOString(),
      });
      await gm(["retention", "set", "release-notes", "--enable", "--owner", owner]);
      const cron = await json<{
        scheduled: { id: number; account: string | null; categories: string[] }[];
      }>("/api/dev/retention-cron", secret, "POST", {});
      assert(
        cron.scheduled.some(
          (run) => run.account === owner && run.categories.includes("release-notes"),
        ),
        "The explicitly enabled category is scheduled",
      );
      for (const run of cron.scheduled)
        if (run.account === null)
          assert.deepEqual(run.categories, ["auth-hygiene"], "The site's only always-on category");
      assert(
        !cron.scheduled.some(
          (r) => r.categories.includes("assistant-chats") && r.account === owner,
        ),
        "A disabled category is never scheduled",
      );
      await gm(["retention", "set", "release-notes", "--inherit", "--owner", owner]);
      await json(`/api/accounts/${owner}/settings/previews`, token, "PATCH", { idleDays: 7 });
      assert(
        (await chats()).some((c) => c.id === stale),
        "The schedule left the stale chat",
      );

      // Phone: the usage report's category link lands on its row with it chosen.
      {
        const { context, page } = await signIn("marco", { width: 390, height: 844 });
        contexts.push(context);
        current = page;
        await page.goto(`/settings/usage?owner=${repo.owner}`);
        const linked = page.locator("[data-retention-category] a").first();
        const category = await linked.locator("xpath=..").getAttribute("data-retention-category");
        await linked.locator("xpath=ancestor::details/summary").click();
        await linked.click();
        await page.waitForURL(
          (url) =>
            url.pathname === "/settings/retention" &&
            url.searchParams.get("owner") === repo.owner &&
            url.searchParams.get("cleanup") === category,
        );
        await expect(page.locator(`[data-retention-row="${category}"]`)).toBeVisible();
        await expect(page.locator(`[data-cleanup-category="${category}"]`)).toBeChecked();
        await noSideways(page, "account 390px");
        await context.tracing.stop();
        await context.close();
      }

      // A member who isn't an administrator is refused; the site page isn't theirs.
      {
        const { context, page } = await signIn("jun", { width: 390, height: 844 });
        contexts.push(context);
        current = page;
        await page.goto(`/settings/retention?owner=${repo.owner}`);
        await expect(
          page.getByText("Only the organization's owners can see its data retention."),
        ).toBeVisible();
        await expect(page.locator("[data-retention-row]")).toHaveCount(0);
        await page.goto("/settings/site-retention");
        await page.waitForURL((url) => url.pathname === "/");
        await context.tracing.stop();
        await context.close();
      }

      // The site administrator: site categories and site-wide defaults, a preview.
      for (const [width, height] of [
        [1280, 900],
        [390, 844],
      ] as const) {
        const { context, page } = await signIn("priya", { width, height });
        contexts.push(context);
        current = page;
        await page.goto("/settings/site-retention?cleanup=auth-hygiene");
        await expect(
          page.getByRole("heading", { name: "Site data retention", level: 1 }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Defaults for every account" }),
        ).toBeVisible();
        await expect(page.locator('[data-retention-row="usage-history"]')).toContainText("months");
        // Auth hygiene always runs: no switch, its days shown but not editable.
        const hygiene = page.locator('[data-retention-row="auth-hygiene"]');
        await expect(hygiene).toContainText("Always on");
        await expect(hygiene.getByRole("switch")).toHaveCount(0);
        await expect(hygiene.getByLabel("Days after expiry")).toBeDisabled();
        await expect(page.locator('[data-cleanup-category="auth-hygiene"]')).toBeChecked();
        await page.getByRole("button", { name: "Preview cleanup" }).click();
        await expect(page.locator("[data-cleanup-status]")).toContainText(/Preview #\d+ finished/, {
          timeout: 60_000,
        });
        await noSideways(page, `site ${width}px`);
        await context.tracing.stop();
        await context.close();
      }
      record({ deleted: idle.length, scheduled: cron.scheduled.length, widths: [1280, 390] });
    } catch (error) {
      await current
        ?.screenshot({ path: join(ctx.artifacts, "browser-retention-failure.png"), fullPage: true })
        .catch(() => {});
      await contexts
        .at(-1)
        ?.tracing.stop({ path: join(ctx.artifacts, "browser-retention-failure.zip") })
        .catch(() => {});
      throw error;
    } finally {
      for (const context of contexts) await context.close().catch(() => {});
      await browser.close();
    }
  });

  await scenario("tracker-retention-removes-closed-issues-and-replicas-converge", async () => {
    // CORE-203, in the real runtime: sam's own tracker gets a closed issue,
    // an open one and a gm replica; a retention run 400 days ahead (a dry run
    // first) removes the closed issue and prunes old activity, including an
    // event after the replica's cursor. The replica converges (the feed
    // answers 410 below its floor, so gm fetches a fresh snapshot), the open
    // issue stays, and the removed key answers 404 "removed by retention" in
    // the API, `gm issue show` and the browser.
    const owner = "sam";
    const token = fixtures.tokens.sam;
    const key = `R${randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase()}`;
    const team = randomUUID(),
      closed = randomUUID(),
      open = randomUUID();
    await json(`/api/tracker/${owner}/mutate`, token, "POST", {
      operationId: randomUUID(),
      mutations: [
        { kind: "team.create", id: team, data: { key, name: "Retention regression" } },
        { kind: "issue.create", id: closed, data: { teamId: team, title: "Finished long ago" } },
        { kind: "issue.create", id: open, data: { teamId: team, title: "Still open" } },
      ],
    });
    await json(`/api/tracker/${owner}/mutate`, token, "POST", {
      operationId: randomUUID(),
      mutations: [
        { kind: "issue.update", id: closed, expectedVersion: 1, data: { status: "done" } },
      ],
    });
    const keys = await json<Snapshot>(`/api/tracker/${owner}/snapshot`, token);
    const closedKey = keys.issues.find((issue) => issue.id === closed)?.key;
    const openKey = keys.issues.find((issue) => issue.id === open)?.key;
    assert(closedKey && openKey, "Both issues have keys");
    await gm(["tracker", "sync", "--owner", owner], "sam");
    await gm(["issue", "show", closedKey, "--owner", owner, "--offline"], "sam");
    // Two renames after the replica's cursor: retention prunes the first
    // (the team's newest event stays), which raises the feed's floor past it.
    for (const [version, name] of [
      [1, "Retention regression (renamed)"],
      [2, "Retention regression"],
    ] as const)
      await json(`/api/tracker/${owner}/mutate`, token, "POST", {
        operationId: randomUUID(),
        mutations: [{ kind: "team.update", id: team, expectedVersion: version, data: { name } }],
      });

    type Run = { run: { status: string; items: number; bytes: number; dryRun: boolean } };
    const secret = ctx.env.GITMATRIX_AGENT_SECRET ?? "";
    // Each category's dry run, then its run at the same moment: the same items.
    const removed: Record<string, number> = {};
    for (const [category, thresholds] of [
      ["closed-issues", { days: 365 }],
      ["tracker-activity", { eventDays: 365, endedTimelineDays: 180 }],
    ] as const) {
      const runs: Run["run"][] = [];
      for (const dryRun of [true, false])
        runs.push(
          (
            await json<Run>("/api/dev/retention", secret, "POST", {
              account: owner,
              categories: { [category]: thresholds },
              daysAhead: 400,
              dryRun,
            })
          ).run,
        );
      const [dry, real] = runs as [Run["run"], Run["run"]];
      assert.equal(dry.status, "succeeded", `${category}: dry run`);
      assert.equal(real.status, "succeeded", `${category}: run`);
      assert(dry.items > 0, `${category}: the dry run lists what the scenario made old`);
      assert.equal(real.items, dry.items, `${category}: the run removes what the dry run listed`);
      assert.equal(real.bytes, dry.bytes, `${category}: the same bytes`);
      removed[category] = real.items;
    }

    const after = await json<Snapshot>(`/api/tracker/${owner}/snapshot`, token);
    assert(!after.issues.some((issue) => issue.id === closed), "The closed issue is gone");
    assert(
      after.issues.some((issue) => issue.id === open),
      "The open issue stays",
    );
    const gone = JSON.parse(
      await request(
        `/api/tracker/${owner}/issues/${closedKey}/history?limit=1`,
        token,
        "GET",
        undefined,
        [404],
      ),
    ) as { code: string; error: string };
    assert.equal(gone.code, "removed_by_retention");
    assert.match(gone.error, /removed by retention/);

    // The replica's cursor is below the feed's new floor: it starts over.
    const stale = await request(
      `/api/tracker/${owner}/changes?after=0&limit=1`,
      token,
      "GET",
      undefined,
      [410],
    );
    assert.match(stale, /cursor_expired/);
    await gm(["tracker", "sync", "--owner", owner], "sam");
    const kept = JSON.parse(
      await gm(["issue", "show", openKey, "--owner", owner, "--offline"], "sam"),
    ) as { issue: { id: string } };
    assert.equal(kept.issue.id, open);
    await gm(
      ["issue", "show", closedKey, "--owner", owner, "--offline"],
      "sam",
      work,
      /tracker_not_found/,
    );
    await gm(["issue", "show", closedKey, "--owner", owner], "sam", work, /removed by retention/);
    // A new issue never takes the removed key, and the replica gets it.
    const fresh = randomUUID();
    await json(`/api/tracker/${owner}/mutate`, token, "POST", {
      operationId: randomUUID(),
      mutations: [{ kind: "issue.create", id: fresh, data: { teamId: team, title: "New" } }],
    });
    const freshKey = (await json<Snapshot>(`/api/tracker/${owner}/snapshot`, token)).issues.find(
      (issue) => issue.id === fresh,
    )?.key;
    assert(freshKey && freshKey !== closedKey, "The removed key is not reused");
    await gm(["tracker", "sync", "--owner", owner], "sam");
    await gm(["issue", "show", freshKey, "--owner", owner, "--offline"], "sam");

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: ctx.origin });
    const page = await context.newPage();
    try {
      const expect = playwrightExpect.configure({ timeout: 15_000 });
      await page.goto("/signin");
      await page.getByRole("button", { name: /Continue as sam/i }).click();
      await page.waitForURL((url) => url.pathname !== "/signin");
      await page.goto(`/tracker/${owner}/issues/${closedKey}`);
      await expect(page.getByRole("heading", { name: "Removed by retention" })).toBeVisible();
      await expect(page.getByText(`Issue ${closedKey} was removed by retention`)).toBeVisible();
      await page.screenshot({ path: join(ctx.artifacts, "browser-retention-removed-issue.png") });
    } catch (error) {
      await page
        .screenshot({ path: join(ctx.artifacts, "browser-retention-failure.png"), fullPage: true })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
      await browser.close();
    }
    record({ removed: closedKey, kept: openKey, items: removed });
  });

  await scenario("registry-retention-keeps-installs-working", async () => {
    // CORE-205, in the real runtime: the registry's site categories run 400
    // days ahead (a dry run first, the same items), then garbage collection
    // at that moment; every version the package scenario published still
    // downloads and installs, byte for byte.
    const secret = ctx.env.GITMATRIX_AGENT_SECRET ?? "";
    type Run = { run: { status: string; items: number; bytes: number } };
    const counts: Record<string, number> = {};
    for (const [category, days] of [
      ["registry-proxy-cache", 30],
      ["registry-audit", 365],
    ] as const) {
      const runs: Run["run"][] = [];
      for (const dryRun of [true, false])
        runs.push(
          (
            await json<Run>("/api/dev/retention", secret, "POST", {
              categories: { [category]: { days } },
              daysAhead: 400,
              dryRun,
              gc: !dryRun,
            })
          ).run,
        );
      const [dry, real] = runs as [Run["run"], Run["run"]];
      assert.equal(real.status, "succeeded", `${category}: run`);
      assert.equal(real.items, dry.items, `${category}: the run removes what the dry run listed`);
      assert.equal(real.bytes, dry.bytes, `${category}: the same bytes`);
      counts[category] = real.items;
    }
    assert(counts["registry-audit"]! > 0, "Old audit entries are removed");
    assert.equal(
      await request(`/generic/${repo.owner}/${packageName}/1.0.0/artifact.txt`, ownerToken),
      bytes,
      "A published file still downloads",
    );
    const executableName = `${packageName}-executable`;
    const binDir = join(work, "retention-bin");
    for (const version of ["1.0.0", "2.0.0"]) {
      await gm([
        "pkg",
        "install",
        executableName,
        "--owner",
        repo.owner,
        "--bin-dir",
        binDir,
        "--version",
        version,
        "--force",
      ]);
      const { stdout } = await promisify(execFile)(join(binDir, executableName), [], {
        cwd: work,
        env: ctx.env,
        timeout: 10_000,
      });
      assert.equal(stdout, `${executableName} ${version}\n`, `${version} still installs`);
    }
    record({ removed: counts, installed: ["1.0.0", "2.0.0"] });
  });

  await scenario("repository-deletion-purges-everything-and-resumes", async () => {
    // CORE-199, in the real runtime with real Artifacts: a repository with a
    // live timeline preview, a registry grant and pushed history is deleted.
    // It's missing at once; the purge Workflow tears the preview down with the
    // project's own teardown job (which still checks the repository out), is
    // killed mid-purge and resumed, and leaves nothing behind; then the name
    // is free again.
    interface Inventory {
      repo: { name: string; deletedAt: string | null } | null;
      d1: Record<string, number>;
      registry: { packageSources: number; publishes: number };
      durable: { class: string; name: string; purgedAt: string | null }[];
      artifacts: { name: string | null; exists: boolean | null };
      vectors: number | null;
      searchItems: number | null;
      previews: { live: number; teardownsOpen: number };
      deletion: {
        phase: string;
        workflowId: string | null;
        attempts: number;
        finishedAt: string | null;
        progress: {
          previews?: {
            groups: { timeline: string; run: { number: number } | null }[];
            timedOut?: number;
          };
          artifacts?: { deleted: boolean };
          links?: { sources: number };
          rows?: Record<string, number>;
        };
      } | null;
    }
    const secret = ctx.env.GITMATRIX_AGENT_SECRET ?? "";
    const name = `agent-delete-${randomUUID().slice(0, 8)}`;
    const doomed = `${repo.owner}/${name}`;
    const timeline = `delete-${randomUUID().slice(0, 8)}`;
    // The local runtime's D1 sometimes fails a query under load: retry a read.
    const inventory = async (): Promise<Inventory> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await json<Inventory>(
            `/api/dev/repo-inventory?repo=${encodeURIComponent(doomed)}`,
            secret,
          );
        } catch (error) {
          if (attempt === 3) throw error;
          await delay(1000);
        }
      }
    };
    const capability = randomUUID();
    let tornDown: string | undefined;
    let gate: ServerResponse | undefined;
    const collector = createServer((req, res) => {
      if (req.method === "GET" && req.url === `/${capability}/wait`) {
        gate = res;
        res.setTimeout(170_000, () => res.writeHead(504).end());
        return;
      }
      if (req.method !== "POST" || req.url !== `/${capability}`) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 256) req.destroy();
      });
      req.on("end", () => {
        tornDown = body;
        res.writeHead(204).end();
      });
    });
    const listening = Promise.withResolvers<void>();
    collector.once("error", listening.reject);
    collector.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = collector.address();
      assert(address && typeof address !== "string");
      await gm(["repo", "create", name, "--owner", repo.owner]);
      const clone = join(work, name);
      await gm(["clone", doomed, clone]);
      await writeFile(join(clone, "marker.txt"), "checked out by the teardown\n");
      await mkdir(join(clone, ".gitmatrix"), { recursive: true });
      // The teardown proves its checkout, reports, then holds until released.
      const teardown = [
        "test -f marker.txt",
        `curl --fail --silent --show-error --max-time 20 --data "$GITMATRIX_TIMELINE" http://127.0.0.1:${address.port}/${capability}`,
        `curl --fail --silent --show-error --max-time 180 http://127.0.0.1:${address.port}/${capability}/wait`,
      ].join("\n");
      await writeFile(
        join(clone, ".gitmatrix", "ci.yml"),
        JSON.stringify({
          on: { push: { branches: ["never-agent-auto"] }, preview: {} },
          jobs: {
            teardown: {
              if: 'trigger == "preview" && action == "teardown"',
              steps: [{ run: teardown }],
            },
          },
        }),
      );
      await gm(["commit", "-m", "Agent deletion fixture"], "marco", clone);
      await gm(["push", "--bookmark", "main"], "marco", clone);
      const detail = await json<RepoDetail>(`/api/repos/${doomed}`, ownerToken);
      const commit = detail.branches.find((b) => b.shortName === "main")?.oid;
      assert(commit, "The fixture's main was pushed");
      await gm([
        "deploy",
        "record",
        "--url",
        "https://agent-e2e.example.com/deleted-preview",
        "--timeline",
        timeline,
        "--commit",
        commit,
        "-R",
        doomed,
      ]);
      // A package the repository may publish: a registry grant that names it.
      const granted = `${name}-pkg`;
      const artifact = join(work, `${name}.txt`);
      await writeFile(artifact, "published before the repository was deleted\n");
      await gm(["pkg", "upload", artifact, `${granted}/1.0.0/artifact.txt`, "--owner", repo.owner]);
      await gm(["pkg", "grant", `generic/${granted}`, doomed, "--owner", repo.owner]);

      // The push log is written after the push answers (waitUntil), so wait for
      // its row rather than racing it under load (CORE-258).
      const before = await poll(
        inventory,
        (seen) => (seen.d1.ref_updates ?? 0) >= 1,
        "the push log to record the fixture's push",
        30_000,
      );
      assert.equal(before.repo?.deletedAt, null);
      assert.equal(before.artifacts.exists, true, "Its Artifacts repository exists");
      assert.deepEqual(before.previews, { live: 1, teardownsOpen: 0 });
      assert.equal(before.registry.packageSources, 1, "The registry grant names it");
      assert((before.d1.ref_updates ?? 0) >= 1, "The push log names it");
      record({ before });

      await request(`/api/repos/${doomed}`, ownerToken, "DELETE", undefined, [204]);
      // Missing to every reader at once; the name stays taken until the purge ends.
      await request(`/api/repos/${doomed}`, ownerToken, "GET", undefined, [404]);
      await gm(["clone", doomed, join(work, `${name}-again`)], "marco", work, /not found|404/i);
      const taken = await request(
        "/api/repos",
        ownerToken,
        "POST",
        { owner: repo.owner, name, visibility: "private" },
        [409],
      );
      assert.match(taken, /being deleted/);

      // The teardown run checked the deleted repository out and is held: the
      // purge waits in its previews phase. Kill it there, then resume it.
      await poll(async () => tornDown, Boolean, "the preview's teardown job");
      assert.equal(tornDown, timeline, "The teardown ran for the preview's timeline");
      await poll(async () => gate, Boolean, "the teardown's hold");
      const waiting = await poll(
        inventory,
        (value) => value.deletion?.phase === "previews" && Boolean(value.deletion.workflowId),
        "the purge waiting for its teardown",
      );
      assert.equal(waiting.deletion?.attempts, 1);
      assert.equal(waiting.previews.teardownsOpen, 1);
      const killed = await json<{ terminated: string; status: { status: string } }>(
        "/api/dev/repo-purge",
        secret,
        "POST",
        { repo: doomed, action: "terminate" },
      );
      assert.equal(killed.terminated, waiting.deletion?.workflowId);
      const resumed = await json<{ started: string[]; deletion: Inventory["deletion"] }>(
        "/api/dev/repo-purge",
        secret,
        "POST",
        { repo: doomed, action: "resume" },
      );
      assert.equal(resumed.started.length, 1, "The resume started a new purge");
      assert.equal(resumed.deletion?.attempts, 2);
      assert.notEqual(resumed.deletion?.workflowId, waiting.deletion?.workflowId);
      gate!.writeHead(204).end();

      const after = await poll(
        inventory,
        (value) => value.deletion?.phase === "done",
        "the resumed purge to finish",
        300_000,
      );
      assert.equal(after.repo, null, "The repository row is gone");
      assert.deepEqual(after.d1, {}, "No D1 row names it");
      assert.deepEqual(after.registry, { packageSources: 0, publishes: 0 });
      assert.equal(after.artifacts.exists, false, "Its Artifacts repository is deleted");
      assert.deepEqual(after.previews, { live: 0, teardownsOpen: 0 });
      for (const instance of after.durable)
        assert(instance.purgedAt, `${instance.class} ${instance.name} was purged`);
      assert(!after.vectors && !after.searchItems, "No vector or search item is left");
      const progress = after.deletion!.progress;
      assert.equal(progress.previews?.groups.length, 1);
      assert.equal(progress.previews?.groups[0]?.timeline, timeline);
      assert(progress.previews?.groups[0]?.run, "One teardown run was started");
      assert.equal(progress.previews?.timedOut, undefined, "The teardown finished in time");
      assert.equal(progress.artifacts?.deleted, true);
      assert.equal(progress.links?.sources, 1);
      record({ after });

      // Purged, the name is free again.
      await gm(["repo", "create", name, "--owner", repo.owner]);
      await request(`/api/repos/${doomed}`, ownerToken, "DELETE", undefined, [204]);
      await poll(
        inventory,
        (value) => value.deletion?.phase === "done" && value.repo === null,
        "the reused name's purge",
      );
    } finally {
      if (gate && !gate.writableEnded) gate.writeHead(204).end();
      collector.close();
    }
  });

  await scenario("assistant-chats-expire", async () => {
    // CORE-204, in the real runtime: jun turns on assistant chat expiration;
    // the chat list says when each chat expires; a run 100 days ahead (a dry
    // run first) purges the chat nobody used (its Durable Object through the
    // registry, which records it) and keeps the one used since. The browser's
    // list shows the expiry, then no longer shows the purged chat.
    const owner = "jun";
    const token = fixtures.tokens.jun;
    const secret = ctx.env.GITMATRIX_AGENT_SECRET ?? "";
    const tag = randomUUID().replaceAll("-", "").slice(0, 10);
    const stale = { id: `e2e-stale-${tag}`, title: `Stale chat ${tag}` };
    const used = { id: `e2e-used-${tag}`, title: `Used chat ${tag}` };
    const settings = `/api/accounts/${owner}/settings/retention`;
    type Chat = { id: string; title: string; expiresAt: string | null };
    const list = async () =>
      (await json<{ chats: Chat[] }>("/api/assistant/chats", token)).chats.filter((chat) =>
        chat.id.endsWith(tag),
      );
    await json("/api/dev/assistant-chat", secret, "POST", { account: owner, ...stale });
    // Used again "later": still active when the run's moment comes.
    await json("/api/dev/assistant-chat", secret, "POST", {
      account: owner,
      ...used,
      updatedAt: new Date(Date.now() + 95 * 86_400_000).toISOString(),
    });
    assert.deepEqual(
      (await list()).map((chat) => chat.expiresAt),
      [null, null],
      "No expiry while the policy is off",
    );
    await json(settings, token, "PATCH", { categories: { "assistant-chats": { enabled: true } } });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: ctx.origin });
    const page = await context.newPage();
    try {
      const expiring = await list();
      const staleExpiry = expiring.find((chat) => chat.id === stale.id)?.expiresAt;
      assert(staleExpiry, "The chat list says when the stale chat expires");
      const days = Math.round((Date.parse(staleExpiry) - Date.now()) / 86_400_000);
      assert.equal(days, 90, "Ninety days after its last use (the default)");

      const expect = playwrightExpect.configure({ timeout: 15_000 });
      // The dock remembers being open across page loads: open it only if it's closed.
      const conversations = async () => {
        await page.goto("/");
        const toggle = page.getByRole("button", { name: "Assistant", exact: true });
        await expect(toggle).toBeVisible();
        if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
        const dock = page.getByRole("complementary", { name: "Assistant" });
        await dock.getByRole("button", { name: "Conversations", exact: true }).click();
      };
      await page.goto("/signin");
      await page.getByRole("button", { name: /Continue as jun/i }).click();
      await page.waitForURL((url) => url.pathname !== "/signin");
      await conversations();
      const row = page.getByRole("button", { name: new RegExp(`^${stale.title}`) });
      await expect(row).toBeVisible();
      await expect(row).toContainText(/expires in (89|90) days/);
      await page.screenshot({ path: join(ctx.artifacts, "browser-assistant-chat-expiry.png") });

      type Run = { run: { status: string; items: number; bytes: number } };
      const runs: Run["run"][] = [];
      for (const dryRun of [true, false])
        runs.push(
          (
            await json<Run>("/api/dev/retention", secret, "POST", {
              account: owner,
              categories: { "assistant-chats": { days: 90, maxPerUser: 0 } },
              daysAhead: 100,
              dryRun,
            })
          ).run,
        );
      const [dry, real] = runs as [Run["run"], Run["run"]];
      assert.equal(real.status, "succeeded");
      assert(dry.items >= 1, "The dry run lists the stale chat");
      assert.equal(real.items, dry.items, "The run purges what the dry run listed");
      assert.equal(real.bytes, dry.bytes);

      assert.deepEqual(
        (await list()).map((chat) => chat.id),
        [used.id],
        "The stale chat is gone, the used one stays",
      );
      const purged = await json<{
        instance: { purged_at: string | null; purge_reason: string | null } | null;
        listed: boolean;
      }>("/api/dev/assistant-chat", secret, "POST", { account: owner, id: stale.id });
      assert.equal(purged.listed, false);
      assert(purged.instance?.purged_at, "The registry records the purge");
      assert.match(purged.instance?.purge_reason ?? "", /^retention: /);
      const kept = await json<{ instance: { purged_at: string | null } | null }>(
        "/api/dev/assistant-chat",
        secret,
        "POST",
        { account: owner, id: used.id },
      );
      assert.equal(kept.instance?.purged_at, null, "The used chat's object stays");

      await conversations();
      await expect(page.getByRole("button", { name: new RegExp(`^${used.title}`) })).toBeVisible();
      await expect(page.getByRole("button", { name: new RegExp(`^${stale.title}`) })).toHaveCount(
        0,
      );
      record({ purged: stale.id, kept: used.id, items: real.items, bytes: real.bytes });
    } catch (error) {
      await page
        .screenshot({
          path: join(ctx.artifacts, "browser-assistant-chat-failure.png"),
          fullPage: true,
        })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
      await browser.close();
      await request(settings, token, "PATCH", {
        categories: { "assistant-chats": { enabled: null } },
      }).catch(() => {});
      await request(`/api/assistant/chats/${used.id}`, token, "DELETE", undefined, [204]).catch(
        () => {},
      );
    }
  });

  await scenario("auth-hygiene-keeps-sign-in-and-tokens-working", async () => {
    // CORE-206, in the real runtime: a site administrator's dry run then run
    // of "auth-hygiene" removes sign-in state that ended a month ago; every
    // live token still authenticates, gm still works, and a browser sign-in
    // still lands.
    const written = await json<Record<string, string>>(
      "/api/dev/auth-expired",
      ctx.env.GITMATRIX_AGENT_SECRET ?? "",
      "POST",
      { account: "jun" },
    );
    const runs = "/api/admin/retention/runs";
    const admin = fixtures.tokens.priya;
    const hygiene = async (dryRun: boolean) => {
      const started = await json<{ id: number }>(
        runs,
        admin,
        "POST",
        { dryRun, categories: ["auth-hygiene"] },
        [202],
      );
      const done = await poll(
        () =>
          json<{ status: string; items: number; bytes: number }>(`${runs}/${started.id}`, admin),
        (r) => r.status !== "queued" && r.status !== "running",
        `auth hygiene run ${started.id}`,
      );
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      return done;
    };
    // Marco can't run site categories.
    await request(runs, ownerToken, "POST", { dryRun: true, categories: ["auth-hygiene"] }, [403]);
    const dry = await hygiene(true);
    assert(dry.items >= Object.keys(written).length, `The dry run lists them: ${dry.items}`);
    const removed = await hygiene(false);
    assert.equal(removed.items, dry.items, "The run removes what the dry run listed");
    assert.equal(removed.bytes, dry.bytes);
    assert.equal((await hygiene(true)).items, 0, "Nothing is left to remove");

    for (const persona of ["priya", "marco", "jun", "sam"] as const)
      await request(api, fixtures.tokens[persona]);
    await request(api, fixtures.readToken);
    await gm(["auth", "status"], "jun");

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: ctx.origin });
    const page = await context.newPage();
    try {
      const expect = playwrightExpect.configure({ timeout: 15_000 });
      await page.goto("/signin");
      await page.getByRole("button", { name: /Continue as jun/i }).click();
      await page.waitForURL((url) => url.pathname !== "/signin");
      await page.goto(`/${fullName}`);
      await expect(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();
    } finally {
      await context.close();
      await browser.close();
    }
    record({ written: Object.keys(written), dry: dry.items, removed: removed.items });
  });

  await scenario("push-log-retention-and-unreachable-git", async () => {
    // CORE-202 with real Artifacts, in jun's own account (the cleanup is
    // per account): a deleted branch leaves a commit no ref reaches.
    // Artifacts keeps it (it still serves it by id) and can't prune it, so
    // it's measured, not deleted: the usage figure counts its incompressible
    // blob. Push log retention, a year on, removes exactly the entries its dry
    // run listed, keeps main's latest, and every reachable ref, commit and
    // object is identical before and after.
    const owner = "jun";
    const token = fixtures.tokens.jun;
    const secret = ctx.env.GITMATRIX_AGENT_SECRET ?? "";
    const name = `agent-unreachable-${randomUUID().slice(0, 8)}`;
    const remote = `${ctx.origin}/${owner}/${name}.git`;
    const dir = join(work, name);
    const run = promisify(execFile);
    const gitEnv: NodeJS.ProcessEnv = {
      ...ctx.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${ctx.origin}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    };
    for (const key of Object.keys(gitEnv))
      if (/^GIT_CONFIG_(?:KEY|VALUE)_[1-9]/.test(key)) delete gitEnv[key];
    const git = async (args: string[], cwd = dir) =>
      (
        await run("git", args, { cwd, env: gitEnv, timeout: 90_000, maxBuffer: 16 << 20 })
      ).stdout.trim();
    await json(`/api/repos`, token, "POST", { owner, name, visibility: "private" }, [201]);
    await mkdir(dir);
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Agent Fixture"]);
    await git(["config", "user.email", "agent@gitmatrix.invalid"]);
    await writeFile(join(dir, "README.md"), "Reachable history.\n");
    await git(["add", "."]);
    await git(["commit", "-m", "Reachable"]);
    await git(["push", remote, "main"]);
    await git(["checkout", "-b", "doomed"]);
    const blobBytes = 96 * 1024;
    await writeFile(join(dir, "noise.bin"), randomBytes(blobBytes));
    await git(["add", "."]);
    await git(["commit", "-m", "Only the deleted branch reaches this"]);
    const doomed = await git(["rev-parse", "HEAD"]);
    // The push log records a push after answering it, by comparing the refs
    // with the last it saw: let it see the branch before it goes.
    const updates = async () =>
      (await json<RefUpdateList>(`/api/repos/${owner}/${name}/ref-updates`, token)).updates;
    await git(["push", remote, "doomed"]);
    await poll(updates, (list) => list.length === 2, "the push log's branch entry");
    await git(["push", remote, ":doomed"]);

    /** Every ref, every reachable object, and a full fsck, from a fresh mirror clone. */
    const reachable = async (label: string) => {
      const mirror = join(work, `${name}-${label}.git`);
      await git(["clone", "--mirror", remote, mirror], work);
      await git(["fsck", "--full", "--strict"], mirror);
      const refs = await git(["for-each-ref", "--format=%(refname) %(objectname)"], mirror);
      const objects = (await git(["rev-list", "--all", "--objects"], mirror)).split("\n").sort();
      const log = await git(["log", "--all", "--format=%H %T %P %an %ae %at %s"], mirror);
      return {
        refs,
        objects: createHash("sha256").update(objects.join("\n")).digest("hex"),
        count: objects.length,
        log,
      };
    };
    const before = await reachable("before");
    assert(!before.refs.includes("doomed"), "The branch is deleted");
    assert(!before.log.includes(doomed), "Its commit is unreachable");

    // Artifacts still serves the unreachable commit by id: it keeps it.
    const probe = join(work, `${name}-probe`);
    await mkdir(probe);
    await git(["init", "--bare"], probe);
    await git(["fetch", remote, doomed], probe);
    assert.equal(await git(["cat-file", "-t", doomed], probe), "commit");

    const logged = await poll(updates, (list) => list.length === 3, "the push log's entries");
    assert.deepEqual(
      logged
        .map((u) => [u.ref, Boolean(u.old), Boolean(u.new)] as const)
        .toSorted((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)),
      [
        ["refs/heads/doomed", false, true],
        ["refs/heads/doomed", true, false],
        ["refs/heads/main", false, true],
      ],
    );
    interface Figure {
      construct: string;
      item: string;
      metric: string;
      quantity: number;
      estimated: number;
      method: string;
    }
    const unreachable = async () => {
      const { figures } = await json<{ figures: Figure[] }>("/api/dev/usage", secret, "POST", {
        account: owner,
      });
      const figure = (metric: string) =>
        figures.find(
          (f) => f.construct === "artifacts" && f.item === "repositories" && f.metric === metric,
        );
      return { bytes: figure("unreachable_bytes"), objects: figure("unreachable_objects") };
    };
    const measured = await unreachable();
    assert(
      measured.bytes &&
        measured.bytes.quantity >= blobBytes &&
        measured.bytes.quantity < blobBytes + 8192,
      `The incompressible blob only the deleted branch reached is measured: ${JSON.stringify(measured.bytes)}`,
    );
    assert.equal(measured.bytes.estimated, 1, "Unreachable bytes are labelled estimated");
    assert.match(measured.bytes.method, /can't prune/);
    assert.equal(measured.objects?.quantity, 3, "Its commit, tree and blob");

    const cleanup = async (dryRun: boolean) =>
      (
        await json<{ run: { status: string; items: number; bytes: number } }>(
          "/api/dev/retention",
          secret,
          "POST",
          { account: owner, categories: { "push-log": { days: 365 } }, daysAhead: 400, dryRun },
        )
      ).run;
    const dry = await cleanup(true);
    assert.equal(dry.status, "succeeded");
    assert.equal((await updates()).length, 3, "A dry run removes nothing");
    const real = await cleanup(false);
    assert.equal(real.status, "succeeded");
    assert.deepEqual([real.items, real.bytes], [dry.items, dry.bytes], "The run is its dry run");
    const kept = await updates();
    assert.deepEqual(
      kept.map((u) => u.ref),
      ["refs/heads/main"],
      "Only main's latest entry, which explains its commit, stays",
    );

    const after = await reachable("after");
    assert.deepEqual(after, before, "Reachable history is identical before and after");
    // What nothing names any more isn't seen: the limitation the figure states.
    assert.equal((await unreachable()).bytes?.quantity, 0);
    record({ unreachable: measured, objects: before.count, cleanup: { dry, real } });
  });

  await scenario("browser-personas-persisted-product-state", async () => {
    // Hydration on the live dev server needs the same budget as page actions.
    const browserTimeout = 15_000;
    const expect = playwrightExpect.configure({ timeout: browserTimeout });
    const browser = await chromium.launch({ headless: true });
    const contexts: BrowserContext[] = [];
    try {
      for (const persona of ["marco", "sam"] as const) {
        const context = await browser.newContext({ baseURL: ctx.origin });
        contexts.push(context);
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        const page = await context.newPage();
        page.setDefaultTimeout(browserTimeout);
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
            // A single physical click must discard even after refocusing invalid text.
            // Locator.click() can retry a detached button and hide the blur/unmount race.
            await page.locator('[data-edit-field="title"]').click();
            const editor = page.getByRole("form", { name: "Edit Title", exact: true });
            const title = editor.getByRole("textbox", { name: "Title", exact: true });
            await title.fill("");
            await editor
              .getByText("Text saves when you leave a field. Selections save immediately.")
              .click();
            await expect(editor.getByRole("alert")).toHaveText("Give this issue a title.");
            await title.focus();
            const discard = editor.getByRole("button", { name: "Discard unsaved changes" });
            const discardBox = await discard.boundingBox();
            assert.ok(discardBox, "Discard must be visible");
            await page.mouse.click(
              discardBox.x + discardBox.width / 2,
              discardBox.y + discardBox.height / 2,
            );
            await expect(editor).toBeHidden();
            await page.reload();
            await expect(page.locator('[data-edit-field="title"]')).toHaveText(
              "Agent ready fixture",
            );
            await expect(editor).toHaveCount(0);
            record({
              discardedInvalidDraft: true,
              singlePointerClick: true,
              reloadAssertions: true,
            });
            // Hold actual server responses, never synthesize successful mutation echoes.
            // The editor must close optimistically, but acknowledgement waits for delivery.
            const description = `${"Large issue save regression. ".repeat(4000)}\n\nCORE-137 saved description`;
            const acceptance = "Both edits survive a delayed older snapshot.";
            let releaseSnapshot!: () => void;
            const released = new Promise<void>((resolve) => {
              releaseSnapshot = resolve;
            });
            let snapshotHeld = false;
            const snapshotPath = `/api/tracker/${fixtures.tracker.owner}/snapshot`;
            const mutationPath = `/api/tracker/${fixtures.tracker.owner}/mutate`;
            const descriptionEditor = page.getByRole("form", { name: "Edit Description / PRD" });
            const descriptionInput = descriptionEditor.getByRole("textbox", {
              name: "Description / PRD",
            });
            const descriptionEdit = page.locator('[data-edit-field="description"]');
            const descriptionView = page.locator('section[aria-label="Description / PRD"]');
            const updating = page.getByRole("status", {
              name: "Description / PRD updating",
              exact: true,
            });
            const updated = page.getByRole("status", {
              name: "Description / PRD updated",
              exact: true,
            });
            const mutationRelease = Promise.withResolvers<void>();
            let mutationHeld = false;
            let mutationStatus = 0;
            let mutationElapsedMs = 0;
            await page.route(
              `**${mutationPath}`,
              async (route) => {
                const started = performance.now();
                const response = await route.fetch();
                mutationElapsedMs = performance.now() - started;
                mutationStatus = response.status();
                mutationHeld = true;
                await mutationRelease.promise;
                await route.fulfill({ response });
              },
              { times: 1 },
            );
            await page.route(
              `**${snapshotPath}*`,
              async (route) => {
                const response = await route.fetch();
                snapshotHeld = true;
                await released;
                await route.fulfill({ response });
              },
              { times: 1 },
            );
            try {
              await descriptionEdit.click();
              await descriptionInput.fill(description);
              const closeStarted = performance.now();
              await descriptionEditor.getByRole("button", { name: "Done", exact: true }).click();
              await expect(descriptionEditor).toBeHidden();
              await expect(descriptionView).toContainText("CORE-137 saved description");
              await expect(updating).toBeVisible();
              await expect(updated).toHaveCount(0);
              const optimisticCloseMs = performance.now() - closeStarted;
              await expect.poll(() => mutationHeld).toBe(true);
              assert.equal(mutationStatus, 200);
              // Even a committed write is not Updated until its real response arrives.
              await expect(updating).toBeVisible();
              await expect(updated).toHaveCount(0);
              mutationRelease.resolve();
              await expect(updated).toBeVisible();
              await expect(updating).toHaveCount(0);
              await expect.poll(() => snapshotHeld).toBe(true);
              record({
                optimisticCloseMs,
                mutationElapsedMs,
                responseHeldUntilOptimisticClose: true,
              });
              await page.locator('[data-edit-field="acceptance"]').click();
              const acceptanceEditor = page.getByRole("form", { name: "Edit Acceptance criteria" });
              await acceptanceEditor
                .getByRole("textbox", { name: "Acceptance criteria" })
                .fill(acceptance);
              await acceptanceEditor.getByRole("button", { name: "Done", exact: true }).click();
              await expect(acceptanceEditor).toBeHidden();
              await expect(
                page.getByRole("status", { name: "Acceptance criteria updated", exact: true }),
              ).toBeVisible();
            } finally {
              mutationRelease.resolve();
              releaseSnapshot();
              await page.unrouteAll({ behavior: "wait" });
            }
            await expect(page.getByText(acceptance, { exact: true })).toBeVisible();
            const savedSnapshot = await json<Snapshot>(snapshotPath, fixtures.tokens.marco);
            const savedIssue = savedSnapshot.issues.find(
              (issue) => issue.id === fixtures.tracker.ready,
            );
            assert.equal(savedIssue?.description, description);
            assert.equal(savedIssue?.acceptance, acceptance);
            await page.reload();
            await expect(descriptionView).toContainText("CORE-137 saved description");
            await expect(page.getByText(acceptance, { exact: true })).toBeVisible();
            record({
              largeDescriptionBytes: Buffer.byteLength(description),
              saveFinishedBeforeRefresh: true,
              delayedSnapshotPreservedNewerSave: true,
              reloadAssertions: true,
            });
            // Blur commits the first edit; Done must retain a newer edit queued
            // behind it even though the form is no longer mounted.
            const blurDescription = "CORE-191 blur save already in flight.";
            const latestDescription = "CORE-191 latest queued description survives Done.";
            const queuedReleases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
            const queuedStatuses: number[] = [];
            let queuedRequests = 0;
            await page.route(
              `**${mutationPath}`,
              async (route) => {
                const index = queuedRequests++;
                const response = await route.fetch();
                queuedStatuses[index] = response.status();
                await queuedReleases[index]!.promise;
                await route.fulfill({ response });
              },
              { times: 2 },
            );
            try {
              await descriptionEdit.click();
              await descriptionInput.fill(blurDescription);
              await descriptionEditor.getByRole("button", { name: "Done", exact: true }).focus();
              await expect.poll(() => queuedStatuses[0]).toBe(200);
              await expect(descriptionEditor).toBeVisible();
              await descriptionInput.fill(latestDescription);
              await descriptionEditor.getByRole("button", { name: "Done", exact: true }).click();
              await expect(descriptionEditor).toBeHidden();
              await expect(descriptionView).toContainText(latestDescription);
              await expect(updating).toBeVisible();
              await expect(updated).toHaveCount(0);
              queuedReleases[0]!.resolve();
              await expect.poll(() => queuedStatuses[1]).toBe(200);
              await expect(descriptionView).toContainText(latestDescription);
              await expect(updating).toBeVisible();
              await expect(updated).toHaveCount(0);
              queuedReleases[1]!.resolve();
              await expect(updated).toBeVisible();
              await expect(updating).toHaveCount(0);
            } finally {
              for (const release of queuedReleases) release.resolve();
              await page.unrouteAll({ behavior: "wait" });
            }
            const queuedSnapshot = await json<Snapshot>(snapshotPath, fixtures.tokens.marco);
            assert.equal(
              queuedSnapshot.issues.find((issue) => issue.id === fixtures.tracker.ready)
                ?.description,
              latestDescription,
            );
            await page.reload();
            await expect(descriptionView).toContainText(latestDescription);
            record({ blurThenDoneQueuedSavePersisted: true, realMutationStatuses: queuedStatuses });

            // Delay sending the browser's write until a real competing write has
            // advanced its expectedVersion. The eventual 409 must not lose the draft
            // or advertise success, including when the user has already closed it.
            const failedDescription = "CORE-191 recover this conflicted local draft.";
            const competingDescription = "CORE-191 server-side competing description.";
            const conflictRelease = Promise.withResolvers<void>();
            const conflictRefreshRelease = Promise.withResolvers<void>();
            let conflictRefreshHeld = false;
            let conflictingRequestHeld = false;
            let conflictStatus = 0;
            await page.route(
              `**${mutationPath}`,
              async (route) => {
                conflictingRequestHeld = true;
                await conflictRelease.promise;
                const response = await route.fetch();
                conflictStatus = response.status();
                await route.fulfill({ response });
              },
              { times: 1 },
            );
            try {
              await descriptionEdit.click();
              await descriptionInput.fill(failedDescription);
              await descriptionEditor.getByRole("button", { name: "Done", exact: true }).click();
              await expect(descriptionEditor).toBeHidden();
              await expect(descriptionView).toContainText(failedDescription);
              await expect(updating).toBeVisible();
              await expect(updated).toHaveCount(0);
              await expect.poll(() => conflictingRequestHeld).toBe(true);
              const current = await json<Snapshot>(snapshotPath, fixtures.tokens.marco);
              const beforeConflict = current.issues.find(
                (issue) => issue.id === fixtures.tracker.ready,
              );
              assert.ok(beforeConflict);
              await mutateTracker(fixtures.tokens.marco, [
                {
                  kind: "issue.update",
                  id: beforeConflict.id,
                  expectedVersion: beforeConflict.version,
                  data: { description: competingDescription },
                },
              ]);
              // Rejection is already authoritative; refreshing conflict details must
              // not leave a known failed write looking like it is still Updating.
              await page.route(
                `**${snapshotPath}*`,
                async (route) => {
                  conflictRefreshHeld = true;
                  await conflictRefreshRelease.promise;
                  await route.continue();
                },
                { times: 1 },
              );
              conflictRelease.resolve();
              await expect.poll(() => conflictStatus).toBe(409);
              await expect.poll(() => conflictRefreshHeld).toBe(true);
              await expect(
                page.getByRole("button", { name: "Review draft", exact: true }),
              ).toBeVisible();
              await expect(descriptionEditor).toBeHidden();
              await expect(updating).toHaveCount(0);
              await expect(updated).toHaveCount(0);
              await expect(
                page
                  .getByRole("region", { name: "Save recovery", exact: true })
                  .getByRole("status")
                  .filter({ hasText: /^Not saved$/ }),
              ).toBeVisible();
              await page.getByRole("button", { name: "Review draft", exact: true }).click();
              await expect(descriptionInput).toHaveValue(failedDescription);
              const refreshedConflict = page.waitForResponse(
                (response) => new URL(response.url()).pathname === snapshotPath,
              );
              conflictRefreshRelease.resolve();
              const conflictRefreshResponse = await refreshedConflict;
              assert.equal(conflictRefreshResponse.status(), 200);
              assert.equal(await conflictRefreshResponse.finished(), null);
              await expect(descriptionInput).toHaveValue(failedDescription);
            } finally {
              conflictRelease.resolve();
              conflictRefreshRelease.resolve();
              await page.unrouteAll({ behavior: "wait" });
            }
            const conflictingSnapshot = await json<Snapshot>(snapshotPath, fixtures.tokens.marco);
            assert.equal(
              conflictingSnapshot.issues.find((issue) => issue.id === fixtures.tracker.ready)
                ?.description,
              competingDescription,
              "A failed optimistic write must not overwrite the competing server version",
            );
            // Reload proves draft recovery is durable, not just hidden textarea state.
            page.once("dialog", async (dialog) => {
              await dialog.accept();
            });
            await page.reload();
            await expect(descriptionInput).toHaveValue(failedDescription);
            await expect(updated).toHaveCount(0);
            await descriptionEditor.getByRole("button", { name: "Done", exact: true }).focus();
            await descriptionEditor
              .getByRole("button", { name: "Discard unsaved changes" })
              .click();
            await expect(descriptionEditor).toBeHidden();
            await expect(descriptionView).toContainText(competingDescription);
            await page.reload();
            await expect(descriptionView).toContainText(competingDescription);
            record({
              rejectedOptimisticCloseStatus: conflictStatus,
              knownRejectionVisibleBeforeConflictRefresh: true,
              competingWritePreserved: true,
              recoverableDraftAfterReload: true,
            });
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

  // The browser scenarios are a few journeys across the real stack. What a
  // page does with what it reads (the palette, the Atlas, the switcher's
  // scoping) is in apps/website's browser-mode tests: README "Testing".
  await scenario("browser-atlas-smoke", async () => {
    // CORE-171: a pushed repository's Atlas, projected by the Worker, read in
    // a real session down to the cited source in git.
    await atlasSmokeScenario({
      ctx,
      work,
      token: ownerToken,
      gm: (args, persona = "marco", cwd = work) => gm(args, persona, cwd),
      json,
      record,
    });
  });

  await scenario("atlas-revocation-reads-like-a-missing-repository", async () => {
    // CORE-178: a removed collaborator's still-valid Atlas links answer as a
    // repository that never existed.
    await atlasRevocationScenario({
      ctx,
      work,
      token: ownerToken,
      readerToken: fixtures.tokens.sam,
      gm: (args, persona = "marco", cwd = work) => gm(args, persona, cwd),
      json,
      record,
    });
  });

  await scenario("browser-timeline-scope-round-trip", async () => {
    // A real session carries the owned source through code links, then explicitly returns to main.
    const timelines = `/api/tracker/${fixtures.tracker.owner}/timelines`;
    const slug = `e2e-switch-${randomUUID().slice(0, 8)}`;
    const name = `Switcher ${slug.slice(-8)}`;
    const bookmark = "work";
    await json(timelines, fixtures.tokens.jun, "POST", { slug, name, repos: [fullName] }, [201]);
    const source = await timelineSource(slug);
    const detail = await json<RepoDetail>(api, ownerToken);
    assert.equal(
      await sourceTip(slug),
      detail.branches.find((b) => b.shortName === detail.defaultBranch)?.oid,
    );
    assert(!detail.branches.some((b) => b.shortName === `timeline/${slug}`));
    const browserTimeout = 15_000;
    const expect = playwrightExpect.configure({ timeout: browserTimeout });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: ctx.origin,
      viewport: { width: 1280, height: 800 },
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    page.setDefaultTimeout(browserTimeout);
    try {
      await page.goto("/signin");
      await page.getByRole("button", { name: /Continue as marco/i }).click();
      await page.waitForURL((url) => url.pathname !== "/signin");
      await page.goto(`/${fullName}`);
      const banner = page.getByRole("region", { name: "Timeline scope" });
      await expect(page.getByRole("link", { name: "README.md" }).first()).toBeVisible();
      await expect(banner).toHaveCount(0);

      await page.getByRole("button", { name: /^Timeline: main/ }).click();
      await page.getByRole("link", { name: new RegExp(name) }).click();
      await page.waitForURL((url) => url.searchParams.get("tl") === slug);
      await expect(banner).toBeVisible();
      await expect(page.getByLabel("Branch or tag")).toContainText(bookmark);
      // The listing is git's, at the bookmark.
      await expect(page.getByRole("link", { name: "README.md" }).first()).toBeVisible();
      assert.equal(new URL(page.url()).searchParams.get("source"), source.sourceId);
      await page.getByRole("link", { name: "README.md" }).first().click();
      await page.waitForURL((url) => url.pathname.includes("/blob/"));
      assert.equal(new URL(page.url()).searchParams.get("source"), source.sourceId);

      await page.goto(`/tracker/${fixtures.tracker.owner}/timelines?tl=${slug}`);
      const flag = page.getByRole("switch", { name: "Experimental" });
      await expect(flag).toHaveAttribute("aria-checked", "false");
      await flag.click();
      await expect(flag).toHaveAttribute("aria-checked", "true");
      await expect
        .poll(async () => {
          const listed = await json<{ timelines: { slug: string; experimental: boolean }[] }>(
            timelines,
            ownerToken,
          );
          return listed.timelines.find((t) => t.slug === slug)?.experimental;
        })
        .toBe(true);

      await banner.getByRole("link", { name: "Back to main" }).click();
      await page.waitForURL((url) => url.searchParams.get("tl") === "main");
      assert.equal(new URL(page.url()).searchParams.get("source"), null);
      await expect(banner).toHaveCount(0);
      await context.tracing.stop();
      record({ timeline: slug, source, bookmark, flagged: true });
    } catch (error) {
      await page
        .screenshot({ path: join(ctx.artifacts, "browser-timeline-failure.png"), fullPage: true })
        .catch(() => {});
      await context.tracing
        .stop({ path: join(ctx.artifacts, "browser-timeline-failure.zip") })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
      await browser.close();
      await request(`${timelines}/${slug}/abandon`, fixtures.tokens.jun, "POST").catch(() => {});
    }
  });
  await scenario("retention-concurrent-with-pushes-builds-and-chats", async () => {
    // CORE-211, in the real runtime: real cleanups (dated a year ahead, so
    // nearly everything is old enough) run again and again in jun's account
    // while jun pushes to two branches, a CI build runs, and new chats are
    // made. Afterwards every push landed (refs, objects, fsck), the build
    // finished and is kept as its ref's latest, every new chat is there and
    // only the long-idle ones are gone, each ref keeps its latest push log
    // entry, every run succeeded, and a final run then dry run find nothing
    // left. Last in the suite: it ages jun's account a year.
    const owner = "jun";
    const token = fixtures.tokens.jun;
    const secret = ctx.env.GITMATRIX_AGENT_SECRET ?? "";
    const name = `agent-concurrency-${randomUUID().slice(0, 8)}`;
    const remote = `${ctx.origin}/${owner}/${name}.git`;
    const repoApi = `/api/repos/${owner}/${name}`;
    const dir = join(work, name);
    const run = promisify(execFile);
    const gitEnv: NodeJS.ProcessEnv = {
      ...ctx.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${ctx.origin}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    };
    for (const key of Object.keys(gitEnv))
      if (/^GIT_CONFIG_(?:KEY|VALUE)_[1-9]/.test(key)) delete gitEnv[key];
    const git = async (args: string[], cwd = dir) =>
      (
        await run("git", args, { cwd, env: gitEnv, timeout: 90_000, maxBuffer: 16 << 20 })
      ).stdout.trim();
    await json(`/api/repos`, token, "POST", { owner, name, visibility: "private" }, [201]);
    await mkdir(join(dir, ".gitmatrix"), { recursive: true });
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.name", "Agent Fixture"]);
    await git(["config", "user.email", "agent@gitmatrix.invalid"]);
    // JSON is a YAML subset; manual runs only.
    await writeFile(
      join(dir, ".gitmatrix", "ci.yml"),
      JSON.stringify({
        on: { push: { branches: ["never-agent-auto"] } },
        jobs: { build: { steps: [{ run: "sleep 2; printf 'concurrent build\\n'" }] } },
      }),
    );
    await writeFile(join(dir, "README.md"), "Concurrency.\n");
    await git(["add", "."]);
    await git(["commit", "-m", "Start"]);
    await git(["push", remote, "main"]);
    await git(["push", remote, "main:work"]);
    await git(["branch", "work"]);

    // Long-idle chats the cleanup may take, and the thresholds it runs with.
    const tag = randomUUID().replaceAll("-", "").slice(0, 8);
    const idle = [`conc-idle-a-${tag}`, `conc-idle-b-${tag}`];
    for (const id of idle)
      await json("/api/dev/assistant-chat", secret, "POST", {
        account: owner,
        id,
        title: `Idle ${id}`,
        updatedAt: new Date(Date.now() - 12 * 365 * 86_400_000).toISOString(),
      });
    const categories = {
      "push-log": { days: 365 },
      "ci-logs": { days: 30 },
      "ci-runs": { days: 180, keepLatest: 1 },
      "preview-records": { days: 30 },
      "assistant-chats": { days: 3650, maxPerUser: 0 },
    };
    type DevRun = {
      run: {
        status: string;
        items: number;
        categories: { category: string; items: number; error: string | null }[];
      };
    };
    const cleanup = (dryRun: boolean) =>
      json<DevRun>("/api/dev/retention", secret, "POST", {
        account: owner,
        categories,
        daysAhead: 400,
        dryRun,
      });

    const fresh: string[] = [];
    const pushed: Record<"main" | "work", string> = { main: "", work: "" };
    let settled = false;
    const concurrent = Promise.all([
      // A CI build of main.
      (async () => {
        const number = (
          await json<{ number: number }>(
            `${repoApi}/ci/runs`,
            token,
            "POST",
            { ref: "main" },
            [201],
          )
        ).number;
        return poll(
          () => json<CiRunDetail>(`${repoApi}/ci/runs/${number}`, token),
          (r) => !["queued", "running"].includes(r.status),
          "the concurrent build",
        );
      })(),
      // Pushes to both branches.
      (async () => {
        for (let i = 0; i < 4; i++)
          for (const branch of ["main", "work"] as const) {
            await git(["checkout", "-q", branch]);
            await writeFile(join(dir, `${branch}.txt`), `${branch} ${i} ${randomUUID()}\n`);
            await git(["add", "."]);
            await git(["commit", "-q", "-m", `${branch} ${i}`]);
            await git(["push", remote, `HEAD:${branch}`]);
            pushed[branch] = await git(["rev-parse", "HEAD"]);
          }
      })(),
      // New chats.
      (async () => {
        for (let i = 0; i < 4; i++) {
          const id = `conc-fresh-${i}-${tag}`;
          await json("/api/dev/assistant-chat", secret, "POST", {
            account: owner,
            id,
            title: `Fresh ${id}`,
          });
          fresh.push(id);
        }
      })(),
    ]).finally(() => {
      settled = true;
    });
    const [runs, [build]] = await Promise.all([
      // Cleanups, back to back, for as long as the rest is going (at least 4).
      (async () => {
        const done: DevRun["run"][] = [];
        while (!settled || done.length < 4) done.push((await cleanup(false)).run);
        return done;
      })(),
      concurrent,
    ]);
    for (const r of runs)
      assert.equal(
        r.status,
        "succeeded",
        `Every concurrent cleanup succeeded: ${JSON.stringify(r)}`,
      );
    assert.equal(build.status, "succeeded", "The build finished");
    const kept = await json<CiRunDetail>(`${repoApi}/ci/runs/${build.number}`, token);
    assert.equal(kept.number, build.number, "The build is its ref's latest run, kept");

    // Every push landed: refs at the last pushed commits, history whole, fsck clean.
    const mirror = join(work, `${name}-after.git`);
    await git(["clone", "--mirror", remote, mirror], work);
    await git(["fsck", "--full", "--strict"], mirror);
    const refs = await git(["for-each-ref", "--format=%(refname) %(objectname)"], mirror);
    for (const branch of ["main", "work"] as const)
      assert(
        refs.includes(`refs/heads/${branch} ${pushed[branch]}`),
        `${branch} is at its last push`,
      );
    const subjects = (await git(["log", "--all", "--format=%s"], mirror)).split("\n");
    for (let i = 0; i < 4; i++)
      for (const branch of ["main", "work"])
        assert(subjects.includes(`${branch} ${i}`), `${branch} ${i} is in the history`);

    // Chats: every new one is there; only the long-idle ones are gone.
    const chats = (await json<{ chats: { id: string }[] }>("/api/assistant/chats", token)).chats;
    for (const id of fresh)
      assert(
        chats.some((c) => c.id === id),
        `${id} survives`,
      );
    for (const id of idle) assert(!chats.some((c) => c.id === id), `${id} was cleaned up`);

    // The push log keeps each live ref's latest entry (recorded after each push).
    const latest = await poll(
      async () => (await json<RefUpdateList>(`${repoApi}/ref-updates`, token)).updates,
      (updates) =>
        (["main", "work"] as const).every((b) =>
          updates.some((u) => u.ref === `refs/heads/${b}` && u.new === pushed[b]),
        ),
      "each ref's latest push log entry",
    );
    record({ refUpdates: latest.length });

    // Then nothing is left for the same cleanup: a run, and a dry run after it, at that moment.
    const last = (await cleanup(false)).run;
    const after = (await cleanup(true)).run;
    assert.equal(after.status, "succeeded");
    assert.equal(after.items, 0, `Nothing left: ${JSON.stringify(after.categories)}`);
    const remaining = (await json<RefUpdateList>(`${repoApi}/ref-updates`, token)).updates;
    for (const branch of ["main", "work"] as const)
      assert(
        remaining.some((u) => u.ref === `refs/heads/${branch}` && u.new === pushed[branch]),
        `${branch} keeps its latest push log entry after the cleanups`,
      );
    assert(
      runs.reduce((sum, r) => sum + r.items, 0) + last.items > idle.length,
      "The cleanups removed push log entries and run records, not only the idle chats",
    );
    record({
      cleanups: [...runs.map((r) => r.items), last.items],
      refUpdatesAfter: remaining.length,
      build: build.number,
      pushes: 8,
      chats: { fresh: fresh.length, idleRemoved: idle.length },
    });
  });
  await scenario("source-authorization-native-and-canonical-separation", () =>
    runSourceAuthE2E(ctx, fixtures, gm, record),
  );
  await scenario("source-multi-repository-landing-and-durable-recovery", () =>
    runSourceLandingE2E(ctx, fixtures, gm, record),
  );
  await scenario("source-late-sync-lineage-conflicts-guard-and-expiry", () =>
    runSourceSyncE2E(ctx, fixtures, gm, record),
  );
  await scenario("source-finite-legacy-migration-and-partial-revert", () =>
    runSourceMigrationE2E(ctx, fixtures, gm, record),
  );
  await scenario("source-retention-expiry-orphan-and-canonical-purge", () =>
    runSourceRetentionE2E(ctx, fixtures, gm, record),
  );

  await scenario("browser-chronicle-scrub-range-span-and-links", async () => {
    // CORE-251: a month of real tracker history read on a time axis, at
    // desktop and phone widths (tools/agent/chronicle-e2e.ts).
    await chronicleScenario({
      ctx,
      token: ownerToken,
      secret: ctx.env.GITMATRIX_AGENT_SECRET ?? "",
      json,
      record,
    });
  });
}
