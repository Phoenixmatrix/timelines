// The commit side panel (CORE-22) in a real browser: `?commit=` on any
// repository page opens it over the page with every section (message,
// author and who made and pushed it, parents, the change and its landing,
// cited issues linked only when they resolve, CI, packages, deployments and
// files); Escape closes it back to the page; a SHA link opens it in place
// and closing goes Back; parents open in the panel; a short hash resolves;
// bad hashes say so; and it fits a phone. Deployment presence is lazy and
// source-scoped even for records outside CI, independently of commit presence.
// The in-memory repositories have no git objects or CI, so commits, runs,
// publishes, deployments and the why chain are canned; issues come from the real tracker and search.

import { act } from "react";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { AgentPresence } from "../../../shared/agent-presence.ts";
import type { CiRunList, CiRunSummary, RepoDetail } from "../../../shared/api.ts";
import type { Deployment, DeploymentList } from "../../../shared/deployments.ts";
import type { CommitDiff } from "../../../shared/diff.ts";
import type { Published } from "../../../shared/packages.ts";
import type { SearchResponse } from "../../../shared/search.ts";
import type { StepPage } from "../../../shared/steps.ts";
import type { WhyChain, WhyResponse } from "../../../shared/why.ts";
import { commitId, sidewaysOverflow } from "../../testing/atlas.ts";
import { press } from "../../testing/focus.ts";
import { cannedFiles } from "../../testing/git.ts";
import { renderApp } from "../../testing/render.tsx";
import { reply, TestServer } from "../../testing/server.ts";
import { visual } from "../../testing/visual.ts";

const short = (oid: string) => oid.slice(0, 7);
const panel = (oid: string) => page.getByRole("dialog", { name: `Commit ${short(oid)}` });

