// The checkpoint card (CORE-76, CORE-79, CORE-84) in a real browser, against
// the tracker and timelines routes in memory: on Needs you, an approval
// request shows the checkpoint's summary, each repository's commit onto main,
// its changes, CI runs, previews (rebuilt ones marked), the knowledge diff and
// the timeline's wiki pages in every state; approving it lands it. A
// superseded checkpoint can't be approved, and the request it withdrew says
// why. Revive preview starts a rebuild from the card and from the timeline
// inspector's Checkpoints. CI runs, deployments and page sets are rows as
// their machinery leaves them; starting a preview run is canned.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { OpenRequests } from "../../../shared/tracker.ts";
import type { CheckpointView, PreviewRevival } from "../../../shared/timelines.ts";
import { sidewaysOverflow } from "../../testing/atlas.ts";
import { focused, focusOn, press } from "../../testing/focus.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import {
  askApproval,
  changes,
  checkpoint,
  ciRun,
  deployment,
  landing,
  pageSet,
  timelineWorld,
  work,
  type WorldTimeline,
} from "../../testing/timelines.ts";

const short = (oid: string) => oid.slice(0, 7);

/**
 * Search across four repositories, its checkpoint #1 asked for approval, and
 * what's known about it now: changes, CI runs, previews and wiki pages in
 * each of their states.
 */
async function approvalWorld(server: TestServer) {
  const timeline = await timelineWorld(server, { names: ["engine", "web", "docs", "site"] });
  const [engine, web, docs, site] = timeline.repos as [
    WorldTimeline["repos"][number],
    WorldTimeline["repos"][number],
    WorldTimeline["repos"][number],
    WorldTimeline["repos"][number],
  ];
  await changes(server, timeline, engine, ["kxqrstuv", "lmnopqrs", "wxyzabcd"]);
  await changes(server, timeline, web, ["ponmlkji"]);
  const view = await checkpoint(
    server,
    timeline,
    "Adds **ranked** search.\n\n- Indexes the docs\n- Ranks by freshness",
  );
  const ref = `timeline/${timeline.slug}`;
  await ciRun(server, { repo: engine, number: 4, commit: engine.tip, ref, status: "succeeded" });
  await ciRun(server, {
    repo: engine,
    number: 5,
    commit: engine.tip,
    ref,
    status: "running",
    preview: "create",
  });
  await ciRun(server, { repo: web, number: 2, commit: web.tip, ref, status: "failed" });
  const original = await deployment(server, view, engine, {
    status: "active",
    url: "https://search.engine.preview.test",
    expiresAt: "2026-10-11T00:00:00.000Z",
  });
  await deployment(server, view, web, {
    status: "active",
    url: "https://search.web.preview.test",
    revived: true,
  });
  await deployment(server, view, docs, {
    status: "expired",
    url: "https://search.docs.preview.test",
    tornDownAt: "2026-10-02T12:00:00.000Z",
  });
  await pageSet(server, view, engine, {
    status: "succeeded",
    pages: [
      {
        slug: "search-ranking",
        title: "Search ranking",
        change: "added",
        outcome: "written",
        body: "Ranks results by freshness and links.",
      },
      { slug: "indexing", title: "Indexing", change: "changed", outcome: "kept" },
    ],
  });
  await pageSet(server, view, web, { status: "failed", error: "The model timed out." });
  await pageSet(server, view, docs, { status: "queued" });
  await pageSet(server, view, site, { status: "writing" });
  const request = await askApproval(server, timeline, view.checkpoint.id);
  return { timeline, view, request, engine, web, docs, site, original };
}

const card = () => page.getByRole("region", { name: "Checkpoint #1 of search" });
const repoRow = (name: string) =>
  card()
    .getByRole("listitem")
    .filter({ has: page.getByText(`orbit/${name}`, { exact: true }) });

