// The global search palette (formerly the E2E scenario
// browser-global-search-palette) in a real browser, against the Worker's
// search, tracker and repository routes in memory: the Search button and
// Ctrl+K open it with focus in the query and Escape gives focus back; an
// exact identifier comes first and Enter opens it; what the viewer can't read
// never appears; before anything's typed one Go to leads, and Go to and Find
// are second steps; issues and packages open their pages; Create issue hands a
// proposed title to the tracker's own creator once, never in the address;
// signed out it only navigates, and never searches.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { commitId } from "../testing/atlas.ts";
import { press } from "../testing/focus.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";

const dialog = () => page.getByRole("dialog", { name: "Search" });
const query = () => page.getByRole("combobox", { name: "Search or go to" });

async function setup(persona: "marco" | null = "marco") {
  const server = await TestServer.start({ world: true, persona });
  // Empty repositories: their pages need no files.
  await server.repo("orbit", "website");
  await server.repo("orbit", "engine", "private");
  // sam's own private repository: marco can't read it.
  await server.repo("sam", "notes", "private");
  return server;
}

test("open, search, choose: each by keyboard, with focus where it belongs", async () => {
  const server = await setup();
  const app = renderApp("/orbit/engine");
  await expect.element(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();

  // The visible control opens it with focus in the query; Escape gives focus back.
  const button = page.getByRole("button", { name: "Search", exact: true });
  await userEvent.click(button);
  await expect.element(query()).toHaveFocus();
  await expect.element(page.getByRole("group", { name: "In orbit/engine" })).toBeVisible();
  await press("Escape");
  await expect.element(dialog()).not.toBeInTheDocument();
  await expect.element(button).toHaveFocus();

  // Ctrl+K, a real search, the exact identifier first; Enter navigates and closes.
  await press("Control+k");
  await expect.element(query()).toHaveFocus();
  await userEvent.keyboard("orbit/website");
  await expect
    .element(page.getByRole("option", { selected: true }))
    .toMatchTextContent("orbit/website");
  await press("Enter");
  await expect.element(dialog()).not.toBeInTheDocument();
  await app.waitForUrl((url) => url.pathname === "/orbit/website");

  // A private repository marco can't read never appears.
  await press("Control+k");
  await userEvent.keyboard("sam/notes");
  await expect
    .element(dialog().getByText("Nothing matches “sam/notes”."), { timeout: 10_000 })
    .toBeVisible();
  await press("Escape");
  expect(server.requests.some((r) => r.url.pathname === "/api/search")).toBe(true);
});

test("before anything's typed, one Go to leads; Go to and Find are second steps", async () => {
  const server = await setup();
  await server.call("POST", "/api/tracker/orbit/mutate", {
    operationId: "palette-go-fixtures",
    mutations: [
      {
        kind: "team.create",
        id: "palette-team",
        data: { key: "PAL", name: "Palette", memberIds: ["acc_marco"] },
      },
      {
        kind: "issue.create",
        id: "palette-ready",
        data: { teamId: "palette-team", title: "Agent ready fixture", status: "todo" },
      },
    ],
  });
  const app = renderApp("/orbit/engine");
  await expect.element(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();

  // Every page waits behind Go to, selected so Enter opens it; things to do follow.
  await press("Control+k");
  await expect.element(page.getByRole("option", { selected: true })).toMatchTextContent("Go to…");
  await expect.element(dialog().getByRole("option", { name: /^Find an issue…/ })).toBeVisible();
  expect(
    dialog()
      .getByRole("option", { name: /^Access tokens/ })
      .elements(),
  ).toHaveLength(0);
  await press("Enter");
  const goTo = page.getByRole("combobox", { name: "Go to a page" });
  await expect.element(goTo).toHaveFocus();
  await expect.element(dialog().getByRole("option", { name: /^Access tokens/ })).toBeVisible();

  // Backspace on the empty query steps back out; Enter goes in again.
  await press("Backspace");
  await expect.element(query()).toHaveFocus();
  await press("Enter");
  await expect.element(goTo).toHaveFocus();
  // The repository's sections come first, and typing filters every place.
  await userEvent.keyboard("CI");
  await expect.element(page.getByRole("option", { selected: true })).toMatchTextContent("CI");
  await press("Enter");
  await expect.element(dialog()).not.toBeInTheDocument();
  await app.waitForUrl((url) => url.pathname === "/orbit/engine/ci");
  const searched = server.requests.filter((r) => r.url.pathname === "/api/search").length;
  expect(searched, "Go to only filters the app's own places").toBe(0);

  // Find narrows search to one kind of result, with more of them.
  await press("Control+k");
  await userEvent.keyboard("find an issue");
  await press("Enter");
  const findIssues = page.getByRole("combobox", { name: "Find issues" });
  await expect.element(findIssues).toHaveFocus();
  await expect.element(dialog().getByText("Type to find issues.")).toBeVisible();
  await userEvent.keyboard("Agent ready");
  await expect
    .element(page.getByRole("group", { name: "Issues" }).getByRole("option").first())
    .toMatchTextContent("Agent ready fixture");
  const search = server.requests.findLast((r) => r.url.pathname === "/api/search")!;
  expect(search.url.searchParams.get("categories")).toBe("issues");
  expect(search.url.searchParams.get("limit")).toBe("20");
  expect(page.getByRole("group", { name: "Repositories" }).elements()).toHaveLength(0);
});

test("issues and packages open their own pages", async () => {
  const server = await setup();
  await server.call("POST", "/api/tracker/orbit/mutate", {
    operationId: "palette-fixtures",
    mutations: [
      {
        kind: "team.create",
        id: "palette-team",
        data: { key: "PAL", name: "Palette", memberIds: ["acc_marco"] },
      },
      {
        kind: "issue.create",
        id: "palette-ready",
        data: { teamId: "palette-team", title: "Agent ready fixture", status: "todo" },
      },
    ],
  });
  // A package orbit publishes, in its npm feed.
  const head = commitId();
  await server.push("orbit/engine", "main", head);
  await server.call("POST", "/api/dev/atlas", {
    repo: "orbit/engine",
    action: "publish",
    commit: head,
    publishes: "orbit-kit",
  });

  const app = renderApp("/orbit/website");
  await expect.element(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();

  // Issues from the trackers marco belongs to open their page.
  await press("Control+k");
  await userEvent.keyboard("Agent ready fixture");
  const issues = page.getByRole("group", { name: "Issues" });
  await expect
    .element(issues.getByRole("option").first())
    .toMatchTextContent("Agent ready fixture");
  await expect.element(issues.getByRole("option").first()).toMatchTextContent("orbit");
  await press("Enter");
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit/issues/palette-ready");
  await expect
    .element(page.getByText("Agent ready fixture", { exact: true }).first())
    .toBeVisible();

  // A package, by name, opens its console page.
  await press("Control+k");
  await userEvent.keyboard("orbit-kit");
  const packages = page.getByRole("group", { name: "Packages" });
  await expect.element(packages.getByRole("option").first()).toMatchTextContent("orbit-kit");
  await press("Enter");
  await app.waitForUrl((url) => /^\/orbit\/-\/packages\/npm\/orbit-kit$/.test(url.pathname));
});

test("Create issue hands the proposed title to the tracker's creator, once", async () => {
  const server = await setup();
  await server.call("POST", "/api/tracker/orbit/mutate", {
    operationId: "palette-team",
    mutations: [
      {
        kind: "team.create",
        id: "palette-team",
        data: { key: "PAL", name: "Palette", memberIds: ["acc_marco"] },
      },
    ],
  });
  const app = renderApp("/orbit/website");
  await expect.element(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();
  const proposed = `Palette issue ${commitId().slice(0, 8)}`;
  await press("Control+k");
  await userEvent.keyboard(proposed);
  await userEvent.click(
    page.getByRole("option", { name: new RegExp(`Create issue “${proposed}”`) }),
  );
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit");
  const creator = page.getByRole("dialog", { name: "Create an issue" });
  await expect.element(creator.getByRole("textbox", { name: /Title/i })).toHaveValue(proposed);
  expect(app.url().href, "The proposed title never travels in the address").not.toContain(
    "Palette",
  );
  await userEvent.click(creator.getByRole("button", { name: "Create and edit" }));
  await app.waitForUrl((url) => url.pathname.includes("/issues/"));
  // Once: opening the same address again doesn't propose it again.
  const created = app.url();
  app.unmount();
  renderApp(created.pathname + created.search);
  await expect.element(page.getByText(proposed, { exact: true }).first()).toBeVisible();
  expect(page.getByRole("dialog", { name: "Create an issue" }).elements()).toHaveLength(0);
});

test("signed out, the palette only navigates and never searches", async () => {
  const server = await setup(null);
  const app = renderApp("/");
  await expect.element(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await press("Control+k");
  const goTo = page.getByRole("combobox", { name: "Go to" });
  await expect.element(goTo).toHaveFocus();
  await userEvent.keyboard("sign");
  await press("Enter");
  await app.waitForUrl((url) => url.pathname === "/signin");
  expect(
    server.requests.filter((r) => r.url.pathname.startsWith("/api/search")),
    "Signed out, the palette must not search",
  ).toEqual([]);
});