async function world() {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  // A letter up front: a short hash of digits alone reads as a number, not a commit.
  const head = `a${commitId().slice(1)}`;
  await server.push("orbit/engine", "main", head);
  cannedFiles(server, head);
  // A real issue in orbit's tracker: its key resolves; NOPE-9 doesn't.
  await server.call("POST", "/api/tracker/orbit/mutate", {
    operationId: "panel-fixtures",
    mutations: [
      {
        kind: "team.create",
        id: "panel-team",
        data: { key: "PAL", name: "Panel", memberIds: ["acc_marco"] },
      },
      {
        kind: "issue.create",
        id: "panel-issue",
        data: { teamId: "panel-team", title: "Rank by recency", status: "todo" },
      },
    ],
  });
  const found = await server.call<SearchResponse>(
    "GET",
    "/api/search?q=Rank%20by%20recency&categories=issues",
  );
  const group = found.groups[0]!;
  const key =
    group.status === "ok" && group.results[0]?.category === "issues" ? group.results[0].key : "";
  expect(key).toMatch(/^PAL-\d+$/);

  const parent = commitId();
  const diffs = new Map<string, CommitDiff>();
  const diff = (oid: string, message: string, parents: string[]): CommitDiff => ({
    oid,
    parents,
    message,
    authorName: "Marco Rossi",
    authoredAt: Math.floor(Date.now() / 1000) - 3600,
    truncated: false,
    files: [
      {
        path: "src/rank.ts",
        status: "added",
        additions: 3,
        deletions: 0,
        binary: false,
        omitted: false,
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 3,
            lines: ["+export function rank() {", "+  return byRecency();", "+}"],
          },
        ],
      },
      {
        path: "src/old.ts",
        status: "deleted",
        additions: 0,
        deletions: 5,
        binary: false,
        omitted: false,
        hunks: [],
      },
      {
        path: "README.md",
        status: "modified",
        additions: 2,
        deletions: 1,
        binary: false,
        omitted: false,
        hunks: [],
      },
    ],
  });
  diffs.set(head, diff(head, `Rank results by recency\n\nFixes ${key} and NOPE-9.\n`, [parent]));
  diffs.set(parent, diff(parent, "Add the search index", []));
  server.on(
    "GET",
    "/api/repos/:owner/:name/commits/:oid/diff",
    ({ params }) => diffs.get(params.oid!) ?? reply({ error: `No commit ${params.oid}.` }, 404),
  );

  const run: CiRunSummary = {
    id: "run12",
    number: 12,
    commit: head,
    ref: "main",
    trigger: "push",
    preview: null,
    landing: null,
    title: "Push to main",
    status: "succeeded",
    actor: "marco",
    agent: null,
    createdAt: new Date(Date.now() - 1800_000).toISOString(),
    startedAt: null,
    finishedAt: null,
    heldAt: null,
    coveredBy: null,
  };
  server.on("GET", "/api/repos/:owner/:name/ci", ({ url }): CiRunList => ({
    runs: url.searchParams.get("commit") === head ? [run] : [],
    runner: "local",
  }));
  server.on("GET", "/api/packages/-/published", ({ url }): Published => ({
    rows:
      url.searchParams.get("commit") === head
        ? [
            {
              id: "pub1",
              format: "npm",
              package: "orbit-kit",
              feed: "orbit",
              version: "1.4.0",
              status: "active",
              digest: null,
              size: 2048,
              at: new Date().toISOString(),
              repo: "orbit/engine",
              ref: "main",
              commit: head,
              runNumber: 12,
              actor: "marco",
              via: "ci",
              tags: [],
            },
          ]
        : [],
  }));
  server.on("GET", "/api/repos/:owner/:name/deployments", ({ url }): DeploymentList => ({
    deployments:
      url.searchParams.get("commit") === head
        ? [
            {
              id: 3,
              environment: "preview",
              timeline: "fast-search",
              timelineId: null,
              checkpoint: null,
              commit: head,
              url: "https://pr-12.example.dev",
              status: "active",
              run: 12,
              job: "deploy",
              actor: "marco",
              agent: null,
              expiresAt: null,
              expiryPinned: false,
              revived: false,
              createdAt: new Date().toISOString(),
            } as unknown as Deployment,
          ]
        : [],
    next: null,
  }));
  const pushed = {
    id: 1,
    ref: "refs/heads/main",
    old: parent,
    new: head,
    forced: false,
    actor: "marco",
    agent: "claude-code",
    createdAt: new Date(Date.now() - 600_000).toISOString(),
  };
  server.on("GET", "/api/repos/:owner/:name/why", ({ url }): WhyResponse => {
    const oid = url.searchParams.get("commit")!;
    const chain: WhyChain = {
      commit: null,
      oid,
      lines: [],
      changeId: oid === head ? "kqvzmxyzwpnlrstu" : null,
      changeSource: oid === head ? "push-log" : null,
      refs:
        oid === head
          ? [
              {
                ref: "refs/heads/main",
                kind: "main",
                timeline: null,
                firstCommit: head,
                firstSeenAt: pushed.createdAt,
                firstUpdate: pushed,
                lastCommit: head,
                lastSeenAt: pushed.createdAt,
                rewritten: false,
                afterLanding: false,
              },
            ]
          : [],
      timelines:
        oid === head
          ? [
              {
                id: "tl1",
                slug: "fast-search",
                name: "Fast search",
                status: "landed",
                policy: "auto",
                experimental: false,
              },
            ]
          : [],
      merges: [],
      issues: [],
      checkpoints: [],
      approval: null,
      landing:
        oid === head
          ? {
              ref: "refs/heads/main",
              commit: head,
              at: pushed.createdAt,
              update: pushed,
              via: "queue",
              timeline: "fast-search",
              queue: null,
            }
          : null,
      discussions: { available: false, reason: "", threads: [] },
      step: null,
    };
    return {
      repo: { owner: "orbit", name: "engine", defaultBranch: "main" },
      tracker: { owner: "orbit", readable: true },
      blame: null,
      chains: [chain],
      people: {},
    };
  });
  server.on(
    "GET",
    "/api/repos/:owner/:name/steps",
    ({ url }) =>
      ({
        steps:
          url.searchParams.get("commits") === head
            ? [
                {
                  changeId: "kqvzmxyzwpnlrstu",
                  commitOid: head,
                  summary: "Rank results by recency",
                  timeline: "fast-search",
                  issue: key,
                  author: {
                    id: "agt_1",
                    kind: "agent",
                    name: "claude-code",
                    accountable: {
                      id: "acc_marco",
                      slug: "marco",
                      displayName: "Marco",
                      avatarUrl: null,
                    },
                  },
                  committedAt: new Date().toISOString(),
                  verified: true,
                  deleted: false,
                },
              ]
            : [],
        cursor: null,
      }) as unknown as StepPage,
  );
  return { server, head, parent, key };
}

