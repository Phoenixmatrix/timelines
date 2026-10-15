// What moving around the app reads again, and what it reuses (CORE-439):
// navigation inside one Space reuses the session and the tracker's view; a
// Space switch reads the session again; and what is reused never outlives a
// change of identity, here or in another tab.

import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { SessionResponse } from "../../shared/api.ts";
import type { OrganizationPage } from "../../shared/spaces.ts";
import { repoData } from "../lib/repoData.ts";
import { accessEpoch } from "../lib/session.ts";
import { renderApp } from "../testing/render.tsx";
import { reply, TestServer } from "../testing/server.ts";
import { mutate, timelineWorld } from "../testing/timelines.ts";

const sessions = (server: TestServer, mark: number) =>
  server.since(mark).filter((request) => request.url.pathname === "/api/session");

test("moving between pages of one Space reuses the session; entering another Space reads it again", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "reads-demo");
  const other = await server.call<OrganizationPage>("POST", "/api/organizations", {
    slug: "reads-elsewhere",
    displayName: "Elsewhere",
    spaceSlug: "reads-elsewhere-general",
    spaceDisplayName: "Elsewhere General",
  });
  const app = renderApp("/orbit");
  await expect.element(page.getByRole("link", { name: /^reads-demo/ })).toBeVisible();

  const mark = server.requests.length;
  await app.navigate("/orbit/reads-demo");
  await app.waitForUrl((url) => url.pathname === "/orbit/reads-demo");
  await expect.poll(() => app.router.state.navigation.state).toBe("idle");
  await app.navigate("/tracker/orbit");
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit");
  await expect.poll(() => app.router.state.navigation.state).toBe("idle");
  await app.navigate("/orbit");
  await expect.poll(() => app.router.state.navigation.state).toBe("idle");
  expect(sessions(server, mark)).toHaveLength(0);

  const switched = server.requests.length;
  await app.navigate(`/${other.spaces[0]!.space.slug}`);
  await expect
    .element(page.getByRole("heading", { name: "Elsewhere General", exact: true }))
    .toBeVisible();
  expect(sessions(server, switched)).toHaveLength(1);
});

test("opening issues, j/k, Escape and the query reuse the tracker's view", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "reads-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
    { kind: "issue.create", id: "reads-a", data: { teamId: "reads-team", title: "Alpha" } },
    { kind: "issue.create", id: "reads-b", data: { teamId: "reads-team", title: "Beta" } },
  ]);
  localStorage.setItem("gitmatrix:tracker-shortcuts", "true");
  onTestFinished(() => localStorage.removeItem("gitmatrix:tracker-shortcuts"));
  const app = renderApp("/tracker/orbit?view=list");
  const inspector = (key: string) => page.getByRole("complementary", { name: `Issue ${key}` });
  const row = (name: RegExp) => page.getByRole("row", { name });
  await expect.element(row(/ENG-1 Alpha/)).toBeVisible();
  await expect.poll(() => app.router.state.navigation.state).toBe("idle");

  const mark = server.requests.length;
  const views = () =>
    server
      .since(mark)
      .filter((request) => /^\/api\/tracker\/[^/]+\/view$/.test(request.url.pathname));
  await row(/ENG-1 Alpha/).click();
  await expect.element(inspector("ENG-1")).toBeVisible();
  // The tracker's keys, pressed with nothing focused.
  const press = (key: string) =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  press("j");
  await expect.element(inspector("ENG-2")).toBeVisible();
  press("k");
  await expect.element(inspector("ENG-1")).toBeVisible();
  press("Escape");
  await expect.element(inspector("ENG-1")).not.toBeInTheDocument();
  await app.navigate("/tracker/orbit?view=list&q=is%3Aopen%20sort%3Apriority");
  await expect.poll(() => app.router.state.navigation.state).toBe("idle");
  expect(views()).toHaveLength(0);
  expect(sessions(server, mark)).toHaveLength(0);
});

test("Home offers New repository from the session, without reading the default Space", async () => {
  const server = await TestServer.start({ world: true });
  const { viewer } = await server.call<SessionResponse>("GET", "/api/session");
  const home = viewer!.spaces.find((space) => space.id === viewer!.defaultSpaceId)!;
  const mark = server.requests.length;
  renderApp("/");
  await expect
    .element(page.getByRole("link", { name: "New repository" }))
    .toHaveAttribute("href", `/${home.slug}/-/repositories/new`);
  expect(server.since(mark).filter((r) => r.url.pathname.startsWith("/api/spaces/"))).toHaveLength(
    0,
  );
});

