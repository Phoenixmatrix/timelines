// Agent work (CORE-220), in a real browser: what your agents finished lately
// across trackers, sliced by agent, tracker, window and type, each issue's
// linked work loaded only when its row is opened.

import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { LinkedWork } from "../../shared/chronicle.ts";
import type { CompletedWork, CompletedWorkList } from "../../shared/tracker.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const row = (over: Partial<CompletedWork> & Pick<CompletedWork, "issue">): CompletedWork => ({
  tracker: { slug: "orbit", displayName: "Orbit" },
  completion: { actorId: "agt-bot", accountableId: "priya", agent: "laptop", at: hoursAgo(2) },
  timeline: null,
  evidence: null,
  ...over,
});

const LIST: CompletedWorkList = {
  since: hoursAgo(14 * 24),
  agents: [
    { id: "agt-bot", name: "bot", revoked: false },
    { id: "agt-helper", name: "helper", revoked: false },
  ],
  trackers: [
    { slug: "orbit", displayName: "Orbit" },
    { slug: "priya", displayName: "Priya" },
  ],
  items: [
    row({
      issue: { id: "orb-1", key: "ORB-1", title: "Index the docs", type: "task", status: "done" },
      evidence: "vp test passed (12 files)",
    }),
    row({
      tracker: { slug: "priya", displayName: "Priya" },
      issue: {
        id: "pri-2",
        key: "PRI-2",
        title: "Fix the search crash",
        type: "bug",
        status: "done_in_timeline",
      },
      completion: { actorId: "agt-helper", accountableId: "priya", agent: null, at: hoursAgo(5) },
      timeline: { id: "tl-search", slug: "search" },
    }),
  ],
  truncated: false,
};

const WORK: LinkedWork = {
  issue: { id: "orb-1", key: "ORB-1", title: "Index the docs", status: "done" },
  commits: [
    {
      repo: { id: "r-app", space: "orbit", name: "app" },
      oid: "a".repeat(40),
      changeId: null,
      summary: "Build the docs index",
      at: hoursAgo(3),
      sources: ["step"],
      href: "/orbit/app/commit/" + "a".repeat(40),
    },
  ],
  steps: [],
  runs: [],
  deployments: [],
  packages: [],
  timelines: [],
  releaseNotes: [],
  mentions: [],
  truncated: false,
};

const item = (key: string) => page.getByRole("listitem").filter({ hasText: key });
const workRequests = (server: TestServer) =>
  server.requests.filter((request) => request.url.pathname.endsWith("/work"));

test("lists what my agents finished, filters it, and loads an issue's work only when opened", async () => {
  const server = await TestServer.start({ world: true });
  server.on("GET", "/api/agent-work", ({ url }) => ({
    ...LIST,
    // A wider window finds an older one too.
    items:
      url.searchParams.get("since") === "30d"
        ? [
            ...LIST.items,
            row({
              issue: {
                id: "orb-9",
                key: "ORB-9",
                title: "Old work",
                type: "chore",
                status: "done",
              },
              completion: {
                actorId: "agt-bot",
                accountableId: "priya",
                agent: null,
                at: hoursAgo(20 * 24),
              },
            }),
          ]
        : LIST.items,
  }));
  server.on("GET", "/api/tracker/:space/issues/:issue/work", WORK);
  const app = renderApp("/agent-work");

  await expect.element(page.getByRole("heading", { name: "Agent work", level: 1 })).toBeVisible();
  await expect.element(item("ORB-1")).toBeVisible();
  await expect.element(item("ORB-1").getByText("vp test passed (12 files)")).toBeVisible();
  await expect.element(item("ORB-1").getByText("laptop")).toBeVisible();
  await expect.element(item("PRI-2").getByText("search", { exact: true })).toBeVisible();
  await expect.element(page.getByText("2 issues in the last 14 days.")).toBeVisible();
  await expect
    .element(item("ORB-1").getByRole("link", { name: /ORB-1/ }))
    .toHaveAttribute("href", "/tracker/orbit/issues/orb-1");
  // Nothing is fetched per row up front.
  expect(workRequests(server)).toEqual([]);

  // Opening a row loads that issue's linked work, and only that issue's.
  const toggle = page.getByRole("button", { name: "Work behind ORB-1" });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(item("ORB-1").getByText("Build the docs index")).toBeVisible();
  expect(workRequests(server).map((request) => request.url.pathname)).toEqual([
    "/api/tracker/orbit/issues/orb-1/work",
  ]);

  // Slice by agent, then by type: the URL keeps the filters.
  await page.getByRole("combobox", { name: "Agent" }).click();
  await page.getByRole("option", { name: "helper" }).click();
  await app.waitForUrl((url) => url.searchParams.get("agent") === "helper");
  await expect.element(item("PRI-2")).toBeVisible();
  await expect.element(page.getByText("1 issue in the last 14 days.")).toBeVisible();
  expect(item("ORB-1").elements()).toHaveLength(0);
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "Task" }).click();
  await expect
    .element(page.getByText("Nothing finished in the last 14 days that matches."))
    .toBeVisible();
  const loads = server.requests.filter((r) => r.url.pathname === "/api/agent-work").length;
  // Slicing doesn't ask the server again.
  expect(loads).toBe(1);

  // A wider window does.
  await page.getByRole("combobox", { name: "Agent" }).click();
  await page.getByRole("option", { name: "All my agents" }).click();
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "All types" }).click();
  await page.getByRole("radio", { name: "30 days" }).click();
  await app.waitForUrl((url) => url.searchParams.get("since") === "30d");
  await expect.element(item("ORB-9")).toBeVisible();
  expect(
    server.requests.some(
      (r) => r.url.pathname === "/api/agent-work" && r.url.searchParams.get("since") === "30d",
    ),
  ).toBe(true);
});

test("without agents, it says how to get one", async () => {
  const server = await TestServer.start({ world: true });
  server.on("GET", "/api/agent-work", { ...LIST, agents: [], items: [] });
  renderApp("/agent-work");
  await expect.element(page.getByText("You have no agents yet.", { exact: false })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Set one up" }))
    .toHaveAttribute("href", "/settings/agents");
});
