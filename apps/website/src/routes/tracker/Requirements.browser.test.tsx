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
      { kind: "issue.create", id: "board", data: { teamId: "team", title: "Redesign the board" } },
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
  await expect.element(section).toMatchTextContent(/Any agent can claim it/);
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
