import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { focusOn, press } from "../../testing/focus.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { mutate } from "../../testing/timelines.ts";

// Exercise the real feed over persisted notes, including one team's work in two repos.
async function releaseWorld() {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "release-eng",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
    {
      kind: "team.create",
      id: "release-ops",
      data: { key: "OPS", name: "Operations", memberIds: ["acc_marco"] },
    },
  ]);
  await server.call("PUT", "/api/tracker/orbit/preferences", {
    teamId: "release-eng",
    view: "list",
    query: "is:open",
  });
  for (const name of ["release-engine", "release-web"]) {
    const repo = await server.repo("orbit", name);
    await server.sql(
      "INSERT INTO release_note_state (repo_id, status, format_version, dirty) VALUES (?, 'ready', 1, 0)",
      repo.id,
    );
    await server.sql(
      "INSERT INTO release_notes (repo_id, release, to_oid, released_at, updated_at, format_version) VALUES (?, '@day:2026-09-20', 'c1', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', 1)",
      repo.id,
    );
    const teams = name === "release-engine" ? ["ENG", "OPS"] : ["ENG"];
    for (const team of teams) {
      await server.sql(
        `INSERT INTO release_note_entries
          (id, repo_id, release, subject, kind, category, title, summary, tracker_owner_id,
           issue_id, issue_key, team_id, team_key, inputs_hash, shipped_at, updated_at)
         VALUES (?, ?, '@day:2026-09-20', ?, 'issue', ?, ?, '', 'acc_orbit', ?, ?, ?, ?, 'h',
           '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z')`,
        `${name}-${team}`,
        repo.id,
        `issue:acc_orbit:${team}-1`,
        team === "OPS" ? "fix" : "feature",
        `${team} ${name} update`,
        `${team}-1`,
        `${team}-1`,
        `release-${team.toLowerCase()}`,
        team,
      );
    }
  }
  return server;
}

for (const scenario of [
  {
    name: "saved default",
    search: "",
    team: "ENG",
    titles: ["ENG release-engine update", "ENG release-web update"],
  },
  {
    name: "explicit team overrides default and drops issue-only filters",
    search: "?q=team%3Aops%20is%3Aopen%20assignee%3Ame",
    team: "OPS",
    titles: ["OPS release-engine update"],
  },
  {
    name: "explicit all-teams scope overrides default",
    search: "?q=",
    team: null,
    titles: ["ENG release-engine update", "ENG release-web update", "OPS release-engine update"],
  },
]) {
  test(`tracker release notes respect ${scenario.name}`, async () => {
    await releaseWorld();
    const app = renderApp(`/tracker/orbit${scenario.search}`);
    const link = page.getByRole("link", {
      name: scenario.team ? `Release notes for ${scenario.team}` : "All release notes",
      exact: true,
    });
    await focusOn(link);
    await press("Enter");
    await app.waitForUrl((url) => url.pathname === "/tracker/orbit/releases");
    await expect
      .element(page.getByRole("textbox", { name: "Filter release notes" }))
      .toHaveValue(scenario.team ? `team:${scenario.team.toLowerCase()}` : "");
    for (const title of [
      "ENG release-engine update",
      "ENG release-web update",
      "OPS release-engine update",
    ]) {
      if (scenario.titles.includes(title))
        await expect.element(page.getByText(title, { exact: true })).toBeVisible();
      else await expect.element(page.getByText(title, { exact: true })).not.toBeInTheDocument();
    }
  });
}

test("the top-level rail opens cross-repository notes and supports repository and type slicing", async () => {
  await releaseWorld();
  const app = renderApp("/tracker/orbit");
  await page
    .getByRole("navigation", { name: "Places" })
    .getByRole("link", { name: "Release notes", exact: true })
    .click();
  await app.waitForUrl((url) => url.pathname === "/tracker/orbit/releases");
  await expect.element(page.getByText("ENG release-web update", { exact: true })).toBeVisible();
  await expect.element(page.getByText("OPS release-engine update", { exact: true })).toBeVisible();
  const filter = page.getByRole("textbox", { name: "Filter release notes" });
  await filter.fill("repo:release-engine type:fix");
  await focusOn(filter);
  await press("Enter");
  await app.waitForUrl((url) => url.searchParams.get("q") === "repo:release-engine type:fix");
  await expect.element(page.getByText("OPS release-engine update", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("ENG release-engine update", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("ENG release-web update", { exact: true }))
    .not.toBeInTheDocument();
});
