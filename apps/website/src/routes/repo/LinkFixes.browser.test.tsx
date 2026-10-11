// CORE-22's one-way links in a real browser: the CI run header links its
// branch, timeline and the person who pushed it (an agent stays text); a
// repository's empty Issues tab links to tracker management; package sources
// link to their repositories; the workspace Atlas has an owner breadcrumb; a
// story's Timeline link uses the tracker in its address; release-note commits
// link under the entry's own repository; wiki Markdown keeps app-absolute
// links; tracker people link to their profiles while agents stay text.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { expect, onTestFinished, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { CiRunDetail, HistoryPage } from "../../../shared/api.ts";
import type { TimelineDetail } from "../../../shared/timelines.ts";
import type { OwnerPackages } from "../../../shared/packages.ts";
import type { ReleaseFeed } from "../../../shared/release-notes.ts";
import type { Attribution } from "../../../shared/tracker.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { commitId } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { Actor } from "../tracker/Actor.tsx";
import "../../styles/app.css";

/** Mount `element` alone in a memory router, for this test only. */
function renderAlone(element: React.ReactNode) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const router = createMemoryRouter([{ path: "*", element }], { initialEntries: ["/"] });
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  onTestFinished(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

function run(over: Partial<CiRunDetail>): CiRunDetail {
  return {
    id: "run",
    number: 1,
    commit: "a".repeat(40),
    ref: "main",
    trigger: "push",
    preview: null,
    landing: null,
    queueId: null,
    title: "Fix the build",
    status: "succeeded",
    actor: "marco",
    agent: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    heldAt: null,
    coveredBy: null,
    configError: null,
    jobs: [],
    ...over,
  };
}

test("a CI run links its branch, its timeline and the person who pushed it", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  await server.push("orbit/engine", "main", commitId());
  const runs: Record<string, CiRunDetail> = {
    "1": run({}),
    "2": run({
      number: 2,
      ref: "gitmatrix/landing/search",
      trigger: "landing",
      landing: { id: "landing", timeline: "search" },
      agent: "builder",
    }),
    "3": run({
      number: 3,
      ref: "timeline/search",
      trigger: "preview",
      preview: { action: "create", timeline: "search", checkpoint: null, revived: false },
      actor: null,
    }),
  };
  server.on("GET", "/api/repos/:owner/:name/ci/runs/:number", ({ params }) => runs[params.number!]);

  const app = renderApp("/orbit/engine/ci/1");
  const branch = page.getByRole("link", { name: "main", exact: true });
  await expect.element(branch).toHaveAttribute("href", "/orbit/engine/commits/main");
  await expect
    .element(page.getByRole("link", { name: "marco", exact: true }))
    .toHaveAttribute("href", "/marco");
  await expect.element(page.getByText(/Pushed by/)).toBeVisible();

  await app.navigate("/orbit/engine/ci/2");
  await expect
    .element(page.getByRole("link", { name: "search", exact: true }))
    .toHaveAttribute("href", "/tracker/orbit/timelines?tl=search");
  await expect
    .element(page.getByRole("link", { name: "marco", exact: true }))
    .toHaveAttribute("href", "/marco");
  // The agent is named, never linked.
  await expect.element(page.getByText(/builder for/)).toBeVisible();
  expect(page.getByRole("link", { name: "builder" }).elements()).toHaveLength(0);
  await expect
    .element(page.getByRole("link", { name: "gitmatrix/landing/search", exact: true }))
    .toHaveAttribute("href", "/orbit/engine/commits/gitmatrix/landing/search");

  await app.navigate("/orbit/engine/ci/3");
  await expect
    .element(page.getByRole("link", { name: "search", exact: true }))
    .toHaveAttribute("href", "/tracker/orbit/timelines?tl=search");
});

test("an empty Issues tab links to tracker management", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  await server.push("orbit/engine", "main", commitId());
  renderApp("/orbit/engine/tracker");
  await expect
    .element(page.getByRole("link", { name: "tracker management" }))
    .toHaveAttribute("href", "/tracker/orbit?manage=true");
});

test("package sources link to their repositories; the name opens the package", async () => {
  const server = await TestServer.start({ world: true });
  const data: OwnerPackages = {
    owner: {
      id: "acc_orbit",
      slug: "orbit",
      displayName: "Orbit Labs",
      kind: "org",
      avatarUrl: null,
    },
    access: "read",
    registryUrl: location.origin,
    feeds: [],
    packages: [
      {
        id: "pkg",
        format: "npm",
        name: "@orbit/sdk",
        feed: "orbit",
        latest: "1.2.0",
        lastPublishedAt: new Date().toISOString(),
        versions: 3,
        publishes24h: 1,
        spark: Array.from({ length: 24 }, () => 0),
        sources: ["orbit/engine", "orbit/web"],
      },
    ],
  } as OwnerPackages;
  server.on("GET", "/api/packages/:owner", data);
  await page.viewport(1280, 900);
  try {
    renderApp("/orbit/-/packages");
    await expect
      .element(page.getByRole("link", { name: "orbit/engine", exact: true }))
      .toHaveAttribute("href", "/orbit/engine");
    await expect
      .element(page.getByRole("link", { name: "orbit/web", exact: true }))
      .toHaveAttribute("href", "/orbit/web");
    await expect
      .element(page.getByRole("link", { name: "@orbit/sdk", exact: true }))
      .toHaveAttribute("href", "/orbit/-/packages/npm/%40orbit/sdk");
  } finally {
    await page.viewport(414, 896);
  }
});

