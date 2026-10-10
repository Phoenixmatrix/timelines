// A timeline's story (CORE-234) in a real browser, against the tracker and
// steps API in memory: the timeline's commits in first-parent order with
// their recorded context, a step's diff beside its context, keyboard
// stepping, filters, an amended step's versions, and a phone-width layout.
// The in-memory repositories have no git objects, so history and diffs are
// canned; steps are uploaded through the real API.

import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { CommitSummary, HistoryPage } from "../../../shared/api.ts";
import type { CommitDiff } from "../../../shared/diff.ts";
import type { StepUpload } from "../../../shared/steps.ts";
import type { TimelineDetail } from "../../../shared/timelines.ts";
import { commitId, settled, sidewaysOverflow } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { reply, TestServer } from "../../testing/server.ts";

test("story: steps in order, context beside the diff, keys, filters, versions, phone", async () => {
  let shortcuts = false;
  const getItem = vi.spyOn(Storage.prototype, "getItem");
  const readStorage = getItem.getMockImplementation()!;
  getItem.mockImplementation(function (this: Storage, key: string) {
    return key === "gitmatrix:tracker-shortcuts" ? String(shortcuts) : readStorage.call(this, key);
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const fork = commitId();
  await server.push("orbit/engine", "main", fork);
  const slug = "search";
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug,
    name: "Search v2",
    repos: ["orbit/engine"],
  });
  const detail = await server.call<TimelineDetail>("GET", `/api/tracker/orbit/timelines/${slug}`);
  const source = detail.timeline.repos[0]!.source!;
  expect(source.kind).toBe("timeline-work");
  expect(source.ref).toBe("refs/heads/work");

  // The timeline's line, newest first: a merge from main, a step amended
  // once (rank, which replaced rankOld), and a commit with no context.
  const [merge, rank, rankOld, plain] = [commitId(), commitId(), commitId(), commitId()];
  const at = (n: number) => 1_790_000_000 + n * 60;
  const commit = (oid: string, message: string, n: number, parents: string[]): CommitSummary => ({
    oid,
    message,
    authorName: "Marco",
    authorEmail: "marco@example.com",
    authoredAt: at(n),
    parents,
  });
  const line = [
    commit(merge, "Merge main into timeline/search", 3, [rank, fork]),
    commit(rank, "Rank results by recency", 2, [plain]),
    commit(plain, "Add the search index", 1, [fork]),
    commit(fork, "Main before the fork", 0, []),
  ];
  // The physical work ref and its objects exist only in the timeline's
  // namespace. An unqualified read cannot accidentally pass against main.
  server.on("GET", "/api/repos/:owner/:name/history", ({ url }) => {
    if (url.searchParams.get("source") !== source.sourceId)
      return reply({ message: "No branch, tag or commit named work." }, 404);
    const at = url.searchParams.get("at");
    if (at !== "work" && at !== merge)
      return reply({ message: "Unknown ref in the timeline source." }, 404);
    const continuation = url.searchParams.get("cursor") === "older";
    const commits = continuation ? line.slice(2) : line.slice(0, 2);
    return {
      ref: at,
      head: merge,
      path: "",
      scanned: commits.length,
      next: continuation ? null : "older",
      commits,
      entries: {},
    } satisfies HistoryPage;
  });
  const diffs: Record<string, CommitDiff> = {};
  const diffFor = (oid: string, path: string, lines: string[]): CommitDiff => ({
    oid,
    parents: [],
    message: "",
    authorName: "Marco",
    authoredAt: 0,
    truncated: false,
    files: [
      {
        path,
        status: "modified",
        additions: lines.filter((l) => l.startsWith("+")).length,
        deletions: lines.filter((l) => l.startsWith("-")).length,
        binary: false,
        omitted: false,
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines }],
      },
    ],
  });
  diffs[rank] = diffFor(rank, "src/rank.ts", [" a", "-byScore()", "+byRecency()"]);
  diffs[rankOld] = diffFor(rankOld, "src/rank.ts", [" a", "-byScore()", "+byDate()"]);
  diffs[plain] = diffFor(plain, "src/index.ts", ["+index()"]);
  diffs[merge] = diffFor(merge, "README.md", ["+merged"]);
  server.on("GET", "/api/repos/:owner/:name/commits/:oid/diff", ({ params, url }) =>
    url.searchParams.get("source") === source.sourceId
      ? diffs[params.oid!]
      : reply({ message: "Commit not found in the canonical source." }, 404),
  );

  const upload = (over: Partial<StepUpload>): StepUpload => ({
    changeId: "rankchangeid0000",
    commitOid: rank,
    summary: "Rank results by recency",
    committedAt: new Date(at(2) * 1000).toISOString(),
    timeline: slug,
    issue: "ENG-7",
    instructions: [{ text: "Rank search results by recency", source: "hook" }],
    steering: [{ text: "Keep score as the tie-breaker", source: "hook" }],
    why: "People look for what changed lately, not what matches best.",
    challenges: "The index had no updated_at.",
    tests: [
      { command: "vp test run search", exit: 0, summary: "12 passed", origin: "local" },
      { command: "cargo test", exit: 0, summary: "ok", origin: "local" },
    ],
    coverage: { instructions: "hook:claude-code", steering: "hook:claude-code" },
    harness: "claude-code",
    model: null,
    ...over,
  });
  await server.call("POST", "/api/repos/orbit/engine/steps", {
    ...upload({ commitOid: rankOld, why: "First take: rank by date." }),
    committedAt: new Date(at(1.5) * 1000).toISOString(),
  });
  await server.call("POST", "/api/repos/orbit/engine/steps", upload({}));
  await server.call(
    "POST",
    "/api/repos/orbit/engine/steps",
    upload({
      changeId: "mergechangeid000",
      commitOid: merge,
      summary: "Merge main into timeline/search",
      issue: "ENG-8",
      instructions: [],
      steering: [{ text: "Bring in main's tokenizer", source: "agent" }],
      why: "Main's tokenizer fixes the failing test.",
      challenges: "",
      tests: [{ command: "vp test run", exit: 1, summary: "1 failed", origin: "local" }],
      coverage: { instructions: "none", steering: "agent" },
    }),
  );

  // The timeline page links to its story.
  const app = renderApp(`/tracker/orbit/timelines?tl=${slug}`);
  await userEvent.click(page.getByRole("link", { name: "Story", exact: true }));
  await app.waitForUrl((url) => url.pathname === `/tracker/orbit/timelines/${slug}/story`);

  // First-parent order, newest first, stopping at the fork; the merge is marked.
  const steps = page.getByRole("region", { name: "Steps" });
  const rows = steps.getByRole("listitem");
  await expect.poll(() => rows.elements().length).toBe(3);
  await expect.element(rows.nth(0)).toMatchTextContent(/Merge main into timeline\/search/);
  await expect.element(rows.nth(0).getByLabelText("Merge")).toBeInTheDocument();
  await expect.element(rows.nth(0)).toMatchTextContent(/1 of 1 failed/);
  await expect.element(rows.nth(0)).toMatchTextContent(/Partial context/);
  await expect.element(rows.nth(1)).toMatchTextContent(/Rank results by recency/);
  await expect.element(rows.nth(1)).toMatchTextContent(/2 passed/);
  await expect.element(rows.nth(1)).toMatchTextContent(/Full context/);
  await expect.element(rows.nth(2)).toMatchTextContent(/Add the search index/);
  await expect.element(rows.nth(2)).toMatchTextContent(/No context/);
  // With no selection, either arrow direction opens the first visible row.
  await userEvent.keyboard("{ArrowDown}");
  await app.waitForUrl((url) => url.searchParams.get("step") === merge);
  await userEvent.keyboard("{Escape}");
  await app.waitForUrl((url) => !url.searchParams.has("step"));
  await userEvent.keyboard("{ArrowUp}");
  await app.waitForUrl((url) => url.searchParams.get("step") === merge);
  await userEvent.keyboard("{Escape}");
  await app.waitForUrl((url) => !url.searchParams.has("step"));

  // A step: its context beside its diff.
  await userEvent.click(rows.nth(1).getByRole("button"));
  await app.waitForUrl((url) => url.searchParams.get("step") === rank);
  const step = page.getByRole("region", { name: "Step" });
  const context = step.getByRole("complementary", { name: "Context" });
  await expect
    .element(context)
    .toMatchTextContent(/WhyPeople look for what changed lately, not what matches best\./);
  await expect.element(context).toMatchTextContent(/Rank search results by recency \(hook\)/);
  await expect.element(context).toMatchTextContent(/Keep score as the tie-breaker \(hook\)/);
  await expect.element(context).toMatchTextContent(/ChallengesThe index had no updated_at\./);
  await expect.element(context).toMatchTextContent(/Passed vp test run search · 12 passed/);
  await expect.element(context.getByRole("note")).not.toBeInTheDocument();
  const diff = step.getByRole("region", { name: "Diff" });
  await expect.element(diff).toMatchTextContent(/src\/rank\.ts/);
  await expect.element(diff.getByText("+byRecency()")).toBeVisible();
  const commitLink = step.getByRole("link", { name: rank.slice(0, 7), exact: true });
  const commitUrl = new URL(commitLink.element().getAttribute("href")!, location.origin);
  expect(commitUrl.searchParams.get("source")).toBe(source.sourceId);
  expect(commitUrl.searchParams.get("commit")).toBe(rank);

  // Character navigation is opt-in. Arrow actions remain available.
  await expect
    .element(step.getByRole("button", { name: /Next/ }))
    .toHaveAttribute("aria-keyshortcuts", "ArrowRight ArrowDown");
  await userEvent.keyboard("jk");
  expect(app.router.state.location.search).toContain(`step=${rank}`);
  await userEvent.keyboard("{ArrowRight}");
  await app.waitForUrl((url) => url.searchParams.get("step") === plain);
  await userEvent.keyboard("{ArrowLeft}");
  await app.waitForUrl((url) => url.searchParams.get("step") === rank);
  shortcuts = true;
  // Previous is k/up, Next is j/down, following the visible newest-first list.
  await userEvent.keyboard("j");
  await app.waitForUrl((url) => url.searchParams.get("step") === plain);
  await expect.element(context).toMatchTextContent(/No context was recorded for this commit/);
  await expect
    .element(step.getByRole("button", { name: /Previous/ }))
    .toHaveAttribute("aria-keyshortcuts", "k ArrowLeft ArrowUp");
  await expect
    .element(step.getByRole("button", { name: /Next/ }))
    .toHaveAttribute("aria-keyshortcuts", "j ArrowRight ArrowDown");
  // Arrows and visible actions agree with the letter keys.
  // A pointer action followed by a key before React commits must take two
  // hops, not navigate again from the rendered (older) selection.
  (step.getByRole("button", { name: /Previous/ }).element() as HTMLButtonElement).click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await app.waitForUrl((url) => url.searchParams.get("step") === merge);
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  await app.waitForUrl((url) => url.searchParams.get("step") === plain);
  await userEvent.click(step.getByRole("button", { name: /Previous/ }));
  await app.waitForUrl((url) => url.searchParams.get("step") === rank);
  await userEvent.keyboard("{ArrowDown}");
  await app.waitForUrl((url) => url.searchParams.get("step") === plain);
  await userEvent.keyboard("{ArrowUp}");
  await app.waitForUrl((url) => url.searchParams.get("step") === rank);
  await userEvent.click(step.getByRole("button", { name: /Next/ }));
  await app.waitForUrl((url) => url.searchParams.get("step") === plain);
  for (const options of [
    { isComposing: true },
    { repeat: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
  ]) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, ...options }));
    expect(app.url().searchParams.get("step")).toBe(plain);
  }
  await userEvent.keyboard("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect.element(help).toBeVisible();
  await userEvent.keyboard("jk{ArrowRight}");
  expect(app.url().searchParams.get("step")).toBe(plain);
  await userEvent.keyboard("{Escape}");
  await expect.element(help).not.toBeInTheDocument();
  expect(app.url().searchParams.get("step")).toBe(plain);
  await userEvent.keyboard("k");
  await userEvent.keyboard("k");
  await app.waitForUrl((url) => url.searchParams.get("step") === merge);
  await expect
    .element(context.getByRole("note"))
    .toMatchTextContent(
      /Steering recorded by the agent; a harness hook isn.t set up, so some context may be missing\. Run `gm agent setup`/,
    );
  await expect.element(step.getByRole("button", { name: /Previous/ })).toBeDisabled();

  // Amended: the earlier version, with its own context and diff.
  await userEvent.keyboard("j");
  await app.waitForUrl((url) => url.searchParams.get("step") === rank);
  const version = step.getByRole("combobox", { name: "Version" });
  await userEvent.click(version);
  await userEvent.click(page.getByRole("option", { name: new RegExp(rankOld.slice(0, 7)) }));
  await expect.element(context).toMatchTextContent(/First take: rank by date\./);
  await expect.element(diff.getByText("+byDate()")).toBeVisible();
  const amendedUrl = new URL(
    step
      .getByRole("link", { name: rankOld.slice(0, 7), exact: true })
      .element()
      .getAttribute("href")!,
    location.origin,
  );
  expect(amendedUrl.searchParams.get("source")).toBe(source.sourceId);
  expect(amendedUrl.searchParams.get("commit")).toBe(rankOld);

  // Filters: by issue, then by agent.
  await userEvent.click(page.getByRole("combobox", { name: "Issue" }));
  await userEvent.click(page.getByRole("option", { name: "ENG-7" }));
  await expect.poll(() => rows.elements().length).toBe(1);
  await expect.element(rows.nth(0)).toMatchTextContent(/Rank results by recency/);
  await userEvent.click(page.getByRole("combobox", { name: "Issue" }));
  await userEvent.click(page.getByRole("option", { name: "Any issue" }));
  await expect.poll(() => rows.elements().length).toBe(3);
  await userEvent.click(page.getByRole("combobox", { name: "Agent" }));
  await userEvent.click(page.getByRole("option", { name: "Marco", exact: true }));
  await expect.poll(() => rows.elements().length).toBe(1);
  await expect.element(rows.nth(0)).toMatchTextContent(/Add the search index/);
  app.unmount();

  // A phone: the list, then a step on its own with a way back; nothing sideways.
  await page.viewport(390, 844);
  const phone = renderApp(`/tracker/orbit/timelines/${slug}/story`);
  await expect.poll(() => rows.elements().length).toBe(3);
  await userEvent.click(rows.nth(1).getByRole("button"));
  await expect.element(step).toBeVisible();
  await expect.element(steps).not.toBeInTheDocument();
  await settled(server);
  expect(sidewaysOverflow()).toBeLessThanOrEqual(0);
  await userEvent.click(step.getByRole("button", { name: "All steps" }));
  await expect.element(steps).toBeVisible();
  phone.unmount();
  await page.viewport(1280, 900);
});

