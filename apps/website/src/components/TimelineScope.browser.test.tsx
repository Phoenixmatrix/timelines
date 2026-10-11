// CORE-82 and CORE-86 in a real browser (formerly the E2E scenario
// browser-timeline-switcher-scopes-the-app): choosing a timeline in the rail
// scopes every page to it. The banner names it, links and navigation carry
// ?tl=, the code browser and CI follow its bookmark, the Knowledge tab's old
// ?timeline= becomes ?tl=, the graph's inspector flags it experimental (the
// banner shows it, Stalled leaves it out), and Back to main leaves it. The
// timeline, its owned work source and the flag are the Worker's own, in memory;
// file listings and CI runs are canned, with source addressing asserted.

import { expect, onTestFinished, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { CiRunList } from "../../shared/api.ts";
import type { Timeline, TimelineList } from "../../shared/timelines.ts";
import type { TrackerList } from "../../shared/tracker.ts";
import { commitId } from "../testing/atlas.ts";
import { cannedFiles } from "../testing/git.ts";
import { renderApp } from "../testing/render.tsx";
import { reply, TestServer } from "../testing/server.ts";

test("a timeline chosen in the rail scopes code, CI, Knowledge and the timelines graph", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const head = commitId();
  await server.push("orbit/engine", "main", head);
  const slug = `switch-${commitId().slice(0, 8)}`;
  const name = `Switcher ${slug.slice(-8)}`;
  const bookmark = "work";
  // Forking allocates a separately authorized source, never a canonical work bookmark.
  const created = await server.call<{ timeline: Timeline }>(
    "POST",
    "/api/tracker/orbit/timelines",
    {
      slug,
      name,
      repos: ["orbit/engine"],
    },
  );
  const source = created.timeline.repos[0]!.source!;
  expect(source.kind).toBe("timeline-work");
  const workHead = commitId();
  await server.push("orbit/engine", bookmark, workHead, source.sourceId);
  // Files, history and runs need git objects and runners, which aren't here.
  cannedFiles(server, workHead);
  server.on("GET", "/api/repos/:owner/:name/ci", (): CiRunList => ({ runs: [], runner: "local" }));

  const app = renderApp("/orbit/engine");
  const banner = page.getByRole("region", { name: "Timeline scope" });
  await expect.element(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();
  expect(banner.elements()).toHaveLength(0);

  await userEvent.click(page.getByRole("button", { name: /^Timeline: main/ }));
  await userEvent.click(page.getByRole("link", { name: new RegExp(name) }));
  await app.waitForUrl(
    (url) =>
      url.searchParams.get("tl") === slug && url.searchParams.get("source") === source.sourceId,
  );
  await expect.element(banner).toMatchTextContent(name);
  await expect.element(page.getByLabelText("Branch or tag")).toMatchTextContent(bookmark);
  const readme = page.getByRole("link", { name: "README.md", exact: true });
  await expect
    .poll(() =>
      new URL(readme.element().getAttribute("href")!, "https://gitmatrix.invalid").searchParams.get(
        "source",
      ),
    )
    .toBe(source.sourceId);
  expect(
    server.requests.some(
      (request) =>
        request.url.pathname.endsWith("/tree") &&
        request.url.searchParams.get("source") === source.sourceId,
    ),
  ).toBe(true);

  // Links carry the scope, and so does navigating by them.
  const ci = page.getByRole("link", { name: "CI", exact: true });
  await expect.poll(() => ci.element().getAttribute("href")).toMatch(new RegExp(`[?&]tl=${slug}`));
  await userEvent.click(ci);
  await app.waitForUrl((url) => url.pathname.endsWith("/ci"));
  expect(app.url().searchParams.get("tl"), "Navigation keeps the scope").toBe(slug);
  expect(
    server.requests.some(
      (r) =>
        r.url.pathname === "/api/repos/orbit/engine/ci" &&
        r.url.searchParams.get("ref") === bookmark &&
        r.url.searchParams.get("source") === source.sourceId,
    ),
    "CI lists the bookmark's runs",
  ).toBe(true);

  // The Knowledge tab's ?timeline= from before the switcher becomes ?tl=.
  await app.navigate(`/orbit/engine/knowledge?timeline=${slug}`);
  await app.waitForUrl((url) => url.searchParams.get("tl") === slug);
  expect(app.url().searchParams.get("timeline")).toBeNull();
  await expect.element(banner).toMatchTextContent(name);

  // The same rail control opens the graph without dropping the account or scope.
  const rail = page.getByRole("button", { name: /^Timeline: / });
  await expect.element(rail).not.toHaveAttribute("aria-current");
  await userEvent.click(rail);
  await userEvent.click(page.getByRole("link", { name: "Timeline graph", exact: true }));
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit/timelines");
  expect(app.url().searchParams.get("tl"), "The graph keeps the selected timeline").toBe(slug);
  await expect.element(rail).toHaveAttribute("aria-current", "page");

  // CORE-86: the graph's inspector flags it experimental, which the banner
  // shows, and the Stalled view leaves it out.
  const flag = page.getByRole("switch", { name: "Experimental" });
  await expect.element(flag).toHaveAttribute("aria-checked", "false");
  await userEvent.click(flag);
  await expect.element(flag).toHaveAttribute("aria-checked", "true");
  await expect.element(banner.getByText("Experimental", { exact: true })).toBeVisible();
  const listed = await server.call<TimelineList>("GET", "/api/tracker/orbit/timelines");
  expect(listed.timelines.find((t) => t.slug === slug)?.experimental).toBe(true);
  await userEvent.click(page.getByRole("button", { name: /^Stalled/ }));
  await expect.element(page.getByText(/Experimental timelines are left out/)).toBeVisible();

  await userEvent.click(banner.getByRole("link", { name: "Back to main" }));
  await app.waitForUrl((url) => url.searchParams.get("tl") === "main");
  expect(app.url().searchParams.get("source")).toBeNull();
  await expect.element(banner).not.toBeInTheDocument();
});

test("settings graph navigation keeps its account and position while the list loads", async () => {
  const server = await TestServer.start({ world: true });
  const trackers = await server.call<TrackerList>("GET", "/api/tracker");
  const personal = trackers.trackers.find((tracker) => tracker.slug === "marco")!;
  server.on("GET", "/api/tracker", { ...trackers, defaultOwnerId: personal.id });
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  server.on("GET", "/api/tracker/orbit/timelines", async () => {
    await response;
    return { timelines: [] };
  });

  const app = renderApp("/settings/ai?owner=orbit");
  await userEvent.click(page.getByRole("button", { name: /^Timeline: main/ }));
  const graph = page.getByRole("link", { name: "Timeline graph", exact: true });
  await expect.element(graph).toHaveAttribute("href", "/tracker/orbit/timelines");
  await expect.element(page.getByText("Loading timelines…")).toBeVisible();
  // Measure the data transition, not the popover's separate entrance motion.
  const popup = page.getByRole("dialog", { name: "Timeline", exact: true });
  await expect.element(popup).not.toHaveAttribute("data-starting-style");
  await Promise.all(
    popup
      .element()
      .getAnimations()
      .map((animation) => animation.finished),
  );
  await graph.click({ trial: true });
  const before = graph.element().getBoundingClientRect();
  release();
  await expect.element(page.getByText("Loading timelines…")).not.toBeInTheDocument();
  await graph.click({ trial: true });
  const after = graph.element().getBoundingClientRect();
  // A moving target can receive pointer-down on the link and pointer-up outside it.
  expect(after.x).toBeCloseTo(before.x);
  expect(after.y).toBeCloseTo(before.y);
  await userEvent.click(graph);
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit/timelines");
  await expect.element(page.getByRole("heading", { name: "Timelines", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: /^Timeline: main/ }))
    .toHaveAttribute("aria-current", "page");
});

test.each(["empty", "failed"] as const)(
  "Home can open the default account's graph when its timeline list is %s",
  async (state) => {
    const server = await TestServer.start({ world: true });
    const trackers = await server.call<TrackerList>("GET", "/api/tracker");
    const owner = trackers.trackers.find((tracker) => tracker.slug === "orbit")!;
    server.on("GET", "/api/tracker", { ...trackers, defaultOwnerId: owner.id });
    server.on("GET", "/api/tracker/orbit/timelines", () =>
      state === "empty"
        ? ({ timelines: [] } satisfies TimelineList)
        : reply({ error: "Timeline list temporarily unavailable" }, 503),
    );

    const app = renderApp("/");
    const rail = page.getByRole("button", { name: /^Timeline: main/ });
    await userEvent.click(rail);
    await expect
      .element(
        page.getByText(
          state === "empty"
            ? /orbit has no timelines yet/
            : /Timeline list temporarily unavailable/,
        ),
      )
      .toBeVisible();
    const graph = page.getByRole("link", { name: "Timeline graph", exact: true });
    await expect.element(graph).toHaveAttribute("href", "/tracker/orbit/timelines");
    await userEvent.click(graph);
    await app.waitForUrl((url) => url.pathname === "/tracker/orbit/timelines");
    await expect
      .element(page.getByRole("heading", { name: "Timelines", exact: true }))
      .toBeVisible();
    await expect.element(rail).toHaveAttribute("aria-current", "page");
  },
);

test("Home keeps graph navigation available without a resolved account", async () => {
  const server = await TestServer.start({ world: true });
  const trackers = await server.call<TrackerList>("GET", "/api/tracker");
  server.on("GET", "/api/tracker", {
    ...trackers,
    trackers: [],
    defaultOwnerId: null,
  } satisfies TrackerList);

  const app = renderApp("/");
  const rail = page.getByRole("button", { name: /^Timeline: main/ });
  await userEvent.click(rail);
  const graph = page.getByRole("link", { name: "Timeline graph", exact: true });
  await expect.element(graph).toHaveAttribute("href", "/timelines");
  await userEvent.click(graph);
  await app.waitForUrl((url) => url.pathname === "/timelines");
  await expect.element(page.getByText(/No trackers are available to this account/)).toBeVisible();
  await expect.element(rail).toHaveAttribute("aria-current", "page");
});