test("?commit= opens every section over the page; Escape closes back to it", async () => {
  const { server, head, parent, key } = await world();
  const app = renderApp(`/orbit/engine?commit=${head}`);
  const dialog = panel(head);
  await expect.element(dialog).toBeVisible();
  // Message, who wrote, made and pushed it, parents and the tree.
  await expect.element(dialog.getByText("Rank results by recency").first()).toBeVisible();
  const message = dialog.getByRole("region", { name: "Message" });
  await expect.element(message).toMatchTextContent(/Fixes PAL-\d+ and NOPE-9\./);
  await expect.element(dialog.getByText("Marco Rossi")).toBeVisible();
  await expect
    .element(dialog.getByRole("link", { name: "Marco", exact: true }))
    .toHaveAttribute("href", "/marco");
  await expect.element(dialog.getByText(/claude-code for/).first()).toBeVisible();
  await expect
    .element(dialog.getByRole("link", { name: "marco", exact: true }).first())
    .toHaveAttribute("href", "/marco");
  await expect
    .element(dialog.getByRole("link", { name: `Open parent commit ${short(parent)}` }))
    .toBeVisible();
  await expect
    .element(dialog.getByRole("link", { name: "Browse files at this commit" }))
    .toHaveAttribute("href", `/orbit/engine/tree/${head}`);
  // The change, its timeline and landing.
  await expect.element(dialog.getByText("kqvzmxyzwpnl")).toBeVisible();
  await expect.element(dialog.getByText(/Landed on/)).toBeVisible();
  await visual("Commit panel");
  await expect
    .element(dialog.getByRole("link", { name: "Fast search" }))
    .toHaveAttribute("href", "/tracker/orbit/timelines?tl=fast-search");
  // Issues, through the real resolver: the real one links (in the message too); NOPE-9 stays text.
  const issues = dialog.getByRole("region", { name: /Issues it mentions/ });
  await expect
    .element(issues.getByRole("link", { name: key }))
    .toHaveAttribute("href", "/tracker/orbit/issues/panel-issue");
  await expect.element(issues.getByText("NOPE-9", { exact: true })).toBeVisible();
  await expect.element(issues.getByText("not an issue you can open here")).toBeVisible();
  expect(dialog.getByRole("link", { name: /NOPE-9/ }).elements()).toHaveLength(0);
  await expect.poll(() => message.getByRole("link").elements().length).toBeGreaterThan(0);
  // CI, packages, deployments.
  await expect
    .element(dialog.getByRole("link", { name: /#12\s*Push to main/ }))
    .toHaveAttribute("href", "/orbit/engine/ci/12");
  await expect
    .element(dialog.getByRole("link", { name: /orbit-kit\s*1\.4\.0/ }))
    .toHaveAttribute("href", "/orbit/-/packages/npm/orbit-kit?version=1.4.0");
  await expect
    .element(dialog.getByRole("link", { name: "pr-12.example.dev" }))
    .toHaveAttribute("href", "https://pr-12.example.dev");
  // Files, each at this commit (a deleted one before it), with stats.
  await expect
    .element(dialog.getByRole("link", { name: "View src/rank.ts" }))
    .toHaveAttribute("href", `/orbit/engine/blob/${head}/src/rank.ts`);
  await expect
    .element(dialog.getByRole("link", { name: "View src/old.ts" }))
    .toHaveAttribute("href", `/orbit/engine/blob/${parent}/src/old.ts`);
  await expect.element(dialog.getByText("+3").first()).toBeVisible();
  // The hunks too, with line numbers (CORE-382).
  const rankChanges = dialog.getByRole("table", { name: "Changes to src/rank.ts" });
  await expect.element(rankChanges).toMatchTextContent(/@@ -0,0 \+1,3 @@/);
  await expect.element(rankChanges).toMatchTextContent(/2\s*\+\s*return byRecency\(\);/);
  expect(server.unhandled).toEqual([]);

  // Escape closes it, leaving the page and dropping the parameter.
  await press("Escape");
  await expect.element(dialog).not.toBeInTheDocument();
  await app.waitForUrl(
    (url) => url.pathname === "/orbit/engine" && !url.searchParams.has("commit"),
  );
  await expect.element(page.getByRole("region", { name: "Repository files" })).toBeVisible();
});

test("on a work source's page it reads the commit from that source (CORE-296)", async () => {
  const { server, head } = await world();
  // The page is the repository's timeline work source: the layout reads it from `?source=`.
  const detail = await server.call<RepoDetail>("GET", "/api/repos/orbit/engine");
  server.on("GET", "/api/repos/:owner/:name", ({ url }) =>
    url.searchParams.get("source") === "work_1"
      ? {
          ...detail,
          source: {
            sourceId: "work_1",
            repoId: detail.id,
            kind: "timeline-work",
            timelineId: "tl_1",
            ref: "refs/heads/work",
          },
          sourceState: "ready",
        }
      : detail,
  );
  const mark = server.requests.length;
  renderApp(`/orbit/engine?source=work_1&commit=${head}`);
  const dialog = panel(head);
  await expect.element(dialog.getByText("Rank results by recency").first()).toBeVisible();
  await expect
    .element(dialog.getByRole("link", { name: "Browse files at this commit" }))
    .toHaveAttribute("href", `/orbit/engine/tree/${head}?source=work_1`);
  const read = (suffix: string) =>
    server
      .since(mark, "/api/repos/orbit/engine/")
      .filter((r) => r.url.pathname.endsWith(suffix))
      .map((r) => r.url.searchParams.get("source"));
  expect(read(`/commits/${head}/diff`)).toContain("work_1");
  await expect.poll(() => read("/why")).toContain("work_1");
  await expect.poll(() => read("/ci")).toContain("work_1");
});

const UNINSTRUMENTED = {
  provider: null,
  artifact: null,
  deployedAt: null,
  exposedFrom: null,
  exposedUntil: null,
  percentage: null,
  replaces: null,
} satisfies Partial<Deployment>;

test("deployment provenance shows exactly what was recorded, and says when no version was", async () => {
  const { server, head } = await world();
  const now = new Date().toISOString();
  const base = {
    ...UNINSTRUMENTED,
    repoId: "repo_engine",
    sourceId: "canonical",
    timeline: null,
    timelineId: null,
    checkpoint: null,
    commit: head,
    status: "active" as const,
    run: null,
    job: null,
    actor: "marco",
    agent: null,
    expiresAt: null,
    expiryPinned: false,
    revived: false,
    rebuiltFrom: null,
    tornDownAt: null,
    teardownRun: null,
    createdAt: now,
    updatedAt: now,
  };
  const deployments: Deployment[] = [
    {
      ...base,
      id: 51,
      environment: "production",
      url: "https://canary.example.dev",
      provider: {
        name: "cloudflare",
        service: "engine",
        versionId: "4f1c2d3e-0000-4000-8000-000000000002",
        deploymentId: "dep-2",
      },
      percentage: 10,
      replaces: { versionId: "9a8b7c6d-0000-4000-8000-000000000001", deploymentId: 50 },
      artifact: {
        publishId: "01PUB",
        packageId: "pkg_engine",
        format: "npm",
        name: "engine",
        version: "1.2.3",
        digest: `sha256:${"ab".repeat(32)}`,
      },
      deployedAt: "2026-10-12T20:00:00.000Z",
      exposedFrom: "2026-10-12T20:01:00.000Z",
    },
    { ...base, id: 52, environment: "staging", url: "https://staging.example.dev" },
  ];
  server.on("GET", "/api/repos/:owner/:name/deployments", () => ({ deployments, next: null }));
  renderApp(`/orbit/engine?commit=${head}`);
  const section = panel(head).getByRole("region", { name: /Deployments and previews/ });
  await expect.element(section.getByText("engine 4f1c2d3e", { exact: true })).toBeVisible();
  await expect.element(section.getByText("10% of traffic")).toBeVisible();
  await expect.element(section.getByText("9a8b7c6d", { exact: true })).toBeVisible();
  await expect.element(section.getByText(/engine@1\.2\.3/)).toBeVisible();
  // Local time with the zone named, UTC on hover.
  const deployed = section
    .getByText(/^deployed/)
    .element()
    .querySelector("time")!;
  expect(deployed.getAttribute("datetime")).toBe("2026-10-12T20:00:00.000Z");
  expect(deployed.getAttribute("title")).toBe("2026-10-12T20:00:00Z (UTC)");
  expect(deployed.textContent).toMatch(/(GMT|UTC|[A-Z]{2,5})/);
  // An uninstrumented record never looks definite.
  await expect.element(section.getByText("No provider version recorded")).toBeVisible();
  expect(section.getByText("No provider version recorded").elements()).toHaveLength(1);
});

test("non-CI deployment observers are lazy, source-scoped and poll only the expanded row", async () => {
  const { server, head } = await world();
  const now = new Date().toISOString();
  const deployments: Deployment[] = [41, 42].map((id) => ({
    ...UNINSTRUMENTED,
    id,
    repoId: "repo_engine",
    sourceId: `source_${id}`,
    environment: `external-${id}`,
    timeline: null,
    timelineId: null,
    checkpoint: null,
    commit: head,
    url: `https://deploy-${id}.example.dev`,
    status: "active",
    run: null,
    job: null,
    actor: "marco",
    agent: null,
    expiresAt: null,
    expiryPinned: false,
    revived: false,
    rebuiltFrom: null,
    tornDownAt: null,
    teardownRun: null,
    createdAt: now,
    updatedAt: now,
  }));
  server.on("GET", "/api/repos/:owner/:name/deployments", () => ({ deployments, next: null }));
  const presence = (name: string): AgentPresence => ({
    agents: [
      {
        id: name,
        name,
        accountable: { slug: "marco", displayName: "Marco" },
        lastSeenAt: now,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    ],
    asOf: now,
    windowSeconds: 600,
    truncated: false,
  });
  server.on("GET", "/api/repos/:owner/:name/commits/:oid/presence", () =>
    presence("commit observer"),
  );
  server.on("GET", "/api/repos/:owner/:name/deployments/:id/presence", ({ params }) =>
    presence(`deployment observer ${params.id}`),
  );
  const mark = server.requests.length;
  const reads = (resource: string) =>
    server
      .since(mark, `/api/repos/orbit/engine/${resource}`)
      .filter((request) => request.url.pathname.endsWith("/presence"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    renderApp(`/orbit/engine?commit=${head}`);
    const dialog = panel(head);
    const section = dialog.getByRole("region", { name: /Deployments and previews/ });
    const toggles = section.getByRole("button", { name: "Agents seen recently" });
    await expect.element(toggles.first()).toBeVisible();
    await expect.element(dialog.getByText("commit observer", { exact: true })).toBeVisible();
    await expect
      .element(section.getByRole("link", { name: "deploy-41.example.dev" }))
      .toHaveAttribute("href", "https://deploy-41.example.dev");
    expect(section.getByRole("link", { name: /run #/ }).elements()).toHaveLength(0);
    expect(reads("deployments")).toHaveLength(0);

    await userEvent.click(toggles.first());
    await expect
      .element(section.getByText("deployment observer 41", { exact: true }))
      .toBeVisible();
    expect(
      reads("deployments").map((request) => [
        request.url.pathname,
        request.url.searchParams.get("source"),
      ]),
    ).toEqual([["/api/repos/orbit/engine/deployments/41/presence", "source_41"]]);
    await userEvent.click(toggles.last());
    await expect
      .element(section.getByText("deployment observer 42", { exact: true }))
      .toBeVisible();
    await expect
      .element(section.getByText("deployment observer 41", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(toggles.first()).toHaveAttribute("aria-expanded", "false");
    await expect.element(toggles.last()).toHaveAttribute("aria-expanded", "true");
    expect(reads("deployments/42")[0]?.url.searchParams.get("source")).toBe("source_42");

    const firstCount = reads("deployments/41").length;
    const secondCount = reads("deployments/42").length;
    const commitCount = reads("commits").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await expect.poll(() => reads("deployments/42").length).toBeGreaterThan(secondCount);
    await expect.poll(() => reads("commits").length).toBeGreaterThan(commitCount);
    expect(reads("deployments/41")).toHaveLength(firstCount);

    await userEvent.click(toggles.last());
    await expect
      .element(section.getByText("deployment observer 42", { exact: true }))
      .not.toBeInTheDocument();
    const collapsedCount = reads("deployments").length;
    const ongoingCommitCount = reads("commits").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await expect.poll(() => reads("commits").length).toBeGreaterThan(ongoingCommitCount);
    expect(reads("deployments")).toHaveLength(collapsedCount);
    await expect.element(dialog.getByText("commit observer", { exact: true })).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});

test("a SHA link opens it in place, parents open inside, and closing goes Back to the page", async () => {
  const { head, parent } = await world();
  const app = renderApp("/orbit/engine/commits/main");
  const trigger = page.getByRole("link", { name: "Fixture" }).first();
  await expect.element(trigger).toBeVisible();
  await userEvent.click(trigger);
  await app.waitForUrl(
    (url) =>
      url.pathname === "/orbit/engine/commits/main" && url.searchParams.get("commit") === head,
  );
  const dialog = panel(head);
  await expect.element(dialog).toBeVisible();
  // Focus moves into the panel.
  await expect
    .poll(() => (dialog.element() as HTMLElement).contains(document.activeElement))
    .toBe(true);
  // The page stays under it (inert while the panel is modal), not reloaded away.
  expect(document.querySelector("main")?.textContent).toContain("Repository history");

  await userEvent.click(dialog.getByRole("link", { name: `Open parent commit ${short(parent)}` }));
  await app.waitForUrl((url) => url.searchParams.get("commit") === parent);
  await expect.element(panel(parent)).toBeVisible();
  await expect.element(panel(parent).getByText("None: the first commit")).toBeVisible();

  await userEvent.click(panel(parent).getByRole("button", { name: "Close commit" }));
  await app.waitForUrl((url) => url.pathname === "/orbit/engine/commits/main" && !url.search);
  await expect.element(panel(parent)).not.toBeInTheDocument();
  await expect.element(page.getByRole("heading", { name: "Repository history" })).toBeVisible();
});

test("loading, a short hash, and hashes that aren't commits", async () => {
  const { server, head } = await world();
  // Hold the diff until the loading state has been seen.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const diffs = new Map<string, unknown>();
  server.on("GET", "/api/repos/:owner/:name/commits/:oid/diff", async ({ params }) => {
    await held;
    return diffs.get(params.oid!) ?? reply({ error: "No commit." }, 404);
  });
  diffs.set(head, {
    oid: head,
    parents: [],
    message: "Held commit",
    authorName: "Marco",
    authoredAt: 0,
    files: [],
    truncated: false,
  } satisfies CommitDiff);

  // A short hash resolves to main's head.
  const app = renderApp(`/orbit/engine?commit=${short(head)}`);
  const dialog = page.getByRole("dialog", { name: `Commit ${short(head)}` });
  await expect.element(dialog.getByText("Loading the commit…")).toBeVisible();
  release();
  await expect.element(dialog.getByText("Held commit").first()).toBeVisible();
  await expect.element(dialog.getByText(head)).toBeVisible();

  await app.navigate("/orbit/engine?commit=zzz");
  await expect
    .element(page.getByRole("dialog").getByText("“zzz” isn't a commit hash."))
    .toBeVisible();
  const missing = commitId();
  await app.navigate(`/orbit/engine?commit=${missing}`);
  await expect
    .element(page.getByRole("dialog").getByText(`No commit ${short(missing)} in orbit/engine.`))
    .toBeVisible();
  await app.navigate("/orbit/engine?commit=abcdef0");
  await expect
    .element(page.getByRole("dialog").getByText(/No commit starting abcdef0/))
    .toBeVisible();
});

test("on a phone it fills the screen without sideways scrolling", async () => {
  const { head } = await world();
  await page.viewport(390, 844);
  try {
    renderApp(`/orbit/engine/ci?commit=${head}`);
    const dialog = panel(head);
    await expect.element(dialog.getByRole("link", { name: "View src/rank.ts" })).toBeVisible();
    const box = (dialog.element() as HTMLElement).getBoundingClientRect();
    expect(box.width).toBeGreaterThan(380);
    expect(box.right).toBeLessThanOrEqual(390);
    expect(sidewaysOverflow()).toBe(0);
    // Touch-sized close control.
    const close = dialog.getByRole("button", { name: "Close commit" }).element() as HTMLElement;
    expect(close.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect
      .element(dialog.getByRole("link", { name: "Browse files at this commit" }))
      .toBeVisible();
  } finally {
    await page.viewport(1280, 900);
  }
});
