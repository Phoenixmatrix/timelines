import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { CiLogs, CiRunDetail, CommitSummary, HistoryPage } from "../../shared/api.ts";
import type { Mutation } from "../../shared/tracker.ts";
import { renderApp } from "../testing/render.tsx";
import { reply, TestServer, type Persona } from "../testing/server.ts";

const HEAD = "3f2a9c1b".padEnd(40, "0");
/** Where the rest of a commit title goes: that commit's panel over the history page (CORE-22). */
const panelOver = (sha: string) => `/orbit/engine/commits/main?commit=${sha}`;

/** Apply tracker mutations to `space`'s tracker as `as` (the world's persona by default). */
async function mutate(server: TestServer, space: string, mutations: Mutation[], as?: Persona) {
  await server.call(
    "POST",
    `/api/tracker/${space}/mutate`,
    { ...(await server.trackerContract(space, as)), operationId: crypto.randomUUID(), mutations },
    as,
  );
}

/** A team ENG in `space`'s tracker, and its first issue (ENG-1). */
async function engIssue(
  server: TestServer,
  space: string,
  id: string,
  title: string,
  as?: Persona,
) {
  await mutate(
    server,
    space,
    [
      { kind: "team.create", id: `${space}-team`, data: { key: "ENG", name: "Eng" } },
      { kind: "issue.create", id, data: { teamId: `${space}-team`, title } },
    ],
    as,
  );
}

function commit(oid: string, message: string): CommitSummary {
  return {
    oid,
    message,
    authorName: "Marco Bellini",
    authorEmail: "marco@orbit.test",
    authoredAt: 1_790_000_000,
    parents: [],
  };
}

/** Canned history for every repository, newest first. */
function history(server: TestServer, commits: CommitSummary[]) {
  server.on("GET", "/api/repos/:space/:name/history", ({ url }): HistoryPage => ({
    ref: url.searchParams.get("at") || "main",
    head: commits[0]!.oid,
    path: "",
    scanned: commits.length,
    next: null,
    commits,
    entries: {},
  }));
}

/** Every anchor in the element: its text and href. */
function anchors(element: Element) {
  return [...element.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
}

test("commit titles link what resolves; the rest stays the commit's own link", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  await server.push("orbit/engine", "main", HEAD);
  await engIssue(server, "orbit", "login", "Fix the login");
  history(server, [
    commit(HEAD, "Fix ENG-1, not JIRA-9 or ENG-77, see orbit/engine\n\nDetails."),
    commit("b".repeat(40), "Revert 3f2a9c1b and abc1234f"),
  ]);
  renderApp("/orbit/engine/commits/main");

  const issue = page.getByRole("link", { name: "ENG-1", exact: true });
  await expect.element(issue).toHaveAttribute("href", "/tracker/orbit/issues/login");
  await expect.element(issue).toHaveAttribute("title", "ENG-1 · Fix the login");
  const title = issue.element().parentElement!;
  expect(anchors(title)).toEqual([
    ["Fix ", panelOver(HEAD)],
    ["ENG-1", "/tracker/orbit/issues/login"],
    // Keys no tracker of yours has stay inside the commit's link, as written.
    [", not JIRA-9 or ENG-77, see ", panelOver(HEAD)],
    ["orbit/engine", "/orbit/engine"],
  ]);

  // A short hash of a known commit opens the commit panel on this page.
  const sha = page.getByRole("link", { name: "3f2a9c1b", exact: true });
  await expect.element(sha).toHaveAttribute("href", `/orbit/engine/commits/main?commit=${HEAD}`);
  expect(anchors(sha.element().parentElement!)).toEqual([
    ["Revert ", panelOver("b".repeat(40))],
    ["3f2a9c1b", `/orbit/engine/commits/main?commit=${HEAD}`],
    [" and abc1234f", panelOver("b".repeat(40))],
  ]);

  // One batch for the whole list.
  const batches = server.requests.filter((r) => r.url.pathname === "/api/refs/resolve");
  expect(batches).toHaveLength(1);
});

