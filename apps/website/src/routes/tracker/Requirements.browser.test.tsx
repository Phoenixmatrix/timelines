// Issue requirements (CORE-32) in a real browser against the in-memory
// server: edit them in the inspector as chips, see which agents are eligible
// and why the others aren't, find them with query terms, and see each agent's
// eligible work on Settings > Agents.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";

const GiB = 2 ** 30;

test("requirements: edit them in the inspector and see eligibility per agent", async () => {
  const server = await TestServer.start({ world: true });
  await server.call("POST", "/api/tracker/orbit/mutate", {
    operationId: crypto.randomUUID(),
    mutations: [
      { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } },
      {
        kind: "issue.create",
        id: "board",
        data: { teamId: "team", title: "Redesign the board", labels: ["ux"] },
      },
      { kind: "issue.create", id: "plain", data: { teamId: "team", title: "Fix the typo" } },
    ],
  });
  await server.call("POST", "/api/agents", {
    name: "designer",
    capabilities: {
      version: 1,
      harness: "claude-code",
      model: "claude-opus-4-5",
      environment: {
        os: "linux",
        arch: "x86_64",
        runtime: "host",
        cpuCount: 8,
        memoryBytes: 32 * GiB,
      },
      tags: ["ux"],
      skills: [],
    },
  });
  await server.call("POST", "/api/agents", { name: "crawler" });

  const app = renderApp("/tracker/orbit/issues/board");
  const section = page.getByRole("region", { name: "Agent requirements" });
  const input = page.getByRole("textbox", { name: "Add requirements" });

  // A term that isn't one says what is.
  await userEvent.fill(input, "gpu");
  await userEvent.click(section.getByRole("button", { name: "Add" }));
  await expect.element(section).toMatchTextContent(/Unknown requirement "gpu"/);

  await userEvent.fill(input, "tag:UX memory>=16GiB");
  await userEvent.click(section.getByRole("button", { name: "Add" }));
  const chips = page.getByRole("list", { name: "Requirements" });
  await expect.element(chips).toMatchTextContent("tag:uxmemory>=16GiB");
  await expect.element(input).toHaveValue("");

  const eligibility = page.getByRole("list", { name: "Agent eligibility" });
  const designer = eligibility.getByRole("listitem").filter({ hasText: "designer" });
  const crawler = eligibility.getByRole("listitem").filter({ hasText: "crawler" });
  await expect.element(designer).toMatchTextContent(/Eligible/);
  await expect.element(designer).toHaveAttribute("data-eligible", "true");
  await expect.element(crawler).toMatchTextContent(/run `gm agent setup`/);
  await expect.element(crawler).toHaveAttribute("data-eligible", "false");

  // Raising the bar past what designer reports: it says why.
  await userEvent.click(page.getByRole("button", { name: "Remove memory>=16GiB" }));
  await expect.element(chips).toMatchTextContent("tag:ux");
  await userEvent.fill(input, "memory>=64GiB");
  await userEvent.click(section.getByRole("button", { name: "Add" }));
  await expect
    .element(designer)
    .toMatchTextContent(/needs at least 64GiB of memory \(it reports 32GiB\)/);
  await expect.element(designer).toHaveAttribute("data-eligible", "false");

  // Recorded in history like any field.
  const history = await server.call<{ events: { entity: { requires?: unknown } }[] }>(
    "GET",
    "/api/tracker/orbit/issues/board/history?limit=1",
  );
  expect(history.events[0]!.entity.requires).toEqual({ tags: ["ux"], minMemory: 64 * GiB });

  // The list marks it, and the query terms find it.
  await app.navigate(`/tracker/orbit?q=${encodeURIComponent("is:open requires:ux")}`);
  const rows = page.getByRole("table", { name: "Issues" });
  await expect.element(rows.getByRole("row", { name: /ENG-1/ })).toBeVisible();
  await expect.element(rows.getByLabelText("Requires tag:ux memory>=64GiB")).toBeVisible();
  await expect.poll(() => rows.getByRole("row", { name: /ENG-2/ }).elements()).toHaveLength(0);
  await app.navigate(`/tracker/orbit?q=${encodeURIComponent("is:open eligible:designer")}`);
  await expect.element(rows.getByRole("row", { name: /ENG-2/ })).toBeVisible();
  await expect.poll(() => rows.getByRole("row", { name: /ENG-1/ }).elements()).toHaveLength(0);

  // Settings > Agents: what each agent can take, and why not the rest.
  await app.navigate("/settings/agents");
  const work = page.getByRole("list", { name: "designer's tracker work" });
  await expect.element(work).toMatchTextContent(/eligible for 1 of 2 open issues/);
  await expect.element(work).toMatchTextContent(/ENG-1 needs at least 64GiB of memory/);
  await expect
    .element(work.getByRole("link"))
    .toHaveAttribute("href", `/tracker/orbit?q=${encodeURIComponent("is:open eligible:designer")}`);
});

