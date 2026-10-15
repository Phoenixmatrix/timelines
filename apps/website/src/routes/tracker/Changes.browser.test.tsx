// A timeline's Changes page (CORE-382) in a real browser: the work compared
// with main, what one checkpoint added, what came after one, several
// repositories, and the failures that have a way out. The in-memory
// repositories hold no git objects, so the compare API is canned; the
// timeline and its checkpoints are real.

import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { CommitDiff, CompareDiff, DiffFile } from "../../../shared/diff.ts";
import type { TimelineDetail } from "../../../shared/timelines.ts";
import { commitId, sidewaysOverflow } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { reply, TestServer, type CannedRequest } from "../../testing/server.ts";
import { checkpoint, timelineWorld, work } from "../../testing/timelines.ts";
import { visual } from "../../testing/visual.ts";

const file = (path: string, additions: number, deletions: number): DiffFile => ({
  path,
  status: "modified",
  additions,
  deletions,
  binary: false,
  omitted: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [" keep", "-old()", ...Array.from({ length: additions }, () => `+new()`)],
    },
  ],
});

/** A compare answer for whatever was asked: two files and three commits. */
function compared(
  { url }: CannedRequest,
  over: Partial<CompareDiff> = {},
  files = [file("src/rank.ts", 3, 1), file("src/util/clock.ts", 2, 0)],
): CompareDiff {
  const head = url.searchParams.get("head")!;
  const base = url.searchParams.get("base") ?? commitId();
  return {
    base,
    head,
    from: base,
    mergeBase: base,
    historyTruncated: false,
    commits: [
      {
        oid: commitId(),
        summary: "Rank by recency",
        authorName: "Marco",
        authoredAt: 1_790_000_300,
        merge: false,
      },
      {
        oid: commitId(),
        summary: "Add the clock",
        authorName: "Marco",
        authoredAt: 1_790_000_200,
        merge: false,
      },
      {
        oid: commitId(),
        summary: "Index titles",
        authorName: "Marco",
        authoredAt: 1_790_000_100,
        merge: false,
      },
    ],
    commitsTruncated: false,
    files,
    truncated: false,
    ...over,
  };
}

/** The distinct comparisons asked for, in order (a development render asks twice). */
const distinct = (asked: URL[]) =>
  [...new Set(asked.map((url) => url.search))].map((q) => new URLSearchParams(q));

