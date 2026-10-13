// A timeline's observability view (CORE-396) in a real browser, against the
// in-memory API: vitals, one lane per author with health and steering marks,
// checkpoints above, a step the live feed brings arriving without a reload,
// the span inspector with CI's jobs by duration, and a phone width.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { StepFeedRecord, StepUpload } from "../../../shared/steps.ts";
import { commitId, sidewaysOverflow } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { checkpoint, ciRun, deployment, timelineWorld } from "../../testing/timelines.ts";

test("observability: vitals, lanes by author, checkpoints, live arrival, the span inspector", async () => {
  const server = await TestServer.start({ world: true });
  const world = await timelineWorld(server, { slug: "search", name: "Search v2" });
  const repo = world.repos[0]!;
  const { agent } = await server.call<{ agent: { id: string } }>("POST", "/api/agents", {
    name: "builder",
  });
  const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  const [index, rank, retry] = [commitId(), commitId(), commitId()];
  const upload = (over: Partial<StepUpload>): StepUpload => ({
    changeId: `change${over.commitOid}`,
    commitOid: commitId(),
    summary: "",
    committedAt: minutes(60),
    timeline: world.slug,
    issue: "ENG-1",
    instructions: [],
    steering: [],
    why: "",
    challenges: "",
    tests: [],
    coverage: { instructions: "hook:claude-code", steering: "hook:claude-code" },
    harness: "claude-code",
    model: null,
    ...over,
  });
  // The agent's two steps, then a person's own.
  for (const step of [
    upload({
      commitOid: index,
      summary: "Add the search index",
      committedAt: minutes(90),
      why: "Search reads from an index, not the table.",
      instructions: [{ text: "Make search fast", source: "hook" }],
      tests: [{ command: "vp test run search", exit: 0, summary: "9 passed", origin: "local" }],
    }),
    upload({
      commitOid: rank,
      summary: "Rank results by recency",
      committedAt: minutes(40),
      why: "People look for what changed lately.",
      steering: [{ text: "keep score as the tie-breaker", source: "hook", at: minutes(45) }],
      model: "claude-opus-5-5",
      tests: [{ command: "vp test run search", exit: 0, summary: "12 passed", origin: "local" }],
    }),
  ])
    await server.callAsAgent(agent.id, "POST", "/api/repos/orbit/engine/steps", step);
  await server.call(
    "POST",
    "/api/repos/orbit/engine/steps",
    upload({ commitOid: retry, summary: "Retry the flaky ranking test", committedAt: minutes(20) }),
  );
  // CI's step run on the ranking step failed its unit job.
  const run = await ciRun(server, {
    repo,
    number: 12,
    commit: rank,
    ref: repo.sourceRef,
    sourceId: repo.sourceId,
    status: "failed",
  });
  await server.sql(
    `INSERT INTO step_artifacts (id, repo_id, commit_oid, run_id, kind, data, created_at)
     VALUES (?, ?, ?, ?, 'test-summary', ?, ?)`,
    `${run}:test-summary`,
    repo.id,
    rank,
    run,
    JSON.stringify({
      status: "failed",
      passed: 1,
      failed: 1,
      jobs: [
        { name: "step-check", status: "succeeded", exitCode: 0, durationMs: 42_000 },
        { name: "step-unit", status: "failed", exitCode: 1, durationMs: 95_000 },
      ],
    }),
    minutes(35),
  );
  // A step an admin removed: it never shows, though the feed still carries it.
  const removed = commitId();
  await server.callAsAgent(
    agent.id,
    "POST",
    "/api/repos/orbit/engine/steps",
    upload({
      commitOid: removed,
      summary: "Paste the API key into the config",
      committedAt: minutes(30),
    }),
  );
  await server.call("DELETE", `/api/repos/orbit/engine/steps/change${removed}/${removed}`);
  const view = await checkpoint(server, world, "Ranking by recency");
  await deployment(server, view, repo, { status: "active", url: "https://search.example" });

  // The live feed: the steps already loaded, then a new one from the agent.
  const feed: StepFeedRecord[] = [
    {
      seq: 1,
      repo: "orbit/engine",
      timeline: world.slug,
      changeId: `change${removed}`,
      commitOid: removed,
      summary: "Paste the API key into the config",
      issue: "ENG-1",
      author: { id: agent.id, kind: "agent", name: "builder" },
      tests: null,
      why: "",
      committedAt: minutes(30),
      at: minutes(30),
    },
  ];
  // Steps the feed later says an admin deleted (CORE-399).
  const removals: StepFeedRecord[] = [];
  server.on("GET", "/api/repos/:owner/:name/steps/live", () => {
    const body =
      feed
        .map((record) => `id: ${record.seq}\nevent: step\ndata: ${JSON.stringify(record)}\n\n`)
        .join("") +
      removals
        .map(
          ({ repo, changeId, commitOid }) =>
            `event: removed\ndata: ${JSON.stringify({ repo, changeId, commitOid })}\n\n`,
        )
        .join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });

  const app = renderApp(`/tracker/orbit/timelines?tl=${world.slug}`);
  const observed = page.getByRole("region", { name: "Observability" });
  const vitals = observed.getByLabelText("Vitals");
  await expect.element(vitals).toMatchTextContent(/steps\s*3(?!\d)/);
  // 9 + 12 local passes and CI's one pass, against CI's one failure.
  await expect.element(vitals).toMatchTextContent(/checks passing \(3 of 4\)\s*75%/);
  await expect.element(vitals).toMatchTextContent(/times a person steered\s*1(?!\d)/);
  await expect.element(vitals).toMatchTextContent(/steps that say why\s*67%/);
  await expect.element(vitals).toMatchTextContent(/checkpoints, preview live\s*1(?!\d)/);
  await expect.element(vitals).toMatchTextContent(/authors\s*2(?!\d)/);

  // Each label, then its value (shown above it).
  // A lane per author, the most recently active first; each step a button.
  const builder = observed.getByRole("list", { name: "builder's steps" });
  expect(builder.getByRole("button").elements()).toHaveLength(2);
  await expect
    .element(
      builder.getByRole("button", {
        name: /^Rank results by recency, a check failed, steered once/,
      }),
    )
    .toBeVisible();
  await expect
    .element(builder.getByRole("button", { name: /^Add the search index, checks pass,/ }))
    .toBeVisible();
  const lanes = observed.getByRole("list", { name: /'s steps$/ }).elements();
  expect(lanes[0]!.getAttribute("aria-label")).not.toBe("builder's steps");
  await expect
    .element(observed.getByRole("listitem", { name: "Checkpoint #1, preview live" }))
    .toBeVisible();

  // The newest step is inspected first; picking another shows its context and CI.
  const span = observed.getByRole("region", { name: "Span" });
  await expect.element(span).toMatchTextContent(/Retry the flaky ranking test/);
  await userEvent.click(builder.getByRole("button", { name: /^Rank results by recency/ }));
  await expect.element(span).toMatchTextContent(/People look for what changed lately\./);
  // Which harness and model made it, and when the person steered it (CORE-397, CORE-398).
  await expect.element(span).toMatchTextContent(/claude-code running claude-opus-5-5/);
  const steeredClock = new Date(Date.parse(minutes(45))).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  await expect.element(span.getByRole("time").filter({ hasText: steeredClock })).toBeVisible();
  await expect
    .element(
      builder.getByRole("button", { name: new RegExp(`steered once \\(at ${steeredClock}\\)`) }),
    )
    .toBeVisible();
  expect(
    builder.element().querySelectorAll('[title^="Steered "]'),
    "the moment is marked on the lane",
  ).toHaveLength(1);
  await expect
    .element(span)
    .toMatchTextContent(/“keep score as the tie-breaker”\s*captured by the harness/);
  const jobs = span.getByRole("list", { name: "CI jobs" });
  await expect.element(jobs).toMatchTextContent(/step-check\s*42s/);
  await expect.element(jobs).toMatchTextContent(/step-unit\s*1m 35s/);
  // The jobs ran independently: compared by duration, never summed.
  await expect
    .element(span)
    .toMatchTextContent(/CI step run:\s*failed · its longest job took 1m 35s/);
  const story = span.getByRole("link", { name: "Open in Story" });
  const target = new URL(story.element().getAttribute("href")!, location.origin);
  expect(target.pathname).toBe(`/tracker/orbit/timelines/${world.slug}/story`);
  expect(target.searchParams.get("step")).toBe(rank);
  expect(target.searchParams.get("repo")).toBe("orbit/engine");

  // A step the live feed brings appears without a reload, marked new and announced.
  feed.push({
    seq: 9,
    repo: "orbit/engine",
    timeline: world.slug,
    changeId: "livechange",
    commitOid: commitId(),
    summary: "Keep score as tie-breaker",
    issue: "ENG-1",
    author: { id: agent.id, kind: "agent", name: "builder" },
    tests: { passed: 4, failed: 0 },
    why: "Ties need an order.",
    committedAt: minutes(1),
    at: minutes(1),
  });
  await expect
    .poll(
      () =>
        builder
          .getByRole("button", { name: /^Keep score as tie-breaker, checks pass, .*, new$/ })
          .elements().length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await expect
    .element(observed.getByText("New step from builder: Keep score as tie-breaker"))
    .toBeInTheDocument();
  // Its step is asked for once by commit, however often the feed replays it.
  const asked = () =>
    server.requests.filter(
      (r) =>
        r.url.pathname === "/api/repos/orbit/engine/steps" && r.url.searchParams.has("commits"),
    ).length;
  await expect.poll(asked, { timeout: 10_000 }).toBe(1);
  // Another arrives: only its commit is asked for, never the first again.
  const first = feed.at(-1)!.commitOid;
  feed.push({
    ...feed.at(-1)!,
    seq: 10,
    changeId: "secondlive",
    commitOid: commitId(),
    summary: "Document the ranking",
    committedAt: minutes(0),
    at: minutes(0),
  });
  await expect.poll(asked, { timeout: 20_000 }).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 7_000));
  const commitsAsked = server.requests
    .filter((r) => r.url.pathname === "/api/repos/orbit/engine/steps")
    .map((r) => r.url.searchParams.get("commits"))
    .filter(Boolean);
  expect(commitsAsked).toHaveLength(2);
  expect(commitsAsked.filter((c) => c!.includes(first))).toHaveLength(1);
  // The removed step never got a mark: the builder's two, then the two that arrived.
  expect(builder.getByRole("button", { name: /Paste the API key/ }).elements()).toHaveLength(0);
  expect(builder.getByRole("button").elements()).toHaveLength(4);

  // An admin deletes a step already loaded in full: the feed says so, and its
  // span goes, inspector and all, without a reload (CORE-399).
  removals.push(feed.find((record) => record.changeId === "livechange")!);
  await expect
    .poll(
      () => builder.getByRole("button", { name: /Keep score as tie-breaker/ }).elements().length,
      {
        timeout: 20_000,
      },
    )
    .toBe(0);
  expect(builder.getByRole("button").elements()).toHaveLength(3);
  await expect
    .element(observed)
    .not.toMatchTextContent(/Keep score as tie-breaker|Ties need an order/);

  // A phone: nothing scrolls sideways but the lanes themselves.
  await page.viewport(390, 844);
  await expect.element(vitals).toBeVisible();
  expect(sidewaysOverflow()).toBeLessThanOrEqual(0);
  await page.viewport(1280, 900);
  app.unmount();
});

test("observability: a timeline with no steps says how they get there", async () => {
  const server = await TestServer.start({ world: true });
  const world = await timelineWorld(server, { slug: "quiet", name: "Quiet" });
  renderApp(`/tracker/orbit/timelines?tl=${world.slug}`);
  const observed = page.getByRole("region", { name: "Observability" });
  await expect.element(observed.getByText(/No steps on this timeline yet/)).toBeVisible();
  await expect.element(observed.getByLabelText("Vitals")).toMatchTextContent(/steps\s*0(?!\d)/);
});
