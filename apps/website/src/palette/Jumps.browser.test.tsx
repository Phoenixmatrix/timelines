// Direct jumps and recent places in the palette (CORE-22), in a real
// browser against the Worker's search, tracker and timelines in memory: an
// issue key, `#<run>` (and a bare number) in the current repository, a SHA
// (which opens the commit panel over the page and is never proposed as an
// issue title), `pkg@version` and a timeline's slug each jump straight
// there with Enter; with nothing typed, the last places visited come first.
// References resolve through the real resolver in memory; CI runs and
// commit contents aren't in the world, so those are canned, and the package
// console's API isn't either, so its page isn't checked as a recent.

import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { CiRunDetail } from "../../shared/api.ts";
import type { CommitDiff } from "../../shared/diff.ts";
import type { SearchResponse } from "../../shared/search.ts";
import { commitId } from "../testing/atlas.ts";
import { press } from "../testing/focus.ts";
import { cannedFiles } from "../testing/git.ts";
import { renderApp } from "../testing/render.tsx";
import { reply, TestServer } from "../testing/server.ts";

const dialog = () => page.getByRole("dialog", { name: "Search" });
const selected = () => page.getByRole("option", { selected: true });

/**
 * Recent places in a store of this test's own: other test files run in
 * parallel pages of the same origin as the same persona, and would write
 * their visits into the shared localStorage.
 */
function isolateRecents() {
  const own = new Map<string, string>();
  const mine = (key: string) => key.startsWith("gitmatrix:recent-places:");
  const real = {
    getItem: Storage.prototype.getItem.bind(localStorage),
    setItem: Storage.prototype.setItem.bind(localStorage),
    removeItem: Storage.prototype.removeItem.bind(localStorage),
  };
  vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
    return mine(key) ? (own.get(key) ?? null) : real.getItem(key);
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
    if (mine(key)) own.set(key, value);
    else real.setItem(key, value);
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key: string) => {
    if (mine(key)) own.delete(key);
    else real.removeItem(key);
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
}

async function setup() {
  isolateRecents();
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  // A letter up front: a short hash of digits alone reads as a number, not a commit.
  const head = `a${commitId().slice(1)}`;
  await server.push("orbit/engine", "main", head);
  cannedFiles(server, head);
  await server.call("POST", "/api/tracker/orbit/mutate", {
    operationId: "jump-fixtures",
    mutations: [
      {
        kind: "team.create",
        id: "jump-team",
        data: { key: "JMP", name: "Jumps", memberIds: ["acc_marco"] },
      },
      {
        kind: "issue.create",
        id: "jump-issue",
        data: { teamId: "jump-team", title: "Jump target issue", status: "todo" },
      },
    ],
  });
  const found = await server.call<SearchResponse>(
    "GET",
    "/api/search?q=Jump%20target%20issue&categories=issues",
  );
  const group = found.groups[0]!;
  const key =
    group.status === "ok" && group.results[0]?.category === "issues" ? group.results[0].key : "";
  expect(key).toMatch(/^JMP-\d+$/);
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug: "fast-search",
    name: "Fast search",
    repos: ["orbit/engine"],
  });
  await server.call("POST", "/api/dev/atlas", {
    repo: "orbit/engine",
    action: "publish",
    commit: head,
    publishes: "orbit-kit",
  });
  // A version of it, which pkg@version must name to resolve.
  const [pkg] = await server.registrySql<{ id: string }>(
    "SELECT id FROM packages WHERE name = 'orbit-kit'",
  );
  await server.registrySql(
    "INSERT INTO versions (id, package_id, version, created_at) VALUES ('v120', ?, '1.2.0', '2026-10-03T00:00:00Z')",
    pkg!.id,
  );
  server.on("GET", "/api/repos/:owner/:name/ci/runs/:number", ({ params }) =>
    params.number === "7"
      ? ({
          id: "run7",
          number: 7,
          commit: head,
          ref: "main",
          trigger: "push",
          preview: null,
          landing: null,
          title: "Nightly checks",
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
        } satisfies CiRunDetail)
      : reply({ error: "No such run." }, 404),
  );
  server.on("GET", "/api/repos/:owner/:name/commits/:oid/diff", ({ params }) =>
    params.oid === head
      ? ({
          oid: head,
          parents: [],
          message: "Jumped-to commit",
          authorName: "Marco",
          authoredAt: 0,
          files: [],
          truncated: false,
        } satisfies CommitDiff)
      : reply({ error: "No commit." }, 404),
  );
  return { server, head, key };
}

async function jump(text: string) {
  await press("Control+k");
  await expect.element(page.getByRole("combobox", { name: "Search or go to" })).toHaveFocus();
  await userEvent.keyboard(text);
  const jumps = page.getByRole("group", { name: "Jump to" });
  await expect.element(jumps.getByRole("option").first()).toBeVisible();
  return jumps;
}

