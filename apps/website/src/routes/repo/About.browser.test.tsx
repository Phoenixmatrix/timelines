// The Code tab's About rail streams each part in on its own (CORE-451): a
// Tracker that is slow to count ready issues holds up neither the files nor
// the knowledge summary nor CI.

import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type {
  CiRunList,
  GraphNodeDetail,
  RepoIssueSummary,
  TreeResponse,
} from "../../../shared/api.ts";
import { commitId } from "../../testing/atlas.ts";
import { cannedFiles } from "../../testing/git.ts";
import { announceAccessChange } from "../../lib/session.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";

test("the rail shows knowledge and CI while the tracker summary is still on its way", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const head = commitId();
  await server.push("orbit/engine", "main", head);
  cannedFiles(server, head, ["README.md", "engine.ts"]);
  server.on("GET", "/api/repos/orbit/engine/knowledge/graph/node", {
    node: {
      id: "repo",
      kind: "repo",
      name: "engine",
      path: null,
      summary: "Turns timelines into commits.",
      data: {},
    },
    outgoing: [],
    incoming: [],
  } as unknown as GraphNodeDetail);
  server.on("GET", "/api/repos/orbit/engine/ci", { runs: [], runner: "local" } satisfies CiRunList);
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let asked = false;
  server.on(
    "GET",
    "/api/repos/orbit/engine/tracker/summary",
    async (): Promise<RepoIssueSummary> => {
      asked = true;
      await released;
      return { ready: 3, projects: 1 };
    },
  );
  try {
    renderApp("/orbit/engine");
    const about = page.getByRole("complementary", { name: "About this repository" });
    // The page itself renders on the detail and the tree.
    await expect.element(page.getByRole("link", { name: "engine.ts", exact: true })).toBeVisible();
    await expect.element(about.getByText("Turns timelines into commits.")).toBeVisible();
    await expect.element(about.getByRole("heading", { name: "CI on main" })).toBeVisible();
    await expect.element(about.getByRole("link", { name: "Releases", exact: true })).toBeVisible();
    expect(asked).toBe(true);
    expect(about.getByRole("link", { name: /^Issues ·/ }).elements()).toHaveLength(0);
    // Its row is held open, so Releases doesn't move when the count arrives.
    await expect.element(about.getByTestId("issues-pending")).toBeInTheDocument();
    const releases = about.getByRole("link", { name: "Releases", exact: true }).element();
    const before = releases.getBoundingClientRect().top;
    release();
    await expect
      .element(about.getByRole("link", { name: "Issues · 3 ready", exact: true }))
      .toBeVisible();
    expect(releases.getBoundingClientRect().top).toBe(before);
    expect(about.getByTestId("issues-pending").elements()).toHaveLength(0);
  } finally {
    release();
  }
  // The count joins the rail when it arrives, where it always sits.
  const about = page.getByRole("complementary", { name: "About this repository" });
  await expect
    .element(about.getByRole("link", { name: "Issues · 3 ready", exact: true }))
    .toBeVisible();
  const links = about
    .getByRole("listitem")
    .elements()
    .map((item) => item.textContent?.trim());
  expect(links.indexOf("Issues · 3 ready")).toBe(links.indexOf("Packages published from here") + 1);
});

test("moving between folders shows the new one at once and keeps the rail while its count reloads", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const head = commitId();
  await server.push("orbit/engine", "main", head);
  cannedFiles(server, head);
  const commit = {
    oid: head,
    message: "Fixture",
    authorName: "Fixture",
    authorEmail: "fixture@gitmatrix.invalid",
    authoredAt: 0,
    parents: [],
  };
  server.on("GET", "/api/repos/orbit/engine/tree", ({ url }): TreeResponse => {
    const inSrc = (url.searchParams.get("at") ?? "").endsWith("/src");
    return {
      ref: "main",
      path: inSrc ? "src" : "",
      commit,
      entries: inSrc
        ? [{ name: "engine.ts", path: "src/engine.ts", type: "blob", oid: head }]
        : [{ name: "src", path: "src", type: "tree", oid: head }],
      readme: null,
    };
  });
  server.on("GET", "/api/repos/orbit/engine/ci", { runs: [], runner: "local" } satisfies CiRunList);
  // The first count answers; every later one waits, as a cold Tracker would.
  let releaseLater!: () => void;
  const later = new Promise<void>((resolve) => (releaseLater = resolve));
  let counts = 0;
  server.on(
    "GET",
    "/api/repos/orbit/engine/tracker/summary",
    async (): Promise<RepoIssueSummary> => {
      if (++counts > 1) await later;
      return { ready: 3, projects: 1 };
    },
  );
  try {
    const app = renderApp("/orbit/engine");
    const about = page.getByRole("complementary", { name: "About this repository" });
    const issues = about.getByRole("link", { name: "Issues · 3 ready", exact: true });
    await expect.element(issues).toBeVisible();
    await expect.element(about.getByRole("heading", { name: "CI on main" })).toBeVisible();

    await app.navigate("/orbit/engine/tree/main/src");
    await expect.poll(() => counts).toBe(2);
    // The new folder renders while its count is still on its way…
    await expect.element(page.getByRole("link", { name: "engine.ts", exact: true })).toBeVisible();
    // …and the rail keeps what it showed, CI and count included.
    await expect.element(issues).toBeVisible();
    await expect.element(about.getByRole("heading", { name: "CI on main" })).toBeVisible();
  } finally {
    releaseLater();
  }
});

test("an access change empties the rail rather than show the last identity's count", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const head = commitId();
  await server.push("orbit/engine", "main", head);
  cannedFiles(server, head, ["README.md", "engine.ts"]);
  server.on("GET", "/api/repos/orbit/engine/ci", { runs: [], runner: "local" } satisfies CiRunList);
  // The first identity's count answers; the next one's waits, as a cold Tracker would.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let counts = 0;
  server.on(
    "GET",
    "/api/repos/orbit/engine/tracker/summary",
    async (): Promise<RepoIssueSummary> => {
      if (++counts === 1) return { ready: 3, projects: 1 };
      await released;
      return { ready: 5, projects: 1 };
    },
  );
  try {
    const app = renderApp("/orbit/engine");
    const about = page.getByRole("complementary", { name: "About this repository" });
    await expect
      .element(about.getByRole("link", { name: "Issues · 3 ready", exact: true }))
      .toBeVisible();

    // Signed out, or another account signed in: the page reads everything again.
    announceAccessChange();
    await app.router.revalidate();
    await expect.poll(() => counts).toBe(2);
    // The rail comes back for the new identity with its count still held…
    await expect.element(about.getByTestId("issues-pending")).toBeInTheDocument();
    // …and never with the count the last one was shown.
    expect(about.getByRole("link", { name: /^Issues ·/ }).elements()).toHaveLength(0);
    release();
    await expect
      .element(about.getByRole("link", { name: "Issues · 5 ready", exact: true }))
      .toBeVisible();
  } finally {
    release();
  }
});