test("titles render as plain text until the answer arrives, and stay so when it fails", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  await server.push("orbit/engine", "main", HEAD);
  await engIssue(server, "orbit", "login", "Fix the login");
  history(server, [commit(HEAD, "Fix ENG-1 now")]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  server.on("POST", "/api/refs/resolve", async ({ body }) => {
    await gate;
    return server.call("POST", "/api/refs/resolve", body);
  });
  const app = renderApp("/orbit/engine/commits/main");

  const whole = page.getByRole("link", { name: "Fix ENG-1 now", exact: true });
  await expect.element(whole).toHaveAttribute("href", panelOver(HEAD));
  const height = whole.element().getBoundingClientRect().height;
  release();
  await expect
    .element(page.getByRole("link", { name: "ENG-1", exact: true }))
    .toHaveAttribute("href", "/tracker/orbit/issues/login");
  // Only the link styling changed: the row kept its height.
  expect(
    page.getByRole("link", { name: "ENG-1", exact: true }).element().getBoundingClientRect().height,
  ).toBeLessThanOrEqual(height + 1);
  app.unmount();

  // A failed batch leaves the text as it was.
  server.on("POST", "/api/refs/resolve", () => reply({ error: "Down." }, 500));
  renderApp("/orbit/engine/commits/main");
  await expect
    .poll(() =>
      server.requests.some((r) => r.url.pathname === "/api/refs/resolve" && r.status === 500),
    )
    .toBe(true);
  await expect
    .element(page.getByRole("link", { name: "Fix ENG-1 now", exact: true }))
    .toHaveAttribute("href", panelOver(HEAD));
});

test("a CI run's title links refs; its log links hashes alone", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  await server.push("orbit/engine", "main", HEAD);
  await engIssue(server, "orbit", "login", "Fix the login");
  const run: CiRunDetail = {
    id: "run",
    number: 1,
    commit: HEAD,
    ref: "main",
    trigger: "push",
    preview: null,
    landing: null,
    queueId: null,
    title: "Land ENG-1 in orbit/engine",
    status: "failed",
    actor: "marco",
    agent: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    heldAt: null,
    coveredBy: null,
    configError: null,
    jobs: [
      {
        id: "job",
        name: "test",
        needs: [],
        status: "failed",
        runner: "local",
        claimedBy: null,
        exitCode: 1,
        error: null,
        startedAt: null,
        finishedAt: null,
        logsRemovedAt: null,
        steps: [
          {
            position: 1,
            name: "Run tests",
            status: "failed",
            exitCode: 1,
            startedAt: null,
            finishedAt: null,
          },
        ],
      },
    ],
  };
  server.on("GET", "/api/repos/:space/:name/ci/runs/:number", () => run);
  server.on("GET", "/api/repos/:space/:name/ci/jobs/:job/logs", (): CiLogs => ({
    chunks: [{ seq: 1, step: 1, text: "Checked out 3f2a9c1b for ENG-1\nfailed in orbit/engine\n" }],
    next: 1,
    done: true,
    removedAt: null,
  }));
  renderApp("/orbit/engine/ci/1");

  const heading = page.getByRole("heading", { level: 2 });
  await expect
    .element(heading.getByRole("link", { name: "ENG-1", exact: true }))
    .toHaveAttribute("href", "/tracker/orbit/issues/login");
  await expect
    .element(heading.getByRole("link", { name: "orbit/engine", exact: true }))
    .toHaveAttribute("href", "/orbit/engine");

  const sha = page.getByRole("link", { name: "3f2a9c1b", exact: true });
  await expect.element(sha).toHaveAttribute("href", `/orbit/engine/ci/1?commit=${HEAD}`);
  // Only hashes in a log: the key and the repository stay text.
  expect(anchors(sha.element().closest("pre")!)).toEqual([
    ["3f2a9c1b", `/orbit/engine/ci/1?commit=${HEAD}`],
  ]);
});

