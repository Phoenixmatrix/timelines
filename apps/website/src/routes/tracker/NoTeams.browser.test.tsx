import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { Snapshot } from "../../../shared/tracker.ts";
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
  const others = page.getByRole("list", { name: "Your other trackers" });
  const orbit = others.getByRole("link", { name: "Open General", exact: true });
  await expect.element(orbit).toHaveAttribute("href", "/tracker/orbit");
  // Starting a team here is still offered, after the way out.
  await expect
    .element(page.getByRole("link", { name: "Create a team in this tracker" }))
    .toHaveAttribute("href", "/tracker/marco/teams");
  await orbit.click();
  await expect.element(page.getByText("Real work", { exact: true })).toBeVisible();
});

test("the only tracker with no teams still starts with a team", async () => {
  await TestServer.start({ world: true, persona: "priya" });
  const app = renderApp("/tracker/priya");
  const create = page.getByRole("link", { name: "Create your first team" });
  await expect.element(create).toHaveAttribute("href", "/tracker/priya/teams");
  await create.click();
  await app.waitForUrl((url) => url.pathname === "/tracker/priya/teams");
  await expect.element(page.getByRole("textbox", { name: "Team name", exact: true })).toBeVisible();
});

test("canonical Team and Project administration uses the Space grant and immutable identifiers", async () => {
  const server = await TestServer.start({ world: true, persona: "sam" });
  const initial = await server.call<Snapshot>("GET", "/api/tracker/sam/snapshot");
  expect(initial.canAdmin).toBe(true);
  const teams = renderApp("/tracker/sam/teams");
  await expect.element(page.getByRole("heading", { name: "Teams", level: 1 })).toBeVisible();
  await page.getByRole("textbox", { name: "Team name", exact: true }).fill("Delivery");
  await page.getByRole("textbox", { name: "Issue prefix", exact: true }).fill("DEL");
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await expect
    .poll(async () =>
      (await server.call<Snapshot>("GET", "/api/tracker/sam/snapshot")).teams.map(
        (team) => team.key,
      ),
    )
    .toContain("DEL");
  teams.unmount();

  renderApp("/tracker/sam/projects?source=review-source#project-context");
  await expect.element(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await page.getByRole("textbox", { name: "Project name", exact: true }).fill("Shipping");
  await page.getByRole("textbox", { name: "Project slug", exact: true }).fill("shipping");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect.element(page.getByText("Shipping", { exact: true })).toBeVisible();
  await page.getByText("Shipping", { exact: true }).click();
  await expect.element(page.getByText("shipping", { exact: true })).toBeVisible();
  const names = page.getByRole("textbox", { name: "Project name", exact: true });
  await names.last().fill("Shipping together");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await server.call<Snapshot>("GET", "/api/tracker/sam/snapshot")).projects[0]?.name,
    )
    .toBe("Shipping together");
  await expect
    .element(page.getByRole("link", { name: "View project issues" }))
    .toHaveAttribute(
      "href",
      "/tracker/sam?source=review-source&q=project%3Ashipping#project-context",
    );
  await page.getByRole("button", { name: "Archive project", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await server.call<Snapshot>("GET", "/api/tracker/sam/snapshot")).projects[0]?.archived,
    )
    .toBe(true);
  await page.getByRole("button", { name: "Restore project", exact: true }).click();
  await expect
    .poll(async () => (await server.call<Snapshot>("GET", "/api/tracker/sam/snapshot")).projects[0])
    .toMatchObject({
      slug: "shipping",
      name: "Shipping together",
      archived: false,
    });
});
