import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { AccountPage, RepoIssueSummary } from "../../../shared/api.ts";
import { commitId } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { mutate } from "../../testing/timelines.ts";

// Real account membership and tracker storage, with no AI responses involved.
test("account teams and repo counts require tracker membership, not public repo visibility", async () => {
  const server = await TestServer.start({ world: true });
  const repo = await server.repo("orbit", "engine");
  await mutate(server, [
    { kind: "team.create", id: "eng", data: { key: "ENG", name: "Engineering" } },
    { kind: "workspace.create", id: "workspace", data: { slug: "engine", name: "Engine" } },
    {
      kind: "subscription.add",
      id: "subscription",
      data: { workspaceId: "workspace", repoId: repo.id },
    },
    {
      kind: "issue.create",
      id: "ready",
      data: { teamId: "eng", title: "Ready work", status: "todo", workspaceIds: ["workspace"] },
    },
  ]);
  expect((await server.call<AccountPage>("GET", "/api/accounts/orbit")).teams).toEqual([
    { id: "eng", key: "ENG", name: "Engineering" },
  ]);
  expect(
    await server.call<RepoIssueSummary>("GET", "/api/repos/orbit/engine/tracker/summary"),
  ).toEqual({ ready: 1, workspaces: 1 });
  expect((await server.call<AccountPage>("GET", "/api/accounts/marco")).teams).toEqual([]);
  // Remove only tracker membership; the repository remains public and subscribed.
  await server.sql("DELETE FROM org_members WHERE org_id = 'acc_orbit' AND user_id = 'acc_marco'");
  expect((await server.call<AccountPage>("GET", "/api/accounts/orbit")).teams).toBeNull();
  expect(
    await server.call<RepoIssueSummary>("GET", "/api/repos/orbit/engine/tracker/summary"),
  ).toEqual({ ready: null, workspaces: 0 });
  expect(
    (await server.call<{ canManage: boolean }>("GET", "/api/repos/orbit/engine/tracker")).canManage,
  ).toBe(false);
  await server.as("priya");
  // Site-wide repository administration still does not grant private tracker access.
  expect((await server.call<AccountPage>("GET", "/api/accounts/orbit")).teams).toBeNull();
  expect(
    await server.call<RepoIssueSummary>("GET", "/api/repos/orbit/engine/tracker/summary"),
  ).toEqual({ ready: null, workspaces: 0 });
  await server.as(null);
  expect((await server.call<AccountPage>("GET", "/api/accounts/orbit")).teams).toBeNull();
  expect((await server.call<AccountPage>("GET", "/api/accounts/marco")).teams).toBeNull();
  expect(
    await server.call<RepoIssueSummary>("GET", "/api/repos/orbit/engine/tracker/summary"),
  ).toEqual({ ready: null, workspaces: 0 });
});

test("account team links open the intended filtered work and personal Issues opens an empty tracker", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    { kind: "team.create", id: "eng", data: { key: "ENG", name: "Engineering" } },
    { kind: "team.create", id: "ops", data: { key: "OPS", name: "Operations" } },
    { kind: "issue.create", id: "eng-work", data: { teamId: "eng", title: "Engineering task" } },
    { kind: "issue.create", id: "ops-work", data: { teamId: "ops", title: "Operations task" } },
  ]);
  const app = renderApp("/orbit");
  await page.getByRole("link", { name: "ENG Engineering", exact: true }).click();
  await expect.element(page.getByText("Engineering task", { exact: true }).first()).toBeVisible();
  expect(page.getByText("Operations task", { exact: true }).elements()).toHaveLength(0);
  await app.navigate("/marco");
  await page
    .getByRole("region", { name: "Tracker" })
    .getByRole("link", { name: "Issues", exact: true })
    .click();
  await expect.poll(() => app.router.state.location.pathname).toBe("/tracker/marco");
});

