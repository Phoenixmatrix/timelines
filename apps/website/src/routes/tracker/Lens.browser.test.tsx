import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { mutate } from "../../testing/timelines.ts";

async function world() {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "lens-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
    { kind: "issue.create", id: "lens-a", data: { teamId: "lens-team", title: "Alpha" } },
    { kind: "issue.create", id: "lens-b", data: { teamId: "lens-team", title: "Beta" } },
    {
      kind: "link.add",
      id: "lens-link",
      data: { fromId: "lens-a", toId: "lens-b", kind: "blocks" },
    },
  ]);
  return server;
}

const inspector = (key: string) => page.getByRole("complementary", { name: `Issue ${key}` });
const lens = (key: string) => page.getByRole("region", { name: `Relationships of ${key}` });

test("on a wide screen the graph shows the selected issue's details as the list does", async () => {
  await world();
  renderApp("/tracker/orbit/issues/lens-a?view=list");
  await expect.element(inspector("ENG-1")).toBeVisible();
  await page.getByRole("radio", { name: "Graph", exact: true }).click();
  await expect.element(lens("ENG-1")).toBeVisible();
  await expect.element(inspector("ENG-1")).toBeVisible();
  // Walking the lens keeps the details beside it.
  await lens("ENG-1").getByRole("link", { name: /Beta/ }).click();
  await expect.element(lens("ENG-2")).toBeVisible();
  await expect.element(inspector("ENG-2")).toBeVisible();
  // Closed, they stay closed while walking, until Details.
  await page.getByRole("link", { name: "Close the issue" }).click();
  await expect.element(inspector("ENG-2")).not.toBeInTheDocument();
  await lens("ENG-2").getByRole("link", { name: /Alpha/ }).click();
  await expect.element(lens("ENG-1")).toBeVisible();
  await expect.element(inspector("ENG-1")).not.toBeInTheDocument();
  await lens("ENG-1").getByRole("button", { name: "Details", exact: true }).click();
  await expect.element(inspector("ENG-1")).toBeVisible();
  await expect.element(lens("ENG-1")).toBeVisible();
});

test("on a phone the graph keeps the lens and opens details on request", async () => {
  await world();
  await page.viewport(390, 844);
  try {
    renderApp("/tracker/orbit/issues/lens-a?view=graph");
    await expect.element(lens("ENG-1")).toBeVisible();
    await expect.element(inspector("ENG-1")).not.toBeInTheDocument();
    await lens("ENG-1").getByRole("button", { name: "Details", exact: true }).click();
    await expect.element(inspector("ENG-1")).toBeVisible();
    await page.getByRole("link", { name: "Close the issue" }).click();
    await expect.element(lens("ENG-1")).toBeVisible();
    await expect.element(inspector("ENG-1")).not.toBeInTheDocument();
  } finally {
    await page.viewport(1280, 900);
  }
});
