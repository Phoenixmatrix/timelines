import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { TimelineGraphData } from "../../../shared/timeline-graph.ts";
import { sidewaysOverflow } from "../../testing/atlas.ts";
import { focusOn, press, tap } from "../../testing/focus.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { timelineWorld } from "../../testing/timelines.ts";
import { visual } from "../../testing/visual.ts";

const graph = () => page.getByRole("region", { name: "Timeline graph" });
const select = (name: string) => graph().getByRole("link", { name: `Select ${name}`, exact: true });

test("timeline rows select through native links, preserve parameters and restore scope with Back", async () => {
  const server = await TestServer.start({ world: true });
  const world = await timelineWorld(server);
  await server.call("POST", "/api/repos/orbit/engine/steps", {
    changeId: "timelineselection",
    commitOid: world.repos[0]!.tip,
    committedAt: new Date().toISOString(),
    timeline: world.slug,
    summary: "Timeline selection works",
  });
  const app = renderApp("/tracker/orbit/timelines?keep=value");
  await expect.element(select("main")).toHaveAttribute("aria-current", "true");
  await expect.element(select("Search")).toBeVisible();
  const target = select("Search").element().getBoundingClientRect();
  expect(target.height).toBeGreaterThanOrEqual(44);
  expect(target.width).toBeGreaterThan(240);
  // Modified and middle clicks must remain native, not select in this tab.
  // Cancel only at the document boundary, after the router had its chance.
  for (const options of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    let intercepted: boolean | undefined;
    const observe = (event: MouseEvent) => {
      intercepted = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", observe, { once: true });
    select("Search")
      .element()
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options }),
      );
    expect(intercepted).toBe(false);
    expect(app.url().searchParams.has("tl")).toBe(false);
  }
  // The lane side, well outside the name, is part of the same native link.
  await select("Search").click({ position: { x: 4, y: 20 } });
  await app.waitForUrl((url) => url.searchParams.get("tl") === "search");
  expect(app.url().searchParams.get("keep")).toBe("value");
  await expect.element(select("Search")).toHaveAttribute("aria-current", "true");
  expect(select("Search").element().parentElement?.textContent).toContain("Selected");
  await expect
    .element(page.getByRole("region", { name: "Live now" }).getByText("Timeline selection works"))
    .toBeVisible();
  await visual("Timelines - graph");
  await focusOn(select("main"));
  await expect.element(select("main")).toHaveFocus();
  // Main is explicit so the app-wide scope carrier cannot restore Search.
  await expect
    .element(select("main"))
    .toHaveAttribute("href", "/tracker/orbit/timelines?keep=value&tl=main");
  await press("Enter");
  await app.waitForUrl((url) => url.searchParams.get("tl") === "main");
  await expect.element(select("main")).toHaveAttribute("aria-current", "true");
  await app.back();
  await app.waitForUrl((url) => url.searchParams.get("tl") === "search");
  await expect.element(select("Search")).toHaveAttribute("aria-current", "true");
  await app.forward();
  await app.waitForUrl((url) => url.searchParams.get("tl") === "main");
  expect(app.url().searchParams.get("keep")).toBe("value");
  expect(server.requests.filter((request) => request.status >= 500)).toEqual([]);
});

test("landed rows keep main, commit and lane controls separate from selection", async () => {
  const server = await TestServer.start({ world: true });
  const world = await timelineWorld(server);
  // Landing is recorded by external git machinery; reuse the real timeline
  // and supply its completed event to exercise the graph's interaction boundary.
  server.on("GET", "/api/tracker/:owner/timeline-graph", async () => {
    const data = await server.call<TimelineGraphData>("GET", "/api/tracker/orbit/timeline-graph");
    const timeline = data.timelines.find((t) => t.slug === world.slug)!;
    timeline.status = "landed";
    data.events.push({
      id: "landed-search",
      seq: 999,
      timelineId: timeline.id,
      actorId: "acc_marco",
      accountableId: "acc_marco",
      createdAt: timeline.updatedAt,
      kind: "merge",
      fromId: timeline.id,
      intoId: null,
      repoId: world.repos[0]!.id,
      commit: world.repos[0]!.tip,
      parent: world.repos[0]!.main,
      refUpdateId: null,
    });
    return data;
  });
  const app = renderApp("/tracker/orbit/timelines");
  await graph().getByRole("button", { name: "Draw Search's lane" }).click();
  expect(app.url().searchParams.has("tl")).toBe(false);
  await graph().getByRole("button", { name: "Fold Search onto main" }).click();
  expect(app.url().searchParams.has("tl")).toBe(false);
  await select("Search").click();
  await app.waitForUrl((url) => url.searchParams.get("tl") === "search");
  await expect.element(select("Search")).toHaveAttribute("aria-current", "true");
  // A link to the other timeline in the event does not select its containing row.
  await graph()
    .getByRole("listitem")
    .filter({
      has: page.getByRole("link", { name: "Select Search", exact: true }),
    })
    .getByRole("link", { name: "main", exact: true })
    .click();
  await app.waitForUrl((url) => url.searchParams.get("tl") === "main");
  // The router location updates before React refreshes the scoped link hrefs.
  await expect.element(select("main")).toHaveAttribute("aria-current", "true");
  const commit = graph().getByRole("link", { name: /^engine@/ });
  const destination = new URL(commit.element().getAttribute("href")!, location.origin);
  await commit.click();
  await app.waitForUrl(
    (url) => url.pathname === destination.pathname && url.search === destination.search,
  );
});

test("phone timeline rows are touch targets without widening the page", async () => {
  await page.viewport(390, 844);
  try {
    const server = await TestServer.start({ world: true });
    await timelineWorld(server);
    const app = renderApp("/tracker/orbit/timelines");
    await expect.element(select("Search")).toBeVisible();
    expect(select("Search").element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(sidewaysOverflow()).toBeLessThanOrEqual(0);
    await tap(select("Search"));
    await app.waitForUrl((url) => url.searchParams.get("tl") === "search");
    await expect.element(select("Search")).toHaveAttribute("aria-current", "true");
    await tap(select("main"));
    await app.waitForUrl((url) => url.searchParams.get("tl") === "main");
    await expect.element(select("main")).toHaveAttribute("aria-current", "true");
  } finally {
    await page.viewport(1280, 900);
  }
});
