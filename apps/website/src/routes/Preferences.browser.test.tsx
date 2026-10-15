// Approve when green (CORE-378) in a real browser, against the Worker's routes
// in memory: a person turns it on for themselves in the selected tracker on
// Preferences, and their agent can't. Who else can't change it, and what it
// approves, are worker/tracker/checkpoints.test.ts's and
// worker/timelines/api.test.ts's; the approvals it answers, marked as
// automatic, Checkpoint.browser.test.tsx's.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { Snapshot } from "../../shared/tracker.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";
import { timelineWorld } from "../testing/timelines.ts";

const toggle = () =>
  page.getByRole("checkbox", {
    name: /Approve checkpoints routed to me in .* once their CI is green/,
  });

test("a person reads what it does and turns it on for one tracker", async () => {
  const server = await TestServer.start({ world: true });
  const app = renderApp("/settings/preferences?tracker=orbit");
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
    .element(
      page
        .getByRole("region", { name: "Approve when green" })
        .getByText("Agents can’t do that; sign in as their person."),
    )
    .toBeVisible();
  // Nor can it move where its person's app and gm open (CORE-413).
  await expect.element(page.getByRole("button", { name: "Save default" })).toBeDisabled();
});