test("Cmd-K jumps straight to an issue key, a run, a SHA, pkg@version and a timeline", async () => {
  const { head, key } = await setup();
  const app = renderApp("/orbit/engine");
  await expect.element(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();

  // An issue key: the issue, first and selected.
  const issue = await jump(key);
  await expect.element(issue.getByRole("option").first()).toMatchTextContent(key);
  await expect.element(selected()).toMatchTextContent("Jump target issue");
  await press("Enter");
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit/issues/jump-issue");
  await expect.element(page.getByText("Jump target issue", { exact: true }).first()).toBeVisible();

  // #7 in the current repository: its CI run.
  await app.navigate("/orbit/engine");
  await expect.element(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();
  await jump("#7");
  await expect.element(selected()).toMatchTextContent("#7 Nightly checks");
  await press("Enter");
  await app.waitForUrl((url) => url.pathname === "/orbit/engine/ci/7");
  // A bare number there is a run too; one that doesn't exist offers no jump.
  await press("Control+k");
  await userEvent.keyboard("7");
  await expect.element(selected()).toMatchTextContent("#7 Nightly checks");
  await press("Escape");

  // A short SHA: the commit panel over this page, and no "Create issue" for it.
  await jump(head.slice(0, 7));
  await expect.element(selected()).toMatchTextContent(`Commit ${head.slice(0, 7)}`);
  await expect.element(selected()).toMatchTextContent("in orbit/engine");
  expect(
    dialog()
      .getByRole("option", { name: /Create issue/ })
      .elements(),
  ).toHaveLength(0);
  await press("Enter");
  await app.waitForUrl(
    (url) => url.pathname === "/orbit/engine/ci/7" && url.searchParams.get("commit") === head,
  );
  const commit = page.getByRole("dialog", { name: `Commit ${head.slice(0, 7)}` });
  await expect.element(commit.getByText("Jumped-to commit").first()).toBeVisible();
  await press("Escape");
  await expect.element(commit).not.toBeInTheDocument();

  // pkg@version: that version in its package's console.
  await jump("orbit-kit@1.2.0");
  await expect.element(selected()).toMatchTextContent("orbit-kit@1.2.0");
  await press("Enter");
  await app.waitForUrl(
    (url) =>
      url.pathname === "/orbit/-/packages/npm/orbit-kit" &&
      url.searchParams.get("version") === "1.2.0",
  );

  // A timeline's slug, from a page of the tracker it's in.
  await app.navigate("/orbit/engine");
  await expect.element(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();
  await jump("fast-search");
  await expect.element(selected()).toMatchTextContent("Fast search");
  await press("Enter");
  await app.waitForUrl(
    (url) =>
      url.pathname === "/tracker/orbit/timelines" && url.searchParams.get("tl") === "fast-search",
  );

  await expect
    .poll(() => localStorage.getItem("gitmatrix:recent-places:acc_marco") ?? "")
    .toContain("Fast search");

  // With nothing typed, the places just visited come first, newest first.
  // (The page it's opened on isn't offered: wait to be on Home first.)
  await app.navigate("/");
  await app.waitForUrl((url) => url.pathname === "/");
  await press("Control+k");
  const recent = page.getByRole("group", { name: "Recent" });
  await expect.element(recent.getByRole("option", { name: /Fast search/ })).toBeVisible();
  const titles = recent
    .getByRole("option")
    .elements()
    .map((option) => option.textContent ?? "");
  const at = (text: string) => titles.findIndex((title) => title.includes(text));
  // Newest first: the timeline before the run, the run before the issue.
  expect(at("Fast search")).toBeGreaterThanOrEqual(0);
  expect(at("Fast search")).toBeLessThan(at("#7 Nightly checks"));
  expect(at("#7 Nightly checks")).toBeLessThan(at(key));
  expect(at(head.slice(0, 7))).toBeGreaterThanOrEqual(0);
  expect(at("orbit/engine")).toBeGreaterThanOrEqual(0);
  expect(titles.length).toBeLessThanOrEqual(8);
  // Choosing one goes back there.
  await userEvent.click(recent.getByRole("option", { name: /#7 Nightly checks/ }));
  await app.waitForUrl((url) => url.pathname === "/orbit/engine/ci/7");
});

test("SHA-like input never leads with Create issue, in a repository or outside one", async () => {
  const { head } = await setup();
  const app = renderApp("/orbit/engine");
  await expect.element(page.getByRole("link", { name: "CI", exact: true })).toBeVisible();
  // The real resolver answers from the branch tips here (the world has no git objects).
  await jump(head.slice(0, 12));
  await expect.element(selected()).toMatchTextContent(`Commit ${head.slice(0, 7)}`);
  expect(
    dialog()
      .getByRole("option", { name: /Create issue/ })
      .elements(),
  ).toHaveLength(0);
  await press("Escape");

  // Outside a repository, it's offered in the repository visited recently.
  await app.navigate("/tracker/orbit");
  await press("Control+k");
  await userEvent.keyboard(head.slice(0, 10));
  await expect.element(selected()).toMatchTextContent("in orbit/engine");
  expect(
    dialog()
      .getByRole("option", { name: /Create issue/ })
      .elements(),
  ).toHaveLength(0);
  await press("Enter");
  await app.waitForUrl(
    (url) => url.pathname === "/orbit/engine" && url.searchParams.get("commit") === head,
  );
  await expect
    .element(page.getByRole("dialog", { name: `Commit ${head.slice(0, 7)}` }))
    .toBeVisible();

  // Ordinary words still propose a title.
  await press("Escape");
  await press("Control+k");
  await userEvent.keyboard("Tidy the release script");
  await expect
    .element(dialog().getByRole("option", { name: /Create issue “Tidy the release script”/ }))
    .toBeVisible();
});
