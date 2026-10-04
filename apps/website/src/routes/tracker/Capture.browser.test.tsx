import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { Snapshot } from "../../../shared/tracker.ts";
import { focusOn, press } from "../../testing/focus.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { mutate } from "../../testing/timelines.ts";

test("capture menu preserves the draft and scope without submitting; Enter still creates", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "capture-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
    {
      kind: "workspace.create",
      id: "capture-workspace",
      data: { slug: "mobile", name: "Mobile" },
    },
  ]);
  renderApp("/tracker/orbit?captureTeam=capture-team&q=ws%3Amobile");
  const title = page.getByRole("textbox", { name: "New issue title", exact: true });
  await title.fill("Keep the capture draft");
  const mark = server.requests.length;
  await focusOn(page.getByRole("button", { name: "More create options" }));
  await press("ArrowDown");
  await expect.element(page.getByRole("menuitem", { name: "Add details" })).toHaveFocus();
  await press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create an issue" });
  await expect
    .element(dialog.getByRole("textbox", { name: "Title", exact: true }))
    .toHaveValue("Keep the capture draft");
  await expect.element(dialog.getByRole("checkbox", { name: "Mobile" })).toBeChecked();
  expect(
    server
      .since(mark)
      .filter((request) => request.method === "POST" && request.url.pathname.endsWith("/mutate")),
  ).toHaveLength(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(title).toHaveValue("Keep the capture draft");
  await focusOn(title);
  await press("Enter");
  await expect.element(title).toHaveValue("");
  const snapshot = await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
  expect(snapshot.issues.filter((issue) => issue.title === "Keep the capture draft")).toEqual([
    expect.objectContaining({
      title: "Keep the capture draft",
      teamId: "capture-team",
      workspaceIds: ["capture-workspace"],
    }),
  ]);
});