test("Needs you: the checkpoint's summary, commits, CI, previews and wiki pages; approving lands it", async () => {
  const server = await TestServer.start({ world: true });
  const { timeline, view, engine, web, docs, site } = await approvalWorld(server);

  renderApp("/needs-you");
  const request = page.getByRole("article", { name: "Approval for you" });
  await expect.element(request).toBeVisible();
  await expect.element(request.getByRole("link", { name: /ENG-1/ })).toBeVisible();
  await expect.element(request.getByText("land it", { exact: true })).toBeVisible();

  // The header and the hint: approving this one lands it.
  await expect
    .element(card().getByRole("link", { name: "Search", exact: true }))
    .toHaveAttribute("href", "/tracker/orbit/timelines?tl=search");
  await expect.element(card().getByText("Superseded")).not.toBeInTheDocument();
  await expect
    .element(card())
    .toMatchTextContent(
      "Approving lands it: the checkpoint is merged into main and tested, and main moves only if that passes.",
    );
  // The summary, as Markdown.
  await expect.element(card().getByText("ranked", { exact: true })).toBeVisible();
  await expect.element(card().getByText("Ranks by freshness")).toBeVisible();

  // Each repository: its commit onto main's, its changes, CI runs and previews.
  for (const repo of [engine, web, docs, site]) {
    const row = repoRow(repo.name);
    await expect
      .element(row.getByRole("link", { name: short(repo.tip), exact: true }))
      .toHaveAttribute("href", `/orbit/${repo.name}?commit=${repo.tip}`);
    await expect.element(row).toMatchTextContent(`onto main ${short(repo.main)}`);
    await expect
      .element(row.getByRole("link", { name: short(repo.main), exact: true }))
      .toHaveAttribute("href", `/orbit/${repo.name}?commit=${repo.main}`);
    await expect
      .element(row.getByRole("link", { name: "Knowledge diff" }))
      .toHaveAttribute("href", `/orbit/${repo.name}/knowledge?timeline=search`);
  }
  const engineChanges = repoRow("engine").getByRole("link", { name: "3 changes" });
  await expect.element(engineChanges).toHaveAttribute("href", `/orbit/engine?commit=${engine.tip}`);
  await expect.element(engineChanges).toHaveAttribute("title", "wxyzabcd\nlmnopqrs\nkxqrstuv");
  await expect.element(repoRow("web").getByRole("link", { name: "1 change" })).toBeVisible();
  await expect.element(repoRow("docs").getByRole("link", { name: "0 changes" })).toBeVisible();

  await expect
    .element(repoRow("engine").getByRole("link", { name: /CI #5 running$/ }))
    .toHaveAttribute("href", "/orbit/engine/ci/5");
  await expect
    .element(repoRow("engine").getByRole("link", { name: /CI #4 succeeded$/ }))
    .toHaveAttribute("href", "/orbit/engine/ci/4");
  await expect
    .element(repoRow("web").getByRole("link", { name: /CI #2 failed$/ }))
    .toHaveAttribute("title", "CI run #2: Failed");
  await expect.element(repoRow("docs").getByText("No CI run")).toBeVisible();

  const preview = repoRow("engine").getByRole("link", { name: "Preview", exact: true });
  await expect.element(preview).toHaveAttribute("href", "https://search.engine.preview.test");
  await expect.element(preview).toHaveAttribute("target", "_blank");
  await expect.poll(() => preview.element().getAttribute("title")).toMatch(/^Expires /);
  const rebuilt = repoRow("web").getByRole("link", { name: "Preview (rebuilt)" });
  await expect.element(rebuilt).toHaveAttribute("href", "https://search.web.preview.test");
  await expect
    .poll(() => rebuilt.element().getAttribute("title"))
    .toMatch(/^Rebuilt by reviving this checkpoint's preview, not the original/);
  // A torn-down preview isn't a link any more.
  expect(
    repoRow("docs")
      .getByRole("link", { name: /Preview/ })
      .elements(),
  ).toHaveLength(0);
  const expired = repoRow("docs").getByText("Preview expired");
  await expect.element(expired).toBeVisible();
  await expect.poll(() => expired.element().getAttribute("title")).toMatch(/^Torn down /);
  expect(
    repoRow("site")
      .getByText(/Preview/)
      .elements(),
  ).toHaveLength(0);

  // The timeline's wiki pages, per repository, in each state.
  const pages = (name: string) =>
    card().getByRole("region", { name: `Wiki pages in orbit/${name}` });
  await expect
    .element(pages("engine").getByRole("link", { name: "Search ranking" }))
    .toHaveAttribute(
      "href",
      `/orbit/engine/wiki/search-ranking?set=${view.checkpoint.id}&tl=search`,
    );
  await expect.element(pages("engine")).toMatchTextContent("Search rankingNew");
  await expect.element(pages("engine")).toMatchTextContent("Ranks results by freshness and links.");
  await expect
    .element(pages("engine").getByRole("link", { name: "Indexing" }))
    .toHaveAttribute("href", "/orbit/engine/wiki/indexing?tl=main");
  await expect.element(pages("engine")).toMatchTextContent("IndexingMain's page holds");
  await expect
    .element(pages("web"))
    .toMatchTextContent("The wiki pages could not be written: The model timed out.");
  await expect
    .element(pages("docs").getByRole("status"))
    .toHaveTextContent("Wiki pages are queued…");
  await expect.element(pages("site").getByRole("status")).toHaveTextContent("Writing wiki pages…");

  // Approve by keyboard, with a note: the request closes and the timeline lands.
  const note = request.getByRole("textbox", { name: "Note (optional)" });
  await focusOn(note);
  await userEvent.keyboard("Ranking reviewed");
  await press("Tab");
  expect(focused()).toMatchObject({ role: "button", name: "Approve" });
  const mark = server.requests.length;
  await press("Enter");
  await expect.element(page.getByText("Nothing is waiting on you.")).toBeVisible();
  expect(
    server
      .since(mark)
      .some((r) => r.method === "POST" && r.url.pathname === "/api/tracker/orbit/mutate"),
  ).toBe(true);
  const queued = await landing(server, timeline);
  expect(queued).toMatchObject({ checkpointNumber: 1, state: "merging", trigger: "approval" });
  const approval = await server.call<CheckpointView>(
    "GET",
    `/api/tracker/orbit/timelines/${timeline.slug}/checkpoints/1`,
  );
  expect(approval.approval).toMatchObject({ state: "approved", note: "Ranking reviewed" });
});

test("a superseded checkpoint can't be approved, and the withdrawn request says why", async () => {
  const server = await TestServer.start({ world: true });
  const timeline = await timelineWorld(server);
  const first = await checkpoint(server, timeline, "First pass");
  await askApproval(server, timeline, first.checkpoint.id);

  // New commits after the inbox read it: the checkpoint is no longer the head.
  server.on("GET", "/api/requests", async () => {
    const open = await server.call<OpenRequests>("GET", "/api/requests");
    for (const item of open.requests)
      if (item.checkpoint)
        item.checkpoint = { ...item.checkpoint, current: false, approved: false };
    return open;
  });
  const app = renderApp("/needs-you");
  await expect.element(card()).toBeVisible();
  const chip = card().getByText("Superseded", { exact: true });
  await expect
    .element(chip)
    .toHaveAttribute("title", "New commits since: approve a new checkpoint");
  await expect
    .element(card())
    .toMatchTextContent(
      "The timeline has moved past this checkpoint. It can't be approved any more; its agent needs to make a new checkpoint and ask again.",
    );
  await expect.element(card()).not.toMatchTextContent("Approving lands it");
  await expect.element(card()).not.toMatchTextContent("It lands once its CI is green");
  const approve = page.getByRole("button", { name: "Approve" });
  await expect.element(approve).toBeDisabled();
  await expect.element(approve).toHaveAttribute("title", "New commits since this checkpoint");
  await expect.element(page.getByRole("button", { name: "Reject" })).toBeEnabled();
  app.unmount();

  // The real thing: a new checkpoint withdraws the request, with the reason.
  server.on("GET", "/api/requests", () => server.call("GET", "/api/requests"));
  await work(server, timeline, timeline.repos[0]!);
  await checkpoint(server, timeline, "Second pass");
  const inbox = renderApp("/needs-you");
  await expect.element(page.getByText("Nothing is waiting on you.")).toBeVisible();
  inbox.unmount();

  renderApp(`/tracker/orbit/issues/${timeline.issue}`);
  const requests = page.getByRole("region", { name: "Requests to people" });
  const withdrawn = requests.getByRole("article", { name: "Approval for Marco Bellini" });
  await expect
    .element(withdrawn)
    .toMatchTextContent(
      "Withdrawn: Superseded by checkpoint #2 on timeline/search; ask about that one instead.",
    );
  await expect
    .element(withdrawn)
    .toMatchTextContent(
      "Approves checkpoint #1 of timeline search; Needs you shows its commits, CI and previews.",
    );
  expect(withdrawn.getByRole("button", { name: "Approve" }).elements()).toHaveLength(0);
});

test("an auto timeline's card says it lands when green; Revive preview starts a rebuild", async () => {
  const server = await TestServer.start({ world: true });
  const timeline = await timelineWorld(server, { policy: "auto", names: ["engine", "web"] });
  const [engine, web] = timeline.repos as [
    WorldTimeline["repos"][number],
    WorldTimeline["repos"][number],
  ];
  // A failing run keeps it from landing on its own.
  await ciRun(server, {
    repo: engine,
    number: 1,
    commit: engine.tip,
    ref: `timeline/${timeline.slug}`,
    status: "failed",
  });
  const view = await checkpoint(server, timeline, "Ranks results");
  await askApproval(server, timeline, view.checkpoint.id);
  const revivals: string[] = [];
  let answer: PreviewRevival["runs"] = [
    { repoId: engine.id, number: 9 },
    { repoId: web.id, skipped: "its ci.yml has no preview job" },
  ];
  server.on(
    "POST",
    "/api/tracker/:owner/timelines/:slug/checkpoints/:ref/revive",
    ({ url }): PreviewRevival => {
      revivals.push(url.pathname);
      return { checkpoint: view, runs: answer };
    },
  );

  renderApp("/needs-you");
  await expect
    .element(card())
    .toMatchTextContent(
      "It lands once its CI is green; the merge into main is tested before main moves.",
    );
  const revive = card().getByRole("button", { name: "Revive preview" });
  await expect
    .element(revive)
    .toHaveAttribute(
      "title",
      "Rebuild this checkpoint's preview from its commits (migrations plus seed).",
    );
  await focusOn(revive);
  await press("Enter");
  await expect
    .element(card().getByRole("status").filter({ hasText: "building" }))
    .toHaveTextContent(
      "orbit/engine: building in CI #9 · orbit/web: its ci.yml has no preview job",
    );
  expect(revivals).toEqual([
    `/api/tracker/orbit/timelines/search/checkpoints/${view.checkpoint.id}/revive`,
  ]);
  expect(focused()).toMatchObject({ role: "button", name: "Revive preview" });

  // Nothing started: that's an error, said as one.
  answer = [
    { repoId: engine.id, skipped: "its ci.yml has no preview job" },
    { repoId: web.id, skipped: "its ci.yml has no preview job" },
  ];
  await press("Enter");
  await expect
    .element(card().getByRole("alert"))
    .toHaveTextContent(
      "orbit/engine: its ci.yml has no preview job · orbit/web: its ci.yml has no preview job",
    );
});

test("the timeline inspector's Checkpoints: previews per checkpoint, and reviving one shows its rebuild", async () => {
  const server = await TestServer.start({ world: true });
  const timeline = await timelineWorld(server);
  const engine = timeline.repos[0]!;
  const first = await checkpoint(server, timeline, "First pass");
  const original = await deployment(server, first, engine, {
    status: "expired",
    url: "https://search.engine.preview.test",
    tornDownAt: "2026-10-02T12:00:00.000Z",
  });
  await work(server, timeline, engine);
  await checkpoint(server, timeline, "Second pass");
  let revived = 0;
  server.on(
    "POST",
    "/api/tracker/:owner/timelines/:slug/checkpoints/:ref/revive",
    async ({ params }): Promise<PreviewRevival> => {
      expect(params.ref).toBe(first.checkpoint.id);
      revived++;
      // The preview run records its rebuild, as its job would once it's up.
      await server.sql(
        `INSERT INTO deployments (repo_id, environment, timeline_slug, timeline_id, checkpoint_id,
           commit_oid, url, status, revived, rebuilt_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)`,
        engine.id,
        "timeline/search",
        "search",
        first.timeline.id,
        first.checkpoint.id,
        first.checkpoint.repos[0]!.commit,
        "https://search-1.engine.preview.test",
        original,
      );
      return { checkpoint: first, runs: [{ repoId: engine.id, number: 12 }] };
    },
  );

  renderApp(`/tracker/orbit/timelines?tl=${timeline.slug}`);
  const inspector = page.getByRole("region", { name: "Selected timeline" });
  const list = inspector.getByRole("list").filter({ hasText: "#2" }).filter({ hasText: "#1" });
  const item = (n: number) =>
    list.getByRole("listitem").filter({ has: page.getByText(`#${n}`, { exact: true }) });
  await expect.element(item(2)).toMatchTextContent("No preview");
  await expect.element(item(1).getByText("Preview expired")).toBeVisible();
  expect(
    item(1)
      .getByRole("link", { name: /Preview/ })
      .elements(),
  ).toHaveLength(0);

  const revive = item(1).getByRole("button", { name: "Revive preview" });
  await focusOn(revive);
  const mark = server.requests.length;
  await press("Enter");
  await expect
    .element(item(1).getByRole("status"))
    .toHaveTextContent("orbit/engine: building in CI #12");
  // The list reads again: the rebuilt preview is there, marked.
  const rebuilt = item(1).getByRole("link", { name: "Preview (rebuilt)" });
  await expect.element(rebuilt).toHaveAttribute("href", "https://search-1.engine.preview.test");
  expect(revived).toBe(1);
  expect(
    server
      .since(mark)
      .filter(
        (r) => r.method === "GET" && r.url.pathname.endsWith("/timelines/search/checkpoints"),
      ),
  ).toHaveLength(1);
  expect(focused()).toMatchObject({ role: "button", name: "Revive preview" });
});

test("a 320px phone: the approval card fits and its actions are in reach", async () => {
  const server = await TestServer.start({ world: true });
  await approvalWorld(server);
  await page.viewport(320, 720);
  try {
    renderApp("/needs-you");
    await expect.element(card()).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "Wiki pages in orbit/site" }))
      .toBeVisible();
    expect(sidewaysOverflow(), "The Needs you page scrolls sideways").toBeLessThanOrEqual(0);
    for (const name of ["Revive preview", "Approve", "Reject"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect.element(button).toBeVisible();
      const box = button.element().getBoundingClientRect();
      expect(box.left, `${name} starts on screen`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${name} ends on screen`).toBeLessThanOrEqual(320);
    }
    const panel = card().element();
    expect(panel.scrollWidth, "The card's content overflows it").toBeLessThanOrEqual(
      panel.clientWidth,
    );
  } finally {
    await page.viewport(1280, 900);
  }
});
