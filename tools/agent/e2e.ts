import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
  RepoDetail,
} from "../../apps/website/shared/api.ts";
import type { Published } from "../../apps/website/shared/packages.ts";
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

  await scenario("timeline-fork-bookmark-and-abandon-permissions", async () => {
    // A writer forks a timeline from main: the bookmark exists in Artifacts at
    // main's tip. Only its accountable person may abandon it, which deletes the
    // bookmark and keeps the record and its events.
    const timelines = `/api/tracker/${fixtures.tracker.owner}/timelines`;
    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    const bookmark = `timeline/${slug}`;
    const jun = fixtures.tokens.jun;
    await request(timelines, fixtures.tokens.sam, "POST", { slug, repos: [fullName] }, [403]);
    const before = await json<RepoDetail>(api, ownerToken);
    const created = await json<{
      timeline: { id: string; slug: string; forkPoint: { commits: Record<string, string> } };
      bookmarks: { ok: boolean }[];
    }>(timelines, jun, "POST", { slug, repos: [fullName] }, [201]);
    assert(
      created.bookmarks.every((b) => b.ok),
      "Every bookmark must be created",
    );
    const forked = Object.values(created.timeline.forkPoint.commits)[0];
    const main = before.branches.find((b) => b.shortName === before.defaultBranch)?.oid;
    assert.equal(forked, main, "A fork from main starts at the default branch's tip");
    await poll(
      () => json<RepoDetail>(api, ownerToken),
      (detail) => detail.branches.some((b) => b.shortName === bookmark && b.oid === forked),
      "the timeline bookmark",
    );
    await request(timelines, jun, "POST", { slug, repos: [fullName] }, [409]);
    await request(`${timelines}/${slug}/abandon`, ownerToken, "POST", undefined, [403]);
    const abandoned = await json<{ timeline: { status: string }; bookmarks: { ok: boolean }[] }>(
      `${timelines}/${slug}/abandon`,
      jun,
      "POST",
    );
    assert.equal(abandoned.timeline.status, "abandoned");
    assert(abandoned.bookmarks.length === 1 && abandoned.bookmarks[0]!.ok, "Bookmark deleted");
    await poll(
      () => json<RepoDetail>(api, ownerToken),
      (detail) => !detail.branches.some((b) => b.shortName === bookmark),
      "the bookmark's deletion",
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
    record({ timeline: slug, forked, abandoned: true });
  });

  await scenario("gm-timeline-start-push-and-abandon", async () => {
    // gm forks a timeline through the API and binds a fresh clone to it: a
    // plain `gm push` lands on timeline/<slug>, main is refused, and
    // abandoning puts the checkout back on main.
    const owner = fixtures.tracker.owner;
    const slug = `gm-e2e-${randomUUID().slice(0, 8)}`;
    const bookmark = `timeline/${slug}`;
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

    await writeFile(join(clone, "timeline-e2e.txt"), "timeline work\n");
    await gm(["commit", "-m", "Timeline work from gm"], "jun", clone);
    const pushed = JSON.parse(await gm(["push"], "jun", clone)) as { bookmark: string };
    assert.equal(pushed.bookmark, bookmark, "A bound checkout pushes to its timeline");
    const tip = await poll(
      () => json<RepoDetail>(api, ownerToken),
      (detail) => detail.branches.some((b) => b.shortName === bookmark && b.oid !== main),
      "the pushed timeline bookmark",
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

    // Only its accountable person (or the agent that started it) abandons it.
    await gm(["timeline", "abandon", "--owner", owner], "marco", clone, /"forbidden"/);
    const abandoned = JSON.parse(
      await gm(["timeline", "abandon", "--owner", owner], "jun", clone),
    ) as { timeline: { status: string }; use: { previous: string } };
    assert.equal(abandoned.timeline.status, "abandoned");
    assert.equal(abandoned.use.previous, slug, "Abandoning unbinds the checkout");
    assert.doesNotMatch(await binding(), /timeline:/);
    await poll(
      () => json<RepoDetail>(api, ownerToken),
      (detail) => !detail.branches.some((b) => b.shortName === bookmark),
      "the abandoned bookmark's deletion",
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
    await gm(["agent", "revoke", other.agent.id]);
    await gm(["agent", "revoke", agent.id]);
    record({
      agent: name,
      model: capabilities.model,
      tags: capabilities.tags,
      selfRefreshPreservedDeclarations: true,
      trackerCapabilitiesVisible: true,
      claimIdentity: claimed.issue.claim.actorId,
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

  await scenario("browser-global-search-palette", async () => {
    const browserTimeout = 15_000;
    const expect = playwrightExpect.configure({ timeout: browserTimeout });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: ctx.origin });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    page.setDefaultTimeout(browserTimeout);
    try {
      await page.goto("/signin");
      await page.getByRole("button", { name: /Continue as marco/i }).click();
      await page.waitForURL((url) => url.pathname !== "/signin");
      await page.goto(`/${fullName}`);
      await expect(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();
      const dialog = page.getByRole("dialog", { name: "Search" });
      const input = page.getByRole("combobox", { name: "Search or go to" });

      // The visible control opens it with focus in the query; Escape gives focus back.
      const button = page.getByRole("button", { name: "Search", exact: true });
      await button.click();
      await expect(input).toBeFocused();
      await expect(page.getByRole("group", { name: `In ${fullName}` })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(button).toBeFocused();

      // Ctrl+K, a real search, exact identifier first, Enter navigates and closes.
      await page.keyboard.press("Control+k");
      await input.fill(`${publicRepo.owner}/${publicRepo.name}`);
      await expect(page.getByRole("option", { selected: true })).toContainText(
        `${publicRepo.owner}/${publicRepo.name}`,
      );
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      await page.waitForURL((url) => url.pathname === `/${publicRepo.owner}/${publicRepo.name}`);

      // A private repository marco can't read never appears.
      await page.keyboard.press("Control+k");
      await input.fill(`${outsiderRepo.owner}/${outsiderRepo.name}`);
      await expect(
        dialog.getByText(`Nothing matches “${outsiderRepo.owner}/${outsiderRepo.name}”.`),
      ).toBeVisible();
      await page.keyboard.press("Escape");

      // Issues from the trackers marco belongs to, closed ones included, open their page.
      await page.keyboard.press("Control+k");
      await input.fill("Agent ready fixture");
      const issues = page.getByRole("group", { name: "Issues" });
      await expect(issues.getByRole("option").first()).toContainText("Agent ready fixture");
      await expect(issues.getByRole("option").first()).toContainText(fixtures.tracker.owner);
      await page.keyboard.press("Enter");
      await page.waitForURL(
        (url) =>
          url.pathname === `/tracker/${fixtures.tracker.owner}/issues/${fixtures.tracker.ready}`,
      );
      await expect(page.getByText("Agent ready fixture", { exact: true }).first()).toBeVisible();

      // The package published earlier, by its qualified name, opens its console page.
      await page.keyboard.press("Control+k");
      await input.fill(`${repo.owner}/${packageName}`);
      const packages = page.getByRole("group", { name: "Packages" });
      await expect(packages.getByRole("option").first()).toContainText(packageName);
      await page.keyboard.press("Enter");
      await page.waitForURL(
        (url) => url.pathname === `/${repo.owner}/-/packages/generic/${packageName}`,
      );
      await expect(page.getByRole("heading", { name: packageName, exact: true })).toBeVisible();

      // Signed out: navigation only, and no search requests.
      await context.clearCookies();
      let searched = 0;
      page.on("request", (request) => {
        if (request.url().includes("/api/search")) searched++;
      });
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("Control+k");
      const goTo = page.getByRole("combobox", { name: "Go to" });
      await expect(goTo).toBeFocused();
      await goTo.fill("sign");
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.pathname === "/signin");
      assert.equal(searched, 0, "Signed-out palette must not search");
      await context.tracing.stop();
      record({ persona: "marco", signedOut: true, independentContext: true });
    } catch (error) {
      await page
        .screenshot({ path: join(ctx.artifacts, "browser-palette-failure.png"), fullPage: true })
        .catch(() => {});
      await context.tracing
        .stop({ path: join(ctx.artifacts, "browser-palette-failure.zip") })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