test("with a timeline selected, moving between a Space's pages reuses its timeline list", async () => {
  const server = await TestServer.start({ world: true });
  const timeline = await timelineWorld(server, { slug: "reads-work", name: "Reads work" });
  const app = renderApp(`/orbit?tl=${timeline.slug}`);
  const banner = page.getByRole("region", { name: "Timeline scope" });
  await expect.element(banner).toMatchTextContent("Reads work");

  const mark = server.requests.length;
  const lists = () =>
    server.since(mark).filter((r) => r.url.pathname === "/api/tracker/orbit/timelines");
  await app.navigate(`/tracker/orbit?tl=${timeline.slug}`);
  await expect.poll(() => app.router.state.navigation.state).toBe("idle");
  await expect.element(banner).toMatchTextContent("Reads work");
  await app.navigate(`/orbit?tl=${timeline.slug}`);
  await expect.poll(() => app.router.state.navigation.state).toBe("idle");
  await expect.element(banner).toMatchTextContent("Reads work");
  expect(lists()).toHaveLength(0);
});

test("a tracker refresh the server refuses reads the route again, replacing the view", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "refused-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
    { kind: "issue.create", id: "refused-a", data: { teamId: "refused-team", title: "Alpha" } },
  ]);
  renderApp("/tracker/orbit/issues/refused-a?view=list");
  const table = page.getByRole("table", { name: "Issues" });
  await expect.element(table).toBeVisible();
  // Access ends: the view and its refreshes are refused from now on.
  const refused = () => reply({ error: "This tracker is no longer available." }, 403);
  server.on("GET", "/api/tracker/:space/snapshot", refused);
  server.on("GET", "/api/tracker/:space/view", refused);
  const mark = server.requests.length;
  window.dispatchEvent(new Event("focus"));
  await expect.element(table).not.toBeInTheDocument();
  expect(
    server.since(mark).some((request) => request.url.pathname === "/api/tracker/orbit/view"),
  ).toBe(true);
});

/** Move this test's clock on by `ms` (Date.now only; timers run as usual). */
const realNow = Date.now.bind(Date);
function later(ms: number) {
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + ms);
  onTestFinished(() => clock.mockRestore());
}

/** Whether a repository read is (still) served from the cache, without asking the server. */
async function cachedRead(server: TestServer): Promise<boolean> {
  const mark = server.requests.length;
  await repoData.detail("orbit", "access-demo");
  return server.since(mark).length === 0;
}

async function opened(path: string) {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "access-demo");
  const app = renderApp(path);
  await expect.poll(() => app.router.state.initialized).toBe(true);
  await expect.poll(() => app.router.state.navigation.state).toBe("idle");
  await repoData.detail("orbit", "access-demo");
  expect(await cachedRead(server)).toBe(true);
  return { server, app };
}

test("a sign-in, sign-out or account switch in another tab empties caches and reads the page again", async () => {
  const { server, app } = await opened("/orbit");

  // Another tab says who is signed in changed (BroadcastChannel).
  let mark = server.requests.length;
  const otherTab = new BroadcastChannel(app.accessChannel);
  otherTab.postMessage("another-tab-signed-in");
  otherTab.close();
  await expect.poll(() => sessions(server, mark).length).toBe(1);
  await expect.poll(() => app.router.state.revalidation).toBe("idle");
  expect(await cachedRead(server)).toBe(false);
  expect(await cachedRead(server)).toBe(true);

  // Without BroadcastChannel, the same message arrives as a storage event.
  mark = server.requests.length;
  const signedOut = () =>
    window.dispatchEvent(
      new StorageEvent("storage", { key: app.accessChannel, newValue: "another-tab-signed-out" }),
    );
  signedOut();
  await expect.poll(() => sessions(server, mark).length).toBe(1);
  await expect.poll(() => app.router.state.revalidation).toBe("idle");
  expect(await cachedRead(server)).toBe(false);
  // One message is handled once.
  signedOut();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sessions(server, mark)).toHaveLength(1);
  expect(await cachedRead(server)).toBe(true);
});