test("everything the timeline changes, with its commits and file diff in the address", async () => {
  const server = await TestServer.start({ world: true });
  const world = await timelineWorld(server);
  const asked: URL[] = [];
  server.on("GET", "/api/repos/:owner/:name/compare", (request) => {
    asked.push(request.url);
    return compared(request);
  });
  const app = renderApp("/tracker/orbit/timelines/search/changes");

  await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent("Search");
  const nav = page.getByRole("navigation", { name: "Timeline" });
  await expect
    .element(nav.getByRole("link", { name: "Changes" }))
    .toHaveAttribute("aria-current", "page");
  await expect
    .element(nav.getByRole("link", { name: "Overview" }))
    .toHaveAttribute("href", "/tracker/orbit/timelines?tl=search");
  await expect
    .element(page.getByRole("heading", { level: 2 }))
    .toMatchTextContent(
      /Everything this timeline changes, compared with main where it last met it \(/,
    );
  await expect.element(page.getByText("2 files", { exact: true })).toBeVisible();
  await expect.element(page.getByText("3 commits", { exact: true })).toBeVisible();

  // Head is the timeline's work in its own source; base is main's default.
  expect(asked[0]!.pathname).toBe("/api/repos/orbit/engine/compare");
  const [everything, ...rest] = distinct(asked);
  expect(rest).toEqual([]);
  expect(everything!.get("head")).toBe("work");
  expect(everything!.has("base")).toBe(false);
  expect(everything!.get("source")).toBe(world.repos[0]!.sourceId);

  // Each commit opens its step in the story.
  await expect
    .element(page.getByRole("link", { name: "Rank by recency" }))
    .toHaveAttribute(
      "href",
      expect.stringMatching(/^\/tracker\/orbit\/timelines\/search\/story\?step=[0-9a-f]{40}$/),
    );

  // A file is chosen into the address, and the diff links to the source's blob.
  expect(app.url().searchParams.has("file")).toBe(false);
  await page
    .getByRole("navigation", { name: "Changed files" })
    .getByRole("button", { name: /clock\.ts/ })
    .click();
  await app.waitForUrl((url) => url.searchParams.get("file") === "src/util/clock.ts");
  await expect
    .element(page.getByRole("link", { name: "View src/rank.ts" }))
    .toHaveAttribute(
      "href",
      expect.stringContaining(`/blob/work/src/rank.ts?source=${world.repos[0]!.sourceId}`),
    );
  await visual("Timeline changes - everything");

  // A copied link opens at the file.
  await app.navigate("/tracker/orbit/timelines/search/changes?file=src/rank.ts");
  await expect
    .element(
      page
        .getByRole("navigation", { name: "Changed files" })
        .getByRole("button", { name: /rank\.ts/ }),
    )
    .toHaveAttribute("aria-current", "true");

  // The nav leads on to Story.
  await nav.getByRole("link", { name: "Story" }).click();
  await app.waitForUrl((url) => url.pathname.endsWith("/timelines/search/story"));
});

test("a checkpoint's addition and what came since ask for the right commits", async () => {
  const server = await TestServer.start({ world: true });
  const world = await timelineWorld(server);
  const repo = world.repos[0]!;
  const first = (await checkpoint(server, world)).checkpoint.repos[0]!.commit;
  await work(server, world, repo);
  const second = (await checkpoint(server, world)).checkpoint.repos[0]!.commit;
  await work(server, world, repo);
  const asked: URL[] = [];
  // Main merged in between two timeline commits is part of what they compare.
  const merged = {
    oid: commitId(),
    summary: "Merge main",
    authorName: "Marco",
    authoredAt: 1,
    merge: true,
  };
  server.on("GET", "/api/repos/:owner/:name/compare", (request) => {
    asked.push(request.url);
    return compared(request, request.url.searchParams.has("base") ? { commits: [merged] } : {});
  });
  const app = renderApp("/tracker/orbit/timelines/search/changes?checkpoint=2");

  await expect
    .element(page.getByRole("heading", { level: 2 }))
    .toHaveTextContent("What checkpoint #2 added");
  await expect.element(page.getByText("Compared with checkpoint #1.")).toBeVisible();
  await expect
    .element(page.getByText("Includes what merging main brought in between."))
    .toBeVisible();
  await expect.poll(() => distinct(asked).length).toBe(1);
  expect(distinct(asked)[0]!.get("base")).toBe(first);
  expect(distinct(asked)[0]!.get("head")).toBe(second);

  // The first checkpoint is compared with main.
  await page.getByRole("link", { name: "What #1 added" }).click();
  await app.waitForUrl((url) => url.searchParams.get("checkpoint") === "1");
  await expect.element(page.getByText("Compared with main.")).toBeVisible();
  await expect
    .element(page.getByText("Includes what merging main brought in between."))
    .not.toBeInTheDocument();
  await expect.poll(() => distinct(asked).length).toBe(2);
  expect(distinct(asked)[1]!.get("head")).toBe(first);
  expect(distinct(asked)[1]!.has("base")).toBe(false);

  // Since a checkpoint: from its commit to the work as it is now.
  await page.getByRole("link", { name: "Since #1" }).click();
  await app.waitForUrl((url) => url.searchParams.get("since") === "1");
  await expect
    .element(page.getByRole("heading", { level: 2 }))
    .toHaveTextContent("Since checkpoint #1");
  await expect.poll(() => distinct(asked).length).toBe(3);
  expect(distinct(asked)[2]!.get("base")).toBe(first);
  expect(distinct(asked)[2]!.get("head")).toBe("work");
  await expect
    .element(page.getByText("Includes what merging main brought in between."))
    .toBeVisible();

  // And back to everything.
  await page.getByRole("link", { name: "Everything vs main" }).click();
  await app.waitForUrl((url) => !url.searchParams.has("since"));
  await expect
    .element(page.getByRole("heading", { level: 2 }))
    .toMatchTextContent(/^Everything this timeline changes/);

  // A checkpoint that doesn't exist says so.
  await app.navigate("/tracker/orbit/timelines/search/changes?checkpoint=9");
  await expect.element(page.getByText("This timeline has no checkpoint #9.")).toBeVisible();
});

test("several repositories: a switcher with each one's size, and never a silent one", async () => {
  const server = await TestServer.start({ world: true });
  await timelineWorld(server, { names: ["engine", "web"] });
  server.on("GET", "/api/repos/:owner/:name/compare", (request) =>
    request.params.name === "web"
      ? compared(request, {}, [file("app.tsx", 7, 2)])
      : compared(request),
  );
  const app = renderApp("/tracker/orbit/timelines/search/changes");

  await expect
    .element(page.getByText(/Showing\s+orbit\/engine\s+· 1 more repository/))
    .toBeVisible();
  const repos = page.getByRole("region", { name: "Repositories" });
  await expect
    .element(repos.getByRole("link", { name: /orbit\/engine/ }))
    .toMatchTextContent(/2 files/);
  await expect
    .element(repos.getByRole("link", { name: /orbit\/web/ }))
    .toMatchTextContent(/1 file\s*\+7\s*−2/);

  await repos.getByRole("link", { name: /orbit\/web/ }).click();
  await app.waitForUrl((url) => url.searchParams.get("repo") === "orbit/web");
  await expect.element(page.getByText(/Showing\s+orbit\/web\s+· 1 more repository/)).toBeVisible();
  await expect
    .element(
      page.getByRole("navigation", { name: "Timeline" }).getByRole("link", { name: "Story" }),
    )
    .toHaveAttribute("href", "/tracker/orbit/timelines/search/story?repo=orbit%2Fweb");
});

test("a diff too large to show, a failed comparison and one that couldn't find main each say what to do", async () => {
  const server = await TestServer.start({ world: true });
  await timelineWorld(server);
  let answer: "large" | "broken" | "ok" | "unmet" = "large";
  server.on("GET", "/api/repos/:owner/:name/compare", (request) =>
    answer === "large"
      ? reply({ error: "These changes are too large to show here." }, 413)
      : answer === "broken"
        ? reply({ error: "Something broke." }, 500)
        : answer === "ok"
          ? compared(request, { commits: [] }, [])
          : compared(request, { mergeBase: null, historyTruncated: true }),
  );
  const path = "/tracker/orbit/timelines/search/changes";

  // Too large: open the commits instead.
  let app = renderApp(path);
  await expect
    .element(page.getByText("These changes are too large to show here. Open the commits instead."))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "The commits" }))
    .toHaveAttribute("href", expect.stringContaining("/orbit/engine/commits/"));
  app.unmount();

  // Failed: it can be retried.
  answer = "broken";
  app = renderApp(path);
  await expect.element(page.getByRole("alert")).toHaveTextContent("Something broke.");
  answer = "ok";
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(page.getByText("No changes compared with main yet.")).toBeVisible();
  app.unmount();

  // No merge base: compared with main's tip, and said so.
  answer = "unmet";
  renderApp(path);
  await expect
    .element(page.getByRole("note"))
    .toMatchTextContent(/compared with\s+main.s tip directly/);
});

