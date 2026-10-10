import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { BlobResponse, CiRunDetail } from "../../shared/api.ts";
import { commitId } from "../testing/atlas.ts";
import { cannedFiles } from "../testing/git.ts";
import { renderApp } from "../testing/render.tsx";
import { reply, TestServer } from "../testing/server.ts";

test("issue selection and saved live edits publish titles without reloading the tracker", async () => {
  const server = await TestServer.start({ world: true });
  await server.call("POST", "/api/tracker/orbit/mutate", {
    operationId: crypto.randomUUID(),
    mutations: [
      { kind: "team.create", id: "titles-team", data: { key: "TAB", name: "Titles" } },
      {
        kind: "issue.create",
        id: "titles-first",
        data: { teamId: "titles-team", title: "Private first issue" },
      },
      {
        kind: "issue.create",
        id: "titles-second",
        data: { teamId: "titles-team", title: "Private second issue" },
      },
    ],
  });
  const app = renderApp("/tracker/orbit/issues/titles-first");
  await expect.poll(() => document.title).toContain("TAB-1 Private first issue");
  const loads = server.requests.filter((request) =>
    request.url.pathname.endsWith("/orbit/view"),
  ).length;

  // Selection changes do not revalidate the loader; the snapshot must supply the new issue.
  await app.navigate("/tracker/orbit/issues/TAB-2");
  await expect.poll(() => document.title).toContain("TAB-2 Private second issue");
  await userEvent.click(page.getByRole("button", { name: "Private second issue", exact: true }));
  await userEvent.fill(
    page.getByRole("textbox", { name: "Title", exact: true }),
    "Renamed live issue",
  );
  await userEvent.keyboard("{Tab}");
  await expect.poll(() => document.title).toContain("TAB-2 Renamed live issue");
  expect(document.title).not.toContain("Private second issue");
  expect(
    server.requests.filter((request) => request.url.pathname.endsWith("/orbit/view")),
  ).toHaveLength(loads);

  await app.navigate("/tracker/orbit/issues/missing-issue");
  await expect.poll(() => document.title).toContain("Issue unavailable");
  expect(document.title).not.toContain("Renamed live issue");
  await app.navigate("/tracker/orbit");
  await expect.poll(() => document.title).toBe("orbit · Issues · Gitmatrix");
  await app.navigate("/settings/preferences");
  await expect.poll(() => document.title).toBe("Preferences · Gitmatrix");

  // A protected destination redirects to auth, not the issue we were looking at.
  server.on("GET", "/api/tracker/private/view", () => reply({ error: "Sign in" }, 401));
  await app.navigate("/tracker/private/issues/secret");
  await expect.poll(() => document.title).toBe("Sign in · Gitmatrix");
  expect(app.url().pathname).toBe("/signin");
});

test("repository, file and CI titles clear during loading and after failed navigation", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const commit = commitId();
  await server.push("orbit/engine", "main", commit);
  cannedFiles(server, commit);
  // cannedFiles supplies tree/history only; the in-memory repository has no blob objects.
  server.on("GET", "/api/repos/orbit/engine/blob", ({ url }): BlobResponse => {
    expect(url.searchParams.get("at")).toBe("main/README.md");
    return {
      ref: "main",
      commitOid: commit,
      path: "README.md",
      size: 9,
      contentType: "text/markdown",
      binary: false,
      text: "# Engine\n",
      truncated: false,
    };
  });
  const run: CiRunDetail = {
    id: "title-run",
    number: 42,
    commit,
    ref: "main",
    trigger: "landing",
    preview: null,
    landing: null,
    queueId: null,
    title: "Checks",
    status: "succeeded",
    actor: null,
    agent: null,
    createdAt: "2026-10-09T10:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-10-09T10:01:00.000Z",
    heldAt: null,
    coveredBy: null,
    configError: null,
    jobs: [],
  };
  server.on("GET", "/api/repos/orbit/engine/ci/runs/42", () => run);
  server.on("GET", "/api/packages/-/published", () => ({ rows: [] }));
  const app = renderApp("/orbit/engine");
  await expect.poll(() => document.title).toContain("orbit/engine · Code");
  await userEvent.click(page.getByRole("link", { name: "README.md", exact: true }));
  await expect.poll(() => document.title).toContain("README.md · orbit/engine · File");
  await app.navigate("/orbit/engine/ci/42");
  await expect.poll(() => document.title).toContain("orbit/engine · CI #42");
  expect(document.title).not.toContain("README.md");

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.on("GET", "/api/tracker/private/view", async () => {
    await blocked;
    return reply({ error: "Private resource must not appear in a tab" }, 403);
  });
  const navigation = app.navigate("/tracker/private/issues/private-key");
  try {
    await expect.poll(() => document.title).toBe("Loading · Gitmatrix");
  } finally {
    release();
  }
  await navigation;
  await expect.poll(() => document.title).toBe("Access denied · Gitmatrix");
  expect(document.title).not.toMatch(/private|engine|42/i);

  await app.navigate("/signin?next=/tracker/private/issues/private-key");
  await expect.poll(() => document.title).toBe("Sign in · Gitmatrix");
  await app.navigate("/this/path/has/no/route");
  await expect.poll(() => document.title).toBe("Page not found · Gitmatrix");
  await app.navigate("/orbit/engine/ci/42");
  await expect.poll(() => document.title).toContain("orbit/engine · CI #42");
});

test("an initial root-loader failure replaces an earlier private document title", async () => {
  const server = await TestServer.start({ world: true });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.on("GET", "/api/session", async () => {
    await blocked;
    return reply({ error: "Session unavailable" }, 503);
  });
  document.title = "Private issue from the previous document";
  renderApp("/settings/profile");
  try {
    await expect.poll(() => document.title).toBe("Loading · Gitmatrix");
  } finally {
    release();
  }
  await expect.poll(() => document.title).toBe("Page unavailable · Gitmatrix");
});