test("About uses actual zero and positive ready counts, opens repository Issues and Releases", async () => {
  const server = await TestServer.start({ world: true });
  const repo = await server.repo("orbit", "engine");
  const head = commitId();
  await server.push("orbit/engine", "main", head);
  // The world stores refs, not Git objects; only the file tree is supplied here.
  server.on("GET", "/api/repos/orbit/:name/tree", {
    ref: "main",
    path: "",
    commit: {
      oid: head,
      message: "Initial commit",
      authorName: "Marco",
      authorEmail: "marco@example.test",
      authoredAt: 1,
      parents: [],
    },
    entries: [],
    readme: null,
  });
  await mutate(server, [
    { kind: "team.create", id: "eng", data: { key: "ENG", name: "Engineering" } },
    { kind: "workspace.create", id: "workspace", data: { slug: "engine", name: "Engine" } },
    {
      kind: "subscription.add",
      id: "subscription",
      data: { workspaceId: "workspace", repoId: repo.id },
    },
  ]);
  const app = renderApp("/orbit/engine");
  await page.getByRole("link", { name: "Issues · 0 ready", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Work for this repository" }))
    .toBeVisible();
  await mutate(server, [
    {
      kind: "issue.create",
      id: "ready",
      data: { teamId: "eng", title: "Ready work", status: "todo", workspaceIds: ["workspace"] },
    },
  ]);
  await app.navigate("/orbit/engine");
  await expect
    .element(page.getByRole("link", { name: "Issues · 1 ready", exact: true }))
    .toBeVisible();
  // Count navigation reads the compact summary, never a duplicate full snapshot.
  expect(
    server.requests.filter((r) => r.url.pathname.endsWith("/tracker/summary")).length,
  ).toBeGreaterThan(0);
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug: "focus",
    name: "Focus",
    policy: "approval",
    repos: ["orbit/engine"],
  });
  await app.navigate("/orbit/engine?tl=focus");
  await page.getByRole("link", { name: "Issues · 1 ready", exact: true }).click();
  await app.waitForUrl(
    (url) => url.pathname === "/orbit/engine/tracker" && url.searchParams.get("tl") === "focus",
  );
  await expect
    .poll(() =>
      server.requests.some(
        (r) =>
          r.url.pathname === "/api/tracker/orbit/snapshot" &&
          r.url.searchParams.get("timeline") === "focus",
      ),
    )
    .toBe(true);
  await app.navigate("/orbit/engine?tl=focus");
  await page.getByRole("link", { name: "Releases", exact: true }).last().click();
  await expect.poll(() => app.router.state.location.pathname).toBe("/orbit/engine/releases");
  expect(app.url().searchParams.get("tl")).toBe("focus");
  await server.repo("orbit", "empty");
  await server.push("orbit/empty", "main", head);
  const emptySummary = await server.call<RepoIssueSummary>(
    "GET",
    "/api/repos/orbit/empty/tracker/summary",
  );
  expect(emptySummary).toEqual({ ready: null, workspaces: 0 });
  let releaseSummary!: () => void;
  const summaryPending = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  let summaryRequested = false;
  server.on("GET", "/api/repos/orbit/empty/tracker/summary", async () => {
    summaryRequested = true;
    await summaryPending;
    return emptySummary;
  });
  // Start with a resolved positive count, then hold the next repo's summary open.
  await app.navigate("/orbit/engine?tl=main");
  const about = page.getByRole("complementary", { name: "About this repository" });
  await expect
    .element(about.getByRole("link", { name: "Issues · 1 ready", exact: true }))
    .toBeVisible();
  try {
    await app.navigate("/orbit/empty?tl=main");
    await app.waitForUrl((url) => url.pathname === "/orbit/empty");
    await expect
      .element(
        page.getByRole("heading", { level: 1 }).getByRole("link", { name: "empty", exact: true }),
      )
      .toBeVisible();
    await expect.poll(() => summaryRequested).toBe(true);
    // The old repo's count must not be rendered under the new repository identity.
    expect(about.getByRole("link", { name: /^Issues ·/ }).elements()).toHaveLength(0);
  } finally {
    releaseSummary();
  }
  await expect
    .element(about.getByRole("link", { name: "Releases", exact: true }))
    .toHaveAttribute("href", "/orbit/empty/releases");
  expect(about.getByRole("link", { name: /^Issues ·/ }).elements()).toHaveLength(0);
  await mutate(server, [{ kind: "subscription.remove", id: "subscription" }]);
  await app.navigate("/orbit/engine?tl=main");
  await expect
    .element(
      page.getByRole("heading", { level: 1 }).getByRole("link", { name: "engine", exact: true }),
    )
    .toBeVisible();
  await expect
    .element(about.getByRole("link", { name: "Releases", exact: true }))
    .toHaveAttribute("href", "/orbit/engine/releases");
  expect(about.getByRole("link", { name: /^Issues ·/ }).elements()).toHaveLength(0);
});
