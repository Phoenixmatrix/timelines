import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { mutate } from "../../testing/timelines.ts";

test("a tracker with no teams points to your other trackers before offering a first team", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "orbit-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
    { kind: "issue.create", id: "orbit-issue", data: { teamId: "orbit-team", title: "Real work" } },
  ]);
  renderApp("/tracker/marco");
  await expect
    .element(page.getByRole("heading", { name: "No teams in this tracker yet" }))
    .toBeVisible();
  const others = page.getByRole("list", { name: "Your other trackers" });
  const orbit = others.getByRole("link", { name: "Open Orbit Labs", exact: true });
  await expect.element(orbit).toHaveAttribute("href", "/tracker/orbit");
  // Starting a team here is still offered, after the way out.
  await expect
    .element(page.getByRole("link", { name: "Create a team in this tracker" }))
    .toHaveAttribute("href", "/tracker/marco?manage=true");
  await orbit.click();
  await expect.element(page.getByText("Real work", { exact: true })).toBeVisible();
});

test("the only tracker with no teams still starts with a team", async () => {
  await TestServer.start({ world: true, persona: "sam" });
  renderApp("/tracker/sam");
  await expect.element(page.getByRole("heading", { name: "Start with a team" })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Create your first team" }))
    .toHaveAttribute("href", "/tracker/sam?manage=true");
});
