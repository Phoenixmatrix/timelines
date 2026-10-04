// A timeline's story (CORE-234) in a real browser, against the tracker and
// steps API in memory: the timeline's commits in first-parent order with
// their recorded context, a step's diff beside its context, keyboard
// stepping, filters, an amended step's versions, and a phone-width layout.
// The in-memory repositories have no git objects, so history and diffs are
// canned; steps are uploaded through the real API.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { CommitSummary, HistoryPage } from "../../../shared/api.ts";
import type { CommitDiff } from "../../../shared/diff.ts";
import type { StepUpload } from "../../../shared/steps.ts";
import { commitId, settled, sidewaysOverflow } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";

test("story: steps in order, context beside the diff, keys, filters, versions, phone", async () => {
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
  server.on("GET", "/api/repos/:owner/:name/history", ({ url }): HistoryPage => ({
    ref: url.searchParams.get("at") ?? "",
    head: merge,
    path: "",
    scanned: line.length,
    next: null,
    commits: line,
    entries: {},
  }));
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
  server.on("GET", "/api/repos/:owner/:name/commits/:oid/diff", ({ params }) => diffs[params.oid!]);

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
    coverage: { instructions: "hook", steering: "hook" },
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

  // Amended: the earlier version, with its own context and diff.
  const version = step.getByRole("combobox", { name: "Version" });
  await userEvent.click(version);
  await userEvent.click(page.getByRole("option", { name: new RegExp(rankOld.slice(0, 7)) }));
  await expect.element(context).toMatchTextContent(/First take: rank by date\./);
  await expect.element(diff.getByText("+byDate()")).toBeVisible();

  // The keyboard (outside the version picker): j goes back in time, k forward.
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
  await userEvent.click(step.getByRole("heading", { level: 2 }));
  await expect.poll(() => document.activeElement?.closest("[role=combobox]")).toBeNull();
  await userEvent.keyboard("j");
  await app.waitForUrl((url) => url.searchParams.get("step") === plain);
  await expect.element(context).toMatchTextContent(/No context was recorded for this commit/);
  await userEvent.keyboard("k");
  await userEvent.keyboard("k");
  await app.waitForUrl((url) => url.searchParams.get("step") === merge);
  await expect
    .element(context.getByRole("note"))
    .toMatchTextContent(/No claude-code hook recorded this step's prompts and steering/);
  await expect.element(step.getByRole("button", { name: /Next/ })).toBeDisabled();

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