test("tags: one catalog for issues, agents and requirements, with label: as an alias (CORE-271)", async () => {
  const server = await TestServer.start({ world: true });
  await server.call("POST", "/api/tracker/orbit/mutate", {
    operationId: crypto.randomUUID(),
    mutations: [
      { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } },
      // `tags` is the name people see; `labels`, the stored field, still works.
      {
        kind: "issue.create",
        id: "board",
        data: { teamId: "team", title: "Redesign the board", tags: ["ux", "frontend"] },
      },
      {
        kind: "issue.create",
        id: "rollup",
        data: { teamId: "team", title: "Roll up", labels: ["data"] },
      },
    ],
  });
  await server.call("POST", "/api/agents", {
    name: "designer",
    capabilities: {
      version: 1,
      harness: "claude-code",
      model: "claude-opus-4-5",
      environment: {
        os: "linux",
        arch: "x86_64",
        runtime: "host",
        cpuCount: 8,
        memoryBytes: 8 * GiB,
      },
      tags: ["ux", "desgin"],
      skills: [],
    },
  });
  const catalog = await server.call<{ tags: { name: string; open: number }[] }>(
    "GET",
    "/api/tracker/orbit/tags",
  );
  expect(catalog.tags.map((t) => [t.name, t.open])).toEqual([
    ["data", 1],
    ["frontend", 1],
    ["ux", 1],
  ]);

  const app = renderApp("/tracker/orbit/issues/board");
  // The inspector shows the issue's tags as issue-tag chips.
  await expect.element(page.getByLabelText("Tag frontend")).toBeVisible();
  const section = page.getByRole("region", { name: "Agent requirements" });
  const input = page.getByRole("textbox", { name: "Add requirements" });
  const suggestions = page.getByRole("group", { name: "Tags from this tracker's catalog" });
  await expect.element(suggestions).toMatchTextContent(/tag:data.*tag:frontend.*tag:ux/);
  // Typing narrows the catalog, and choosing one completes the term.
  await userEvent.fill(input, "model:claude-* tag:fr");
  await expect.element(suggestions).toMatchTextContent(/^From the tag catalogtag:frontend$/);
  await expect.element(section).not.toMatchTextContent(/isn't in this tracker's tag catalog/);
  await userEvent.click(suggestions.getByRole("button", { name: "tag:frontend" }));
  await expect.element(input).toHaveValue("model:claude-* tag:frontend ");
  // A name the catalog lacks warns, and can still be added.
  await userEvent.fill(input, "tag:desgin");
  await expect
    .element(section)
    .toMatchTextContent(/tag:desgin isn't in this tracker's tag catalog\. You can still add it/);
  await userEvent.click(section.getByRole("button", { name: "Add" }));
  const chips = page.getByRole("list", { name: "Requirements" });
  await expect.element(chips).toMatchTextContent(/tag:desgin, not in this tracker's tag catalog/);

  // Search: tag: and its old spelling label: find the same issues.
  for (const spelling of ["tag", "label"]) {
    await app.navigate(`/tracker/orbit?q=${encodeURIComponent(`is:open ${spelling}:ux`)}`);
    const rows = page.getByRole("table", { name: "Issues" });
    await expect.element(rows.getByRole("row", { name: /ENG-1/ })).toBeVisible();
    await expect.poll(() => rows.getByRole("row", { name: /ENG-2/ }).elements()).toHaveLength(0);
    await expect
      .element(page.getByRole("region", { name: "Tag" }).getByRole("button", { name: /^ux/ }))
      .toHaveAttribute("aria-pressed", "true");
  }

  // Settings > Agents: agent tags link to the tracker's issues with that tag; a
  // name no catalog has is flagged, not refused.
  await app.navigate("/settings/agents");
  const tags = page.getByRole("list", { name: "Agent tags" });
  await expect
    .element(tags.getByRole("link", { name: /Agent tag ux/ }))
    .toHaveAttribute("href", `/tracker/orbit?q=${encodeURIComponent("is:open tag:ux")}`);
  await expect
    .element(tags.getByLabelText("Agent tag desgin, not in any tracker's tag catalog"))
    .toBeVisible();
  await expect
    .element(page.getByText(/desgin isn't in any of your trackers' tag catalogs/))
    .toBeVisible();
});