test("returning to the tab reads the session again (at most every 15 s); another identity empties caches", async () => {
  const { server } = await opened("/orbit");

  // Just after a session read, focus asks nothing.
  let mark = server.requests.length;
  window.dispatchEvent(new Event("focus"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sessions(server, mark)).toHaveLength(0);

  // Later, it reads the session; the same identity changes nothing else.
  later(20_000);
  const epoch = accessEpoch();
  mark = server.requests.length;
  window.dispatchEvent(new Event("focus"));
  await expect.poll(() => sessions(server, mark).length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sessions(server, mark)).toHaveLength(1);
  expect(accessEpoch()).toBe(epoch);

  // Signed in as someone else meanwhile (another window, or the session ended).
  const { viewer } = await server.call<SessionResponse>("GET", "/api/session");
  server.on("GET", "/api/session", { viewer: { ...viewer!, id: "acc_someone_else" } });
  later(40_000);
  await repoData.detail("orbit", "access-demo");
  expect(await cachedRead(server)).toBe(true);
  mark = server.requests.length;
  window.dispatchEvent(new Event("focus"));
  // The caches are emptied and the root reads the session again.
  await expect.poll(() => sessions(server, mark).length).toBe(2);
  expect(accessEpoch()).toBeGreaterThan(epoch);
  expect(await cachedRead(server)).toBe(false);
});

test("an issue made since the tracker's view was read opens after one refresh; a missing one still says so", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "late-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
    { kind: "issue.create", id: "late-a", data: { teamId: "late-team", title: "Alpha" } },
  ]);
  const app = renderApp("/tracker/orbit?view=list");
  await expect.element(page.getByRole("row", { name: /ENG-1 Alpha/ })).toBeVisible();
  await expect.poll(() => app.router.state.navigation.state).toBe("idle");
  // Someone else (or gm) makes an issue; this view doesn't have it.
  await mutate(server, [
    { kind: "issue.create", id: "late-b", data: { teamId: "late-team", title: "Beta" } },
  ]);
  const snapshots = (mark: number) =>
    server.since(mark).filter((request) => request.url.pathname === "/api/tracker/orbit/snapshot");

  let mark = server.requests.length;
  await app.navigate("/tracker/orbit/issues/late-b?view=list");
  await expect.element(page.getByRole("complementary", { name: "Issue ENG-2" })).toBeVisible();
  expect(page.getByText("Issue not found").elements()).toHaveLength(0);
  expect(snapshots(mark)).toHaveLength(1);

  mark = server.requests.length;
  await app.navigate("/tracker/orbit/issues/never-made?view=list");
  await expect.element(page.getByRole("heading", { name: "Issue not found" })).toBeVisible();
  expect(snapshots(mark)).toHaveLength(1);
  // Once per issue: back to it, it isn't asked about again.
  await app.navigate("/tracker/orbit/issues/late-a?view=list");
  await expect.element(page.getByRole("complementary", { name: "Issue ENG-1" })).toBeVisible();
  await app.navigate("/tracker/orbit/issues/never-made?view=list");
  await expect.element(page.getByRole("heading", { name: "Issue not found" })).toBeVisible();
  expect(snapshots(mark)).toHaveLength(1);
});

test("saving a default Space in Preferences moves the timeline scope's default with it", async () => {
  const server = await TestServer.start({ world: true });
  const timeline = await timelineWorld(server, { slug: "pref-work", name: "Pref work" });
  const { viewer } = await server.call<SessionResponse>("GET", "/api/session");
  const orbit = viewer!.spaces.find((space) => space.slug === "orbit")!;
  // The default is orbit, whose timeline the address names.
  await server.call("PUT", "/api/account/default-scope", {
    organizationId: orbit.organizationId,
    spaceId: orbit.id,
  });
  renderApp(`/settings/preferences?tl=${timeline.slug}`);
  const banner = page.getByRole("region", { name: "Timeline scope" });
  await expect.element(banner).toMatchTextContent("Pref work");

  // Back to the personal default Space, which has no such timeline.
  await userEvent.click(page.getByRole("button", { name: "Use personal default" }));
  await expect.element(page.getByText("Default reset")).toBeVisible();
  await expect.element(banner).toMatchTextContent(`has no timeline ${timeline.slug}`);
  await expect.element(banner).not.toMatchTextContent("Pref work");
});
