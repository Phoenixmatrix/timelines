// Linked work on the issue page (CORE-22) in a real browser, against the
// tracker in memory: a commit whose message names the issue shows under
// "Mentioned in", apart from the evidence, with the CI run on that commit and
// the package it published; its SHA opens the commit panel (`?commit=`). At
// phone width nothing scrolls sideways. The mention, run and publish are rows
// as the push log, CI and the registry leave them.

import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { commitId, sidewaysOverflow } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";

test("the issue page lists a mentioning commit with its CI run and package", async () => {
  const server = await TestServer.start({ world: true });
  const repo = await server.repo("orbit", "engine");
  const tip = commitId();
  await server.push("orbit/engine", "main", tip);
  await server.call("POST", "/api/tracker/orbit/mutate", {
    ...(await server.trackerContract("orbit")),
    operationId: crypto.randomUUID(),
    mutations: [
      { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng", memberIds: [] } },
      { kind: "issue.create", id: "rank", data: { teamId: "team", title: "Rank search results" } },
    ],
  });
  const [orbit] = await server.sql<{ id: string }>("SELECT id FROM spaces WHERE slug = 'orbit'");
  // What the push log indexed, the run CI started and the package it published.
  await server.sql(
    `INSERT INTO commit_issue_mentions (repo_id, commit_oid, issue_key, resolution, tracker_space_id, issue_id, title, committed_at, first_ref)
     VALUES (?, ?, 'ENG-1', 'linked', ?, 'rank', 'ENG-1: Rank by freshness and click-through', '2026-10-03T09:00:00.000Z', 'refs/heads/main')`,
    repo.id,
    tip,
    orbit!.id,
  );
  await server.sql(
    `INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, title)
     VALUES ('run-mention', ?, 12, ?, 'refs/heads/main', 'push', 'succeeded', 'ENG-1: Rank by freshness')`,
    repo.id,
    tip,
  );
  await server.registrySql(
    `INSERT INTO repositories (id, space_id, key, format, kind, visibility, config, created_at, updated_at)
     VALUES ('feed', ?, 'orbit', 'npm', 'local', 'private', '{}', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z')`,
    orbit!.id,
  );
  await server.registrySql(
    `INSERT INTO packages (id, repo_id, name, normalized_name, created_at, updated_at)
     VALUES ('pkg', 'feed', '@orbit/ranker', '@orbit/ranker', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z')`,
  );
  await server.registrySql(
    `INSERT INTO publishes (id, feed_id, format, package_id, version, action, status, git_repo_id, commit_oid, actor, actor_label, via, at)
     VALUES ('pub', 'feed', 'npm', 'pkg', '2.1.0', 'publish', 'active', ?, ?, 'job:j', 'ci', 'ci', '2026-10-03T09:10:00Z')`,
    repo.id,
    tip,
  );

  await page.viewport(390, 844);
  try {
    renderApp("/tracker/orbit/issues/ENG-1");
    const panel = page.getByRole("region", { name: "Linked work" });
    const mentions = panel.getByText("Mentioned in", { exact: true });
    await expect.element(mentions, { timeout: 10_000 }).toBeVisible();
    await expect
      .element(panel.getByText(/Commits whose message names ENG-1\. A mention, not evidence/))
      .toBeVisible();
    // The commit: its title, repository and short SHA; it opens the commit panel.
    const commit = panel.getByRole("link", {
      name: new RegExp(`^Commit ${tip.slice(0, 7)} in orbit/engine`),
    });
    await expect.element(commit).toHaveAttribute("href", `/orbit/engine?commit=${tip}`);
    await expect.element(commit).toMatchTextContent("ENG-1: Rank by freshness and click-through");
    await expect.element(commit).toMatchTextContent(`orbit/engine · ${tip.slice(0, 7)}`);
    // Its CI run and its package, under it.
    const run = panel.getByRole("link", { name: /Run #12/ });
    await expect.element(run).toHaveAttribute("href", "/orbit/engine/ci/12");
    await expect.element(run).toMatchTextContent("succeeded");
    const pkg = panel.getByRole("link", { name: /@orbit\/ranker@2\.1\.0/ });
    await expect.element(pkg).toHaveAttribute("href", "/orbit/-/packages/npm/%40orbit/ranker");
    // Mentions aren't evidence: nothing lands in the explicit groups.
    for (const group of ["Commits", "CI runs", "Packages"])
      expect(document.querySelector(`[data-linked-work="${group}"]`)).toBeNull();
    // Phone width: the panel fits.
    commit.element().scrollIntoView();
    expect(sidewaysOverflow(), "The issue page scrolls sideways").toBeLessThanOrEqual(0);
    const box = commit.element().getBoundingClientRect();
    expect(box.right).toBeLessThanOrEqual(390);
  } finally {
    await page.viewport(1280, 900);
  }
});

test("linked deployments show the provider version recorded, or that none was", async () => {
  const server = await TestServer.start({ world: true });
  const repo = await server.repo("orbit", "engine");
  const tip = commitId();
  await server.push("orbit/engine", "main", tip);
  await server.call("POST", "/api/tracker/orbit/mutate", {
    ...(await server.trackerContract("orbit")),
    operationId: crypto.randomUUID(),
    mutations: [
      { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng", memberIds: [] } },
      { kind: "issue.create", id: "rank", data: { teamId: "team", title: "Rank search results" } },
    ],
  });
  const [person] = await server.sql<{ id: string }>(
    "SELECT id FROM accounts WHERE kind = 'user' LIMIT 1",
  );
  // An agent's step for ENG-1 makes the commit evidence; two records deploy it.
  await server.sql(
    `INSERT INTO step_contexts (repo_id, change_id, commit_oid, author_id, accountable_id, issue_key, summary, committed_at)
     VALUES (?, 'chg', ?, ?, ?, 'ENG-1', 'Rank by freshness', '2026-10-03T09:00:00.000Z')`,
    repo.id,
    tip,
    person!.id,
    person!.id,
  );
  await server.sql(
    `INSERT INTO deployments (repo_id, environment, commit_oid, url, status, created_at,
       provider, provider_service, provider_version_id, provider_deployment_id, percentage)
     VALUES (?, 'production', ?, 'https://engine.example.dev', 'active', '2026-10-03T10:00:00.000Z',
       'cloudflare', 'engine', '4f1c2d3e-0000-4000-8000-000000000002', 'dep-2', 10)`,
    repo.id,
    tip,
  );
  await server.sql(
    `INSERT INTO deployments (repo_id, environment, commit_oid, url, status, created_at)
     VALUES (?, 'staging', ?, 'https://staging.example.dev', 'active', '2026-10-03T11:00:00.000Z')`,
    repo.id,
    tip,
  );
  renderApp("/tracker/orbit/issues/ENG-1");
  const panel = page.getByRole("region", { name: "Linked work" });
  const production = panel.getByRole("link", { name: /^production/ });
  await expect.element(production, { timeout: 10_000 }).toBeVisible();
  await expect.element(production).toMatchTextContent("engine 4f1c2d3e (10%)");
  const staging = panel.getByRole("link", { name: /^staging/ });
  await expect.element(staging).toMatchTextContent("no provider version recorded");
});
