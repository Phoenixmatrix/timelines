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

test("quick capture applies catalog tags and the selected issue type, not title prefixes", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "capture-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
    {
      kind: "issue.create",
      id: "seed-tag",
      data: { teamId: "capture-team", title: "Known tag", labels: ["Frontend"] },
    },
  ]);
  renderApp("/tracker/orbit?captureTeam=capture-team");
  await page.getByRole("combobox", { name: "Type for the new issue" }).click();
  await page.getByRole("option", { name: "Bug", exact: true }).click();
  const title = page.getByRole("textbox", { name: "New issue title", exact: true });
  await title.fill("(frontend) (FRONTEND) Fix save (on mobile)");
  await press("Enter");
  await expect.element(title).toHaveValue("");
  const snapshot = await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
  expect(snapshot.issues.find((issue) => issue.title === "Fix save (on mobile)")).toMatchObject({
    type: "bug",
    labels: ["Frontend"],
    teamId: "capture-team",
  });
  expect(snapshot.labels).toEqual(["Frontend"]);
});

test("unknown capture tags require definition and survive expansion into a research issue", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "capture-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
  ]);
  renderApp("/tracker/orbit?captureTeam=capture-team");
  await page.getByRole("combobox", { name: "Type for the new issue" }).click();
  await page.getByRole("option", { name: "Research / investigation", exact: true }).click();
  const title = page.getByRole("textbox", { name: "New issue title", exact: true });
  await title.fill("(latency) Investigate slow startup");
  await press("Enter");
  await expect
    .element(page.getByText("Define the new tags below before creating.", { exact: true }))
    .toBeVisible();
  expect((await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot")).issues).toEqual([]);
  await page.getByRole("button", { name: "Define tag “latency”", exact: true }).click();
  // Definitions remain a draft until the issue itself succeeds.
  expect((await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot")).labels).toEqual([]);
  await page.getByRole("button", { name: "More create options" }).click();
  await page.getByRole("menuitem", { name: "Add details" }).click();
  const dialog = page.getByRole("dialog", { name: "Create an issue" });
  await expect
    .element(dialog.getByRole("textbox", { name: "Title", exact: true }))
    .toHaveValue("Investigate slow startup");
  await expect.element(dialog.getByRole("button", { name: "Remove tag latency" })).toBeVisible();
  const tags = dialog.getByRole("combobox", { name: "Tags", exact: true });
  await tags.fill("profiling");
  await press("ArrowDown");
  await press("Enter");
  await expect.element(tags).toHaveValue("");
  await dialog.getByRole("button", { name: "Create and edit", exact: true }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  const snapshot = await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
  expect(snapshot.issues).toEqual([
    expect.objectContaining({
      title: "Investigate slow startup",
      type: "research",
      labels: ["latency", "profiling"],
    }),
  ]);
  expect(snapshot.labels).toEqual(["latency", "profiling"]);
});

test("editor-defined tags persist, survive final removal, and can be reused with catalog casing", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "capture-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
    {
      kind: "issue.create",
      id: "tag-edit",
      data: { teamId: "capture-team", title: "Tag editing" },
    },
  ]);
  const app = renderApp("/tracker/orbit/issues/tag-edit");
  await page.getByRole("button", { name: "Edit issue", exact: true }).click();
  const tags = page.getByRole("combobox", { name: "Tags", exact: true });
  await tags.fill("Performance");
  await focusOn(tags);
  await press("ArrowDown");
  await press("Enter");
  await expect
    .poll(
      async () =>
        (await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot")).issues[0]?.labels,
    )
    .toEqual(["Performance"]);
  await page.getByRole("button", { name: "Remove tag Performance", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot")).issues[0]?.labels,
    )
    .toEqual([]);
  app.unmount();
  renderApp("/tracker/orbit/issues/tag-edit");
  await page.getByRole("button", { name: "Edit issue", exact: true }).click();
  await tags.fill("performance");
  await page.getByRole("option", { name: "Performance", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot")).issues[0]?.labels,
    )
    .toEqual(["Performance"]);
  expect((await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot")).labels).toEqual([
    "Performance",
  ]);
});
