// The timeline graph's rows and panel (CORE-402) in a real browser, against
// the tracker in memory: rows say what happened (a checkpoint's number and
// summary, who approved it and what they said, how far its landing got, who
// forked), a row with more opens in place with the lanes running on through
// it, lanes get room when there are few, and the selected timeline's panel is
// sections that open and close, remembered, with no event list.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { askApproval, checkpoint, mutate, timelineWorld, work } from "../../testing/timelines.ts";

async function world() {
  const server = await TestServer.start({ world: true });
  const search = await timelineWorld(server, { slug: "search", name: "Search v2" });
  const repo = search.repos[0]!;
  await checkpoint(server, search, "Index the docs and rank by recency.\n\nAlso adds a cache.");
  await work(server, search, repo);
  const second = await checkpoint(server, search, "Keep score as the tie-breaker.");
  await askApproval(server, search, second.checkpoint.id);
  await mutate(server, [
    { kind: "request.answer", id: "approve", data: { approved: true, answer: "Looks good" } },
  ]);
  return server;
}

/** Other tests share this browser's storage: start from each section's default. */
function forgetPanel() {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("gitmatrix:timeline-panel:")) localStorage.removeItem(key);
  } catch {
    // Storage is a convenience.
  }
}

const graph = () => page.getByRole("region", { name: "Timeline graph" });
const row = (text: RegExp) => graph().getByRole("listitem").filter({ hasText: text });

test("graph rows say what happened, and a row with more opens in place with its lane unbroken", async () => {
  await world();
  renderApp("/tracker/orbit/timelines?tl=search");
  await expect
    .element(row(/Checkpoint #2/))
    .toMatchTextContent(/Checkpoint #2\s*Keep score as the tie-breaker\./);
  await expect
    .element(row(/Checkpoint #1/))
    .toMatchTextContent(/Index the docs and rank by recency\./);
  // Only the first line on the row; the rest is behind Details.
  expect(row(/Checkpoint #1/).element().textContent).not.toContain("Also adds a cache.");
  await expect.element(row(/#2 approved/)).toMatchTextContent(/by Marco Bellini: “Looks good”/);
  await expect.element(row(/Landing #2/)).toMatchTextContent(/entered the landing queue/);
  await expect.element(row(/Forked/)).toMatchTextContent(/Forked\s*from main/);
  await expect.element(row(/Search v2/).first()).toMatchTextContent(/Lands after approval/);

  // Lanes get room when there are few: main and Search v2 are well apart.
  const lanes = graph().getByTestId("timeline-lanes").element();
  const x = (slug: string) =>
    Number(lanes.querySelector(`[data-lane="${slug}"]`)!.getAttribute("x1"));
  expect(Math.abs(x("search") - x("main"))).toBeGreaterThanOrEqual(30);

  const lane = () => lanes.querySelector('[data-lane="search"]')!;
  const length = () => Number(lane().getAttribute("y2")) - Number(lane().getAttribute("y1"));
  const before = length();
  const details = graph().getByRole("button", { name: "Details: checkpoint #2 of Search v2" });
  await expect.element(details).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(details);
  await expect.element(details).toHaveAttribute("aria-expanded", "true");
  // The checkpoint's own panel: its commits, CI and previews.
  await expect
    .element(graph().getByRole("region", { name: "Checkpoint #2 of search" }))
    .toBeVisible();
  // The lane runs on through the opened row, and the drawing covers every row.
  await expect.poll(length).toBeGreaterThan(before + 40);
  const list = graph().getByRole("list").first().element();
  await expect
    .poll(() =>
      Math.abs(lanes.getBoundingClientRect().height - list.getBoundingClientRect().height),
    )
    .toBeLessThanOrEqual(2);
  await userEvent.click(details);
  await expect.element(details).toHaveAttribute("aria-expanded", "false");
  await expect.poll(length).toBe(before);
});

test("the timeline panel is sections that open and close, remembered, and lists no events", async () => {
  await world();
  forgetPanel();
  const app = renderApp("/tracker/orbit/timelines?tl=search");
  const panel = page.getByRole("region", { name: "Selected timeline" });
  // A section is a <details> whose summary starts with its title.
  const section = (title: string) =>
    [...panel.element().querySelectorAll<HTMLDetailsElement>("details")].find((d) =>
      d.querySelector(":scope > summary")?.textContent?.startsWith(title),
    );
  const summary = (title: string) => section(title)!.querySelector(":scope > summary")!;
  await expect.poll(() => section("Checkpoints")).toBeTruthy();
  // What has content opens; the rest says what's inside while closed.
  const open = (title: string) => section(title)?.open;
  expect(open("Checkpoints")).toBe(true);
  expect(open("Landing")).toBe(true);
  expect(open("Code")).toBe(false);
  expect(open("Settings")).toBe(false);
  expect(summary("Checkpoints").textContent).toMatch(/2 · #2 approved/);
  expect(summary("Code").textContent).toMatch(/1 repository/);
  await expect.element(panel.getByRole("heading", { name: "Events" })).not.toBeInTheDocument();

  // Opened once, it stays open next time.
  await userEvent.click(summary("Code"));
  await expect.poll(() => open("Code")).toBe(true);
  await expect.element(panel.getByRole("link", { name: "Commits" })).toBeVisible();
  app.unmount();
  renderApp("/tracker/orbit/timelines?tl=search");
  await expect.poll(() => section("Code")).toBeTruthy();
  expect(open("Code")).toBe(true);
  forgetPanel();
});