test("ended Story keeps owned work separate from historical canonical merge parents", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const fork = commitId();
  await server.push("orbit/engine", "main", fork);
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug: "ended-story",
    name: "Ended story",
    repos: ["orbit/engine"],
  });
  const original = await server.call<TimelineDetail>(
    "GET",
    "/api/tracker/orbit/timelines/ended-story",
  );
  const repo = original.timeline.repos[0]!;
  const owned = repo.source!;
  const [work, historical, canonicalMerge] = [commitId(), commitId(), commitId()];
  const mergeEvent = {
    id: "historical-merge",
    seq: 2,
    timelineId: original.timeline.id,
    actorId: null,
    accountableId: null,
    createdAt: original.timeline.createdAt,
    kind: "merge" as const,
    fromId: original.timeline.id,
    intoId: null,
    repoId: repo.id,
    commit: canonicalMerge,
    parent: historical,
    refUpdateId: null,
  };
  for (const scenario of ["owned-landed", "owned-abandoned", "historical-landed"] as const) {
    const isHistorical = scenario === "historical-landed";
    const abandoned = scenario === "owned-abandoned";
    const source = isHistorical
      ? {
          ...owned,
          kind: "canonical-historical" as const,
          sourceId: "canonical",
          ref: "refs/heads/timeline/ended-story",
        }
      : owned;
    const oid = isHistorical ? historical : work;
    const expectedAt = isHistorical ? historical : abandoned ? work : "work";
    const detail: TimelineDetail = {
      ...original,
      timeline: {
        ...original.timeline,
        status: abandoned ? "abandoned" : "landed",
        repos: [{ ...repo, source }],
      },
      // Owned sources must not select an old canonical merge observation.
      // Abandon pins its owned tip; historical landed records select the
      // contributing parent, never the canonical merge commit itself.
      events: abandoned
        ? [
            ...original.events,
            mergeEvent,
            {
              id: "abandon",
              seq: 3,
              timelineId: original.timeline.id,
              actorId: null,
              accountableId: null,
              createdAt: original.timeline.createdAt,
              kind: "abandon",
              lastCommits: { [repo.id]: work },
            },
          ]
        : [...original.events, mergeEvent],
    };
    server.on("GET", "/api/tracker/:owner/timelines/:slug", () => detail);
    server.on("GET", "/api/repos/:owner/:name/history", ({ url }) => {
      if (
        url.searchParams.get("source") !== source.sourceId ||
        url.searchParams.get("at") !== expectedAt
      )
        return reply({ message: "That head does not exist in this source." }, 404);
      return {
        ref: expectedAt,
        head: oid,
        path: "",
        scanned: 1,
        next: null,
        entries: {},
        commits: [
          {
            oid,
            parents: [fork],
            message: scenario,
            authorName: "Marco",
            authorEmail: "marco@example.com",
            authoredAt: 1_790_000_000,
          },
        ],
      } satisfies HistoryPage;
    });
    server.on("GET", "/api/repos/:owner/:name/commits/:oid/diff", ({ url, params }) => {
      if (url.searchParams.get("source") !== source.sourceId || params.oid !== oid)
        return reply({ message: "Commit unavailable in this source." }, 404);
      return {
        oid,
        parents: [fork],
        message: scenario,
        authorName: "Marco",
        authoredAt: 1_790_000_000,
        truncated: false,
        files: [],
      } satisfies CommitDiff;
    });
    const app = renderApp("/tracker/orbit/timelines/ended-story/story");
    await userEvent.click(
      page
        .getByRole("region", { name: "Steps" })
        .getByRole("button", { name: new RegExp(scenario) }),
    );
    await app.waitForUrl((url) => url.searchParams.get("step") === oid);
    await expect
      .element(page.getByRole("region", { name: "Diff" }))
      .toMatchTextContent(/0 files changed/);
    const href = page
      .getByRole("region", { name: "Step" })
      .getByRole("link", { name: oid.slice(0, 7), exact: true })
      .element()
      .getAttribute("href")!;
    expect(new URL(href, location.origin).searchParams.get("source")).toBe(source.sourceId);
    app.unmount();
  }
});
