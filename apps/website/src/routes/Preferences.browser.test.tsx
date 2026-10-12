// Approve when green (CORE-378) in a real browser, against the Worker's routes
// in memory: a person turns it on for themselves in the selected tracker on
// Preferences; their agent and other people can't change it; Needs you marks
// the approvals it will answer; and turning it on approves a green checkpoint
// waiting on them, which the timeline and the issue then show as automatic.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { Snapshot } from "../../shared/tracker.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";
import { askApproval, checkpoint, ciRun, timelineWorld } from "../testing/timelines.ts";

const toggle = () =>
  page.getByRole("checkbox", {
    name: /Approve checkpoints routed to me in .* once their CI is green/,
  });

test("a person turns it on for one tracker; it answers their green approvals, marked as automatic", async () => {
  const server = await TestServer.start({ world: true });
  const timeline = await timelineWorld(server);
  const made = await checkpoint(server, timeline, "Ready to land");
  await askApproval(server, timeline, made.checkpoint.id);

  // Pending CI: Needs you shows only the ordinary request while it's off.
  const repo = timeline.repos[0]!;
  const run = await ciRun(server, {
    repo,
    number: 1,
    commit: repo.tip,
    ref: "work",
    sourceId: repo.sourceId,
    status: "running",
  });
  let app = renderApp("/settings/preferences?tracker=orbit");
  await expect.element(page.getByRole("heading", { name: "Approve when green" })).toBeVisible();
  await expect.element(toggle()).not.toBeChecked();
  const help = page.getByText(/When you or one of your agents asks you to approve a checkpoint/);
  await expect.element(help).toBeVisible();
  for (const said of [
    /approved in your name once every repository’s CI run for that checkpoint has succeeded/,
    /Requests from anyone else stay yours to answer/,
    /never approves a checkpoint that changes the pipeline definition \(\.gitmatrix\/ci\.yml\)/,
    /approving trusts that code/,
    /you can turn it off at any time/,
  ])
    await expect.element(help).toMatchTextContent(said);

  const mark = server.requests.length;
  await userEvent.click(toggle());
  await expect.element(toggle()).toBeChecked();
  await expect.element(page.getByText("Approve when green is on")).toBeVisible();
  const sent = server
    .since(mark)
    .filter((r) => r.method === "POST" && r.url.pathname === "/api/tracker/orbit/mutate");
  expect(sent).toHaveLength(1);
  const snapshot = await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
  expect(snapshot.approveWhenGreen).toEqual(["acc_marco"]);
  app.unmount();

  // Nobody else changes it: not Marco's agent, not another person.
  const { agent } = await server.call<{ agent: { id: string } }>("POST", "/api/agents", {
    name: "lander",
  });
  const off = {
    operationId: crypto.randomUUID(),
    mutations: [{ kind: "automation.approveWhenGreen", id: "acc_marco", data: { enabled: false } }],
  };
  await expect(
    server.callAsAgent(agent.id, "POST", "/api/tracker/orbit/mutate", off),
  ).rejects.toThrow(/403.*Agents can't do that/);
  await expect(server.call("POST", "/api/tracker/orbit/mutate", off, "priya")).rejects.toThrow(
    /403/,
  );

  // CI still running: the request waits, marked as one the setting will answer.
  app = renderApp("/needs-you");
  const card = page.getByRole("article", { name: "Approval for you" });
  await expect.element(card).toBeVisible();
  await expect.element(card.getByText("Approves when green", { exact: true })).toBeVisible();
  app.unmount();

  // Green now, and turned on again: approved as Marco, automatically.
  await server.sql("UPDATE ci_runs SET status = 'succeeded' WHERE id = ?", run);
  app = renderApp("/settings/preferences?tracker=orbit");
  await userEvent.click(toggle());
  await expect.element(toggle()).not.toBeChecked();
  await userEvent.click(toggle());
  await expect.element(toggle()).toBeChecked();
  app.unmount();

  app = renderApp("/needs-you");
  await expect.element(page.getByText("Nothing is waiting on you.")).toBeVisible();
  app.unmount();

  app = renderApp(`/tracker/orbit/timelines?tl=${timeline.slug}`);
  await expect
    .element(page.getByText("Approved automatically", { exact: true }))
    .toHaveAttribute("title", "Approved automatically: Marco Bellini’s approve-when-green setting");
  await expect
    .element(
      page
        .getByRole("region", { name: "Timeline graph" })
        .getByRole("listitem")
        .filter({ hasText: /#1 approved/ }),
    )
    .toMatchTextContent(/#1 approved\s*by Marco Bellini’s approve-when-green setting/);
  app.unmount();

  renderApp(`/tracker/orbit/issues/${timeline.issue}`);
  const requests = page.getByRole("region", { name: "Requests to people" });
  await expect
    .element(requests.getByRole("article", { name: "Approval for Marco Bellini" }))
    .toMatchTextContent(
      /approved · Checkpoint #1's CI is green\. · automatically, by Marco Bellini’s approve-when-green setting/,
    );
});

test("signed in with an agent's token, the setting is shown but can't be changed", async () => {
  const server = await TestServer.start({ world: true });
  await timelineWorld(server);
  server.on("GET", "/api/session", async () => {
    const session = await server.call<{ viewer: Record<string, unknown> }>("GET", "/api/session");
    return {
      ...session,
      viewer: { ...session.viewer, agent: { id: "agt_lander", name: "lander" } },
    };
  });
  renderApp("/settings/preferences?tracker=orbit");
  await expect.element(toggle()).toBeDisabled();
  await expect
    .element(page.getByText("Agents can’t do that; sign in as their person."))
    .toBeVisible();
});
