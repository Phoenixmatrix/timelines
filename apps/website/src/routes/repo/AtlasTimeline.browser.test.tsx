// CORE-176 and CORE-186 in a real browser (formerly the E2E scenario
// browser-atlas-timeline-in-capabilities-ended-and-expired): a timeline read
// in Atlas terms on the Knowledge tab with `?tl=`. Its bookmark's overlay
// (stored as the overlay step would, without a build) gives the repository's
// facts, the capabilities it touches, each file placed where main's map puts
// it, a capability filter in the address and a source handoff on the
// timeline's commit that Back returns from; the workspace Atlas reads the same
// timeline per repository. Then it ends, and retention removes the ended
// overlay's data (CORE-201) and the panel says so.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { RepoSummary } from "../../../shared/api.ts";
import type { AtlasTimeline } from "../../../shared/atlas.ts";
import type { TimelineDetail } from "../../../shared/timelines.ts";
import { atlasFixtureRepo, commitId, settled } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer, type Recorded } from "../../testing/server.ts";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("a timeline in capabilities, across repositories, ended, then removed by retention", async () => {
  const server = await TestServer.start({ world: true });
  const repo = await atlasFixtureRepo(server);
  await server.repo("orbit", "engine");
  const slug = `atlas-${commitId().slice(0, 8)}`;
  const bookmark = `timeline/${slug}`;
  // Allocate a real owned source: work never moves canonical main.
  const created = await server.call<TimelineDetail>("POST", "/api/tracker/orbit/timelines", {
    slug,
    repos: [{ repo: `orbit/${repo.name}`, commit: repo.head }],
  });
  const sourceId = created.timeline.repos[0]!.source!.sourceId;
  const tip = commitId();
  await server.push(`orbit/${repo.name}`, "work", tip, sourceId);
  await repo.dev({ action: "overlay", ref: bookmark, sourceId, commit: tip, base: repo.head });
  const expected = await server.call<AtlasTimeline>(
    "GET",
    `${repo.api}/atlas/timeline?ref=${encodeURIComponent(bookmark)}`,
  );
  expect(expected.repos[0]!.sourceId).toBe(sourceId);
  expect(sourceId, "Timeline evidence has an owned source").toMatch(/^work_/);
  const search = expected.regions?.find((r) => r.id !== "group:unclassified");
  expect(search, "The timeline touches search's capability").toBeDefined();
  const reached = search!.imports.added[0]?.name;
  expect(reached, "Search's new import reaches another capability").toBeTruthy();

  /**
   * Bounded Atlas reads of this repository only; never the overlay's whole list
   * or the graph. The source handoff opens the file view, whose knowledge rail
   * reads that one node (`/graph/node`): bounded, so allowed.
   */
  const expectBounded = (reads: Recorded[]) => {
    for (const { url } of reads) {
      if (url.pathname.includes("/graph"))
        expect(url.pathname).toMatch(/\/knowledge\/graph\/node$/);
      expect(url.pathname).not.toMatch(/\/knowledge\/overlay$/);
      expect(url.pathname).not.toContain("/knowledge/search");
      if (/\/atlas\/[a-z]+$/.test(url.pathname))
        expect(url.pathname.startsWith(`${repo.api}/atlas/`), url.pathname).toBe(true);
    }
  };
  const timelineReads = (mark: number) =>
    server.since(mark).filter((r) => r.url.pathname === `${repo.api}/atlas/timeline`);

  // 1. The timeline in the Selection pane: its repository's facts, each known.
  let mark = server.requests.length;
  const app = renderApp(`${repo.base}?tl=${slug}`);
  const panel = page.getByRole("region", { name: `Timeline ${slug}` });
  await expect.element(panel.getByRole("heading", { name: bookmark, level: 2 })).toBeVisible();
  const facts = panel.getByRole("region", { name: `orbit/${repo.name} on ${bookmark}` });
  const short = (oid: string) => oid.slice(0, 7);
  await expect.element(facts).toMatchTextContent("Up to date");
  await expect.element(facts).toMatchTextContent(`Bookmark${short(tip)}`);
  await expect
    .element(facts)
    .toMatchTextContent(`Main base${short(repo.head)} · the same main as this map`);
  await expect.element(facts).toMatchTextContent(`Merge base${short(repo.head)}`);
  await expect.element(facts).toMatchTextContent(`This map${short(repo.head)}`);

  // 2. The capabilities it touches, and its files placed in them: the new file
  // by the timeline's regrouping (CORE-186), computed over the capabilities
  // it touches, and said to be.
  const touched = panel.getByRole("region", { name: "Capabilities it touches" });
  await expect
    .element(touched.getByRole("button", { name: search!.name, exact: true }))
    .toBeVisible();
  await expect.element(touched).toMatchTextContent("1 new, 1 changed files");
  await expect.element(touched).not.toMatchTextContent("provisionally");
  await expect.element(touched).toMatchTextContent(`New imports reach ${reached}.`);
  await expect
    .element(touched.getByRole("button", { name: "Unclassified", exact: true }))
    .toBeVisible();
  const files = panel.getByRole("region", { name: "Files it changes" });
  const suggest = files.getByRole("listitem").filter({ hasText: "search/suggest.ts" });
  await expect
    .element(suggest)
    .toMatchTextContent(`New: the timeline's regrouping puts it in ${search!.name}.`);
  await expect
    .element(files.getByRole("listitem").filter({ hasText: "notify/email.ts" }))
    .toMatchTextContent("Unclassified: the timeline's regrouping finds nothing to place it by.");
  await expect
    .element(files.getByRole("listitem").filter({ hasText: "search/rank.ts" }))
    .toMatchTextContent(`Now imports from ${reached}`);
  await expect
    .element(panel)
    .toMatchTextContent(
      "Regrouping was computed for this timeline over the 2 capabilities it touches (13 files), not the whole repository, against main's build #1, this map.",
    );
  await expect.element(panel).toMatchTextContent("Syntax changes cover all 4 changed files");
  // The capabilities it touches, marked on the map and in the outline, in words.
  const marked = `touched by timeline ${slug}`;
  await expect
    .element(
      page.getByRole("img", { name: new RegExp(`1 outlined with a dashed line: ${marked}`) }),
    )
    .toBeVisible();
  const outline = page.getByRole("tree", { name: `Outline of orbit/${repo.name}` });
  const markedRows = () =>
    outline.getByRole("treeitem", { name: new RegExp(marked) }).elements().length;
  await expect
    .element(
      outline.getByRole("treeitem", { name: new RegExp(`^${escape(search!.name)}.*${marked}`) }),
    )
    .toBeVisible();
  expect(markedRows()).toBe(1);
  await settled(server);
  expect(timelineReads(mark).length, "The panel read GET /atlas/timeline").toBeGreaterThan(0);
  expectBounded(server.since(mark));
  // Without the timeline (on main: a bare link would keep the scope), nothing is marked.
  await app.navigate(`${repo.base}?tl=main`);
  await expect.element(page.getByRole("img", { name: /Capability map/ })).toBeVisible();
  await expect.element(page.getByRole("img", { name: new RegExp(marked) })).not.toBeInTheDocument();
  expect(markedRows()).toBe(0);
  await app.navigate(`${repo.base}?tl=${slug}`);
  await expect.poll(markedRows).toBe(1);

  // 3. Its capability on the map, then only the timeline's changes there.
  mark = server.requests.length;
  await userEvent.click(touched.getByRole("button", { name: search!.name, exact: true }));
  await app.waitForUrl((url) => url.searchParams.get("select") === search!.id);
  await expect
    .element(page.getByRole("heading", { name: search!.name, exact: true, level: 2 }))
    .toBeVisible();
  await userEvent.click(
    panel.getByRole("button", { name: `Only this timeline's changes in ${search!.name}` }),
  );
  await app.waitForUrl((url) => url.searchParams.get("tlwithin") === search!.id);
  expect(app.url().searchParams.get("tl"), "The scope stays").toBe(slug);
  await expect.element(panel).toMatchTextContent(`Only in ${search!.name}: 2 files`);
  await expect.element(files).not.toMatchTextContent("notify/email.ts");
  await expect.element(suggest).toBeVisible();
  const filtered = app.url();
  const baseLink = files
    .getByRole("listitem")
    .filter({ hasText: "search/rank.ts" })
    .getByRole("link", { name: `Main's, at ${short(repo.head)}` })
    .element() as HTMLAnchorElement;
  const baseUrl = new URL(baseLink.href);
  expect(baseUrl.pathname).toBe(`/orbit/${repo.name}/blob/${repo.head}/search/rank.ts`);
  expect(baseUrl.searchParams.get("source")).toBe("canonical");
  expect(baseUrl.searchParams.get("tl")).toBe("main");

  // 4. Source on the timeline's commit, scoped to the timeline; Back returns.
  await userEvent.click(suggest.getByRole("link", { name: `Source at ${short(tip)}` }));
  await app.waitForUrl(
    (url) =>
      url.pathname === `/orbit/${repo.name}/blob/${tip}/search/suggest.ts` &&
      url.searchParams.get("tl") === slug &&
      url.searchParams.get("source") === sourceId,
  );
  await app.back();
  await app.waitForUrl((url) => url.href === filtered.href);
  await expect.element(panel).toMatchTextContent(`Only in ${search!.name}: 2 files`);
  expectBounded(server.since(mark));

  // 4b. Across repositories (CORE-186): the workspace Atlas reads the same
  // timeline in each selected repository, each part on its own; engine has no
  // such timeline and says so. Its capabilities are marked there too.
  // Going back re-reads the repository's Atlas; let that finish first, so
  // everything after the mark is the workspace page's own (CORE-247).
  await settled(server);
  mark = server.requests.length;
  await app.navigate(`/orbit/-/atlas?repos=${repo.name},engine&tl=${slug}`);
  const workspace = page.getByRole("region", { name: `Timeline ${slug}` });
  await expect
    .element(workspace.getByRole("region", { name: `orbit/${repo.name} on ${bookmark}` }))
    .toMatchTextContent("Up to date");
  await expect
    .element(workspace.getByRole("region", { name: `orbit/engine on ${bookmark}` }))
    .toMatchTextContent("Not in this repository");
  const workspaceFiles = workspace.getByRole("region", { name: "Files it changes" });
  await expect.poll(() => workspaceFiles.getByRole("listitem").elements().length).toBe(4);
  await expect
    .element(
      workspaceFiles.getByRole("listitem").filter({ hasText: `${repo.name}: search/suggest.ts` }),
    )
    .toMatchTextContent(`New: the timeline's regrouping puts it in ${search!.name}.`);
  await expect
    .element(
      page
        .getByRole("tree", { name: new RegExp(`^Outline of ${escape(repo.name)}`) })
        .getByRole("treeitem", { name: new RegExp(`touched by timeline ${slug}`) }),
    )
    .toBeVisible();
  await settled(server);
  for (const { url } of server.since(mark))
    if (/\/atlas\/[a-z]+$/.test(url.pathname))
      expect(url.pathname.startsWith("/api/spaces/orbit/atlas/"), url.pathname).toBe(true);
  expect(
    server.since(mark).some((r) => r.url.pathname === "/api/spaces/orbit/atlas/timeline"),
    "The workspace panel read GET /api/spaces/:space/atlas/timeline",
  ).toBe(true);

  // 5. The timeline lands: the panel says so. That its overlay is read-only
  // and asks for nothing is worker/knowledge/ended.test.ts's; an expired
  // snapshot's link, Atlas.browser.test.tsx's.
  await repo.dev({ action: "end", ref: bookmark, sourceId, reason: "landed" });
  await app.navigate(`${repo.base}?tl=${slug}`);
  await expect.element(panel).toMatchTextContent("This timeline landed");

  // 6. CORE-201: 100 days on, retention ("ended-timeline-data", 90 days)
  // removes the ended overlay's changes and pages; the panel says so.
  const resource = await server.call<RepoSummary>("GET", repo.api);
  const { run } = await server.call<{ run: { status: string; items: number } }>(
    "POST",
    "/api/dev/retention",
    {
      target: { kind: "space", id: resource.space.id },
      categories: { "ended-timeline-data": { days: 90 } },
      daysAhead: 100,
    },
  );
  expect(run.status).toBe("succeeded");
  expect(run.items, "The overlay's changes go").toBeGreaterThanOrEqual(4);
  app.unmount();
  renderApp(`${repo.base}?tl=${slug}`);
  await expect.element(panel).toMatchTextContent("This timeline landed");
  await expect
    .element(panel)
    .toMatchTextContent("Its overlay and wiki pages were removed by retention on");
  await expect.element(files).toMatchTextContent("Removed by retention.");
  await expect
    .element(panel.getByRole("region", { name: "Timeline wiki pages" }))
    .toMatchTextContent("Removed by retention on");
});