test("the workspace Atlas names its owner in a breadcrumb", async () => {
  await TestServer.start({ world: true });
  renderApp("/orbit/-/atlas");
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect
    .element(crumbs.getByRole("link", { name: "orbit" }))
    .toHaveAttribute("href", "/orbit");
  await expect.element(crumbs).toMatchTextContent(/orbit\s*\/\s*Atlas/);
});

test("a story's Timeline link opens the tracker in its address, not its repositories' owner", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const main = commitId();
  await server.push("orbit/engine", "main", main);
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug: "search",
    name: "Search",
    repos: ["orbit/engine"],
  });
  // The same timeline as Marco's tracker would serve it: its repository is still Orbit's.
  const detail = await server.call<TimelineDetail>(
    "GET",
    "/api/tracker/orbit/timelines/search?limit=200",
  );
  server.on("GET", "/api/tracker/marco/timelines/search", detail);
  server.on("GET", "/api/repos/:owner/:name/history", ({ url }): HistoryPage => ({
    ref: url.searchParams.get("at") ?? "",
    head: main,
    path: "",
    scanned: 0,
    next: null,
    commits: [],
    entries: {},
  }));
  renderApp("/tracker/marco/timelines/search/story");
  await expect
    .element(page.getByRole("link", { name: "Timeline", exact: true }))
    .toHaveAttribute("href", "/tracker/marco/timelines?tl=search");
});

test("release-note commits link under the entry's own repository", async () => {
  const server = await TestServer.start({ world: true });
  const oid = "b".repeat(40);
  const feed: ReleaseFeed = {
    owner: { slug: "orbit", displayName: "Orbit Labs" },
    query: { filters: [], words: [], unknown: [] },
    truncated: false,
    facets: { teams: [], repos: [], workspaces: [], categories: [], labels: [], releases: [] },
    entries: [
      {
        id: "entry",
        release: "@day:2026-10-01",
        releaseKind: "daily",
        kind: "commit",
        category: "fix",
        title: "Faster search",
        summary: "",
        issue: null,
        labels: [],
        workspaceIds: [],
        commits: [oid],
        timeline: null,
        changes: [],
        lastCommitAt: new Date().toISOString(),
        model: null,
        updatedAt: new Date().toISOString(),
        repo: { owner: "orbit", name: "web" },
        // Listed in another repository's groups first: not where its commits are.
        repos: [
          { owner: "orbit", name: "engine", releases: ["@day:2026-10-01"] },
          { owner: "orbit", name: "web", releases: ["@day:2026-10-01"] },
        ],
      },
    ],
  } as ReleaseFeed;
  server.on("GET", "/api/tracker/:owner/release-notes", feed);
  renderApp("/tracker/orbit/releases");
  await page.getByRole("button", { name: /Show release note details for Faster search/ }).click();
  await expect
    .element(page.getByRole("link", { name: oid }))
    .toHaveAttribute("href", `/orbit/web?commit=${oid}`);
});

test("wiki Markdown keeps app-absolute links; repository paths still open the code", async () => {
  renderAlone(
    <Markdown
      owner="orbit"
      name="engine"
      refName="main"
      text={
        "[The issue](/tracker/orbit/issues/ENG-1) and [auth](apps/website/worker/auth.ts) and [here](./README.md)"
      }
    />,
  );
  await expect
    .element(page.getByRole("link", { name: "The issue" }))
    .toHaveAttribute("href", "/tracker/orbit/issues/ENG-1");
  await expect
    .element(page.getByRole("link", { name: "auth" }))
    .toHaveAttribute("href", "/orbit/engine/blob/main/apps/website/worker/auth.ts");
  await expect
    .element(page.getByRole("link", { name: "here" }))
    .toHaveAttribute("href", "/orbit/engine/blob/main/README.md");
});

test("tracker people link to their profile; agents stay text", async () => {
  const ann = { id: "acc_ann", slug: "ann", displayName: "Ann Lee" };
  const person: Attribution = { name: "Ann Lee", kind: "person", person: ann };
  const agent: Attribution = { name: "builder", kind: "agent", person: ann };
  const container = renderAlone(
    <>
      <Actor who={person} link />
      <Actor who={agent} link />
      <Actor who={person} />
    </>,
  );
  await expect.element(page.getByRole("link", { name: /Ann Lee/ })).toHaveAttribute("href", "/ann");
  expect(container.querySelectorAll("a")).toHaveLength(1);
  await expect.element(page.getByTitle(/builder · Agent/)).toBeVisible();
});

test("an issue's assignee links to their profile", async () => {
  const server = await TestServer.start({ world: true });
  await server.call("POST", "/api/tracker/orbit/mutate", {
    operationId: crypto.randomUUID(),
    mutations: [
      {
        kind: "team.create",
        id: "team",
        data: { key: "ENG", name: "Eng", memberIds: ["acc_marco"] },
      },
      {
        kind: "issue.create",
        id: "issue",
        data: { teamId: "team", title: "Assigned issue", assigneeId: "acc_marco" },
      },
    ],
  });
  renderApp("/tracker/orbit/issues/ENG-1");
  const assignee = () =>
    [...document.querySelectorAll("dt")].find((dt) => dt.textContent === "Assignee")
      ?.nextElementSibling;
  await expect.poll(() => assignee()?.innerHTML ?? "").toContain('href="/marco"');
});