test("on a phone the page keeps to the screen", async () => {
  await page.viewport(390, 844);
  try {
    const server = await TestServer.start({ world: true });
    await timelineWorld(server, { names: ["engine", "web"] });
    server.on("GET", "/api/repos/:owner/:name/compare", (request) => compared(request));
    renderApp("/tracker/orbit/timelines/search/changes");
    await expect.element(page.getByText("3 commits", { exact: true })).toBeVisible();
    expect(sidewaysOverflow()).toBeLessThanOrEqual(0);
    const link = page
      .getByRole("navigation", { name: "Timeline" })
      .getByRole("link", { name: "Story" });
    expect(link.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await visual("Timeline changes - phone");
  } finally {
    await page.viewport(1280, 900);
  }
});

test("a timeline landed on a canonical bookmark shows what landing brought onto main (CORE-382)", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const fork = commitId();
  await server.push("orbit/engine", "main", fork);
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug: "legacy",
    name: "Legacy",
    repos: ["orbit/engine"],
  });
  const original = await server.call<TimelineDetail>("GET", "/api/tracker/orbit/timelines/legacy");
  const repo = original.timeline.repos[0]!;
  const [tip, merge] = [commitId(), commitId()];
  const detail: TimelineDetail = {
    ...original,
    timeline: {
      ...original.timeline,
      status: "landed",
      repos: [
        {
          ...repo,
          source: {
            ...repo.source!,
            kind: "canonical-historical",
            sourceId: "canonical",
            ref: "refs/heads/timeline/legacy",
          },
        },
      ],
    },
    events: [
      ...original.events,
      {
        id: "legacy-merge",
        seq: 2,
        timelineId: original.timeline.id,
        actorId: null,
        accountableId: null,
        createdAt: original.timeline.createdAt,
        kind: "merge",
        fromId: original.timeline.id,
        intoId: null,
        repoId: repo.id,
        commit: merge,
        parent: tip,
        refUpdateId: null,
      },
    ],
  };
  server.on("GET", "/api/tracker/:owner/timelines/:slug", () => detail);
  const compares: URL[] = [];
  server.on("GET", "/api/repos/:owner/:name/compare", (request) => {
    compares.push(request.url);
    return compared(request, {}, []);
  });
  let files = [file("src/landed.ts", 4, 1)];
  server.on("GET", "/api/repos/:owner/:name/commits/:oid/diff", ({ params }) =>
    params.oid === merge
      ? ({
          oid: merge,
          parents: [fork, tip],
          message: "Land legacy",
          authorName: "Marco",
          authoredAt: 1_790_000_000,
          truncated: false,
          files,
        } satisfies CommitDiff)
      : reply({ message: "Commit not found." }, 404),
  );

  // The tip main merged compares empty with main: the landing's own diff is shown.
  const app = renderApp("/tracker/orbit/timelines/legacy/changes");
  await expect
    .element(page.getByRole("heading", { level: 2 }))
    .toHaveTextContent(`What landing brought onto main (merge ${merge.slice(0, 7)})`);
  await expect.element(page.getByRole("table", { name: "Changes to src/landed.ts" })).toBeVisible();
  expect(compares).toEqual([]);
  app.unmount();

  // Nothing came onto main: the way on to the commits stays.
  files = [];
  renderApp("/tracker/orbit/timelines/legacy/changes");
  await expect
    .element(page.getByText("Landing brought no file changes onto main in orbit/engine."))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: `The landing commit on main (${merge.slice(0, 7)})` }))
    .toBeVisible();
  await expect.element(page.getByRole("link", { name: "The commits" })).toBeVisible();
});