test("a key in two of your trackers offers a chooser", async () => {
  const server = await TestServer.start({ world: true });
  // Sam's public repository: neither tracker below subscribes to it.
  await server.repo("sam", "notes");
  await server.push("sam/notes", "main", HEAD);
  await engIssue(server, "marco", "mine", "Marco's own");
  await engIssue(server, "orbit", "theirs", "Orbit's");
  history(server, [commit(HEAD, "Fix ENG-1")]);
  renderApp("/sam/notes/commits/main");

  const chooser = page.getByRole("button", { name: "ENG-1: 2 matches, choose one" });
  await userEvent.click(chooser);
  await expect
    .element(page.getByRole("link", { name: /ENG-1 · Marco's own/ }))
    .toHaveAttribute("href", "/tracker/marco/issues/mine");
  await expect
    .element(page.getByRole("link", { name: /ENG-1 · Orbit's/ }))
    .toHaveAttribute("href", "/tracker/orbit/issues/theirs");
});

test("issue Markdown links refs it can open, never code, and leaves the rest as written", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  // Francois's own tracker: Marco can't read it.
  await mutate(
    server,
    "fward",
    [
      { kind: "team.create", id: "ops", data: { key: "OPS", name: "Ops" } },
      { kind: "issue.create", id: "ops-1", data: { teamId: "ops", title: "Private" } },
    ],
    "fward",
  );
  // The in-memory API answers as http://localhost: that's this deployment's origin there.
  const ours = "http://localhost/tracker/orbit/issues/ENG-1";
  const closed = "http://localhost/tracker/fward/issues/OPS-1";
  const theirs = "https://elsewhere.test/tracker/orbit/issues/ENG-1";
  await mutate(server, "orbit", [
    { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } },
    { kind: "issue.create", id: "target", data: { teamId: "team", title: "Target" } },
    {
      kind: "issue.create",
      id: "source",
      data: {
        teamId: "team",
        title: "Source",
        description: [
          "See ENG-1 and `ENG-1`, JIRA-1, OPS-1 and orbit/engine.",
          "",
          `Ours ${ours}, closed ${closed}, theirs ${theirs}.`,
          "",
          "```",
          "ENG-1 orbit/engine",
          "```",
        ].join("\n"),
      },
    },
  ]);
  renderApp("/tracker/orbit/issues/ENG-2");

  const url = page.getByRole("link", { name: ours });
  await expect.element(url).toHaveAttribute("href", "/tracker/orbit/issues/target");
  const prose = url.element().closest(".gm-prose")!;
  await expect
    .poll(() => anchors(prose))
    .toEqual([
      ["ENG-1", "/tracker/orbit/issues/target"],
      ["orbit/engine", "/orbit/engine"],
      [ours, "/tracker/orbit/issues/target"],
      // Our tracker, but not yours to open: plain text, not a dead link.
      [theirs, theirs],
    ]);
  expect(prose.textContent).toContain(`closed ${closed}`);
  expect(prose.textContent).toContain("JIRA-1, OPS-1");
  for (const code of prose.querySelectorAll("code")) expect(code.querySelector("a")).toBeNull();
});

test("/-/go/ opens the one match, offers a chooser for several, and says when none", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  await engIssue(server, "marco", "mine", "Marco's own");
  await engIssue(server, "orbit", "theirs", "Orbit's");

  let app = renderApp(`/-/go/${encodeURIComponent("orbit/engine")}`);
  await app.waitForUrl((url) => url.pathname === "/orbit/engine");
  app.unmount();

  app = renderApp("/-/go/ENG-1?tracker=orbit");
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit/issues/theirs");
  app.unmount();

  app = renderApp("/-/go/ENG-1");
  await expect
    .element(page.getByRole("heading", { name: "ENG-1 could be several things" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: /ENG-1 · Orbit's/ }))
    .toHaveAttribute("href", "/tracker/orbit/issues/theirs");
  app.unmount();

  renderApp("/-/go/JIRA-4");
  await expect
    .element(page.getByRole("heading", { name: "Nothing here matches JIRA-4" }))
    .toBeVisible();
});
