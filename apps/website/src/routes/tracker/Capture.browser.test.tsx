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
      kind: "project.create",
      id: "capture-project",
      data: { slug: "mobile", name: "Mobile" },
    },
  ]);
  renderApp("/tracker/orbit?captureTeam=capture-team&q=project%3Amobile");
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
      projectIds: ["capture-project"],
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

test("capture tags wrap below the fields without moving the heading or tracker picker", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "capture-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
  ]);
  renderApp("/tracker/orbit?captureTeam=capture-team");
  const heading = page.getByRole("heading", { name: "Issues", level: 1 });
  const space = page.getByRole("combobox", { name: "Tracker space" });
  const title = page.getByRole("textbox", { name: "New issue title", exact: true });
  await expect.element(title).toBeVisible();
  const centre = (box: DOMRect) => box.top + box.height / 2;
  const before = {
    heading: centre(heading.element().getBoundingClientRect()),
    space: centre(space.element().getBoundingClientRect()),
    title: centre(title.element().getBoundingClientRect()),
  };
  expect(Math.abs(before.heading - before.title)).toBeLessThanOrEqual(1);
  expect(Math.abs(before.space - before.title)).toBeLessThanOrEqual(1);
  await title.fill("(latency) Investigate slow startup");
  await expect
    .element(page.getByRole("button", { name: "Define tag “latency”", exact: true }))
    .toBeVisible();
  expect(centre(heading.element().getBoundingClientRect())).toBeCloseTo(before.heading, 0);
  expect(centre(space.element().getBoundingClientRect())).toBeCloseTo(before.space, 0);
  expect(centre(title.element().getBoundingClientRect())).toBeCloseTo(before.title, 0);
});

test("multi-Project creation and editing retain Team identity and send the exact Space contract", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    { kind: "team.create", id: "multi-team", data: { key: "MUL", name: "Multi project" } },
    { kind: "project.create", id: "mobile", data: { slug: "mobile", name: "Mobile" } },
    { kind: "project.create", id: "shipping", data: { slug: "shipping", name: "Shipping" } },
  ]);
  const scope = await server.trackerContract("orbit");
  const operations: string[] = [];
  server.on("POST", "/api/tracker/orbit/mutate", ({ body }) => {
    expect(body).toMatchObject(scope);
    const request = body as { operationId: string };
    expect(request.operationId).toBeTruthy();
    operations.push(request.operationId);
    return server.call("POST", "/api/tracker/orbit/mutate", body);
  });
  const app = renderApp(
    "/tracker/orbit?captureTeam=multi-team&q=project%3Amobile&source=source-1#evidence-context",
  );
  await page
    .getByRole("textbox", { name: "New issue title", exact: true })
    .fill("Ship on two projects");
  await page.getByRole("button", { name: "More create options" }).click();
  await page.getByRole("menuitem", { name: "Add details" }).click();
  const dialog = page.getByRole("dialog", { name: "Create an issue" });
  await expect.element(dialog.getByRole("checkbox", { name: "Mobile", exact: true })).toBeChecked();
  await dialog.getByRole("checkbox", { name: "Shipping", exact: true }).click();
  await dialog.getByRole("button", { name: "Create and edit" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  let snapshot = await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
  const created = snapshot.issues.find((issue) => issue.title === "Ship on two projects")!;
  expect(created).toMatchObject({ teamId: "multi-team", key: "MUL-1" });
  expect([...created.projectIds].sort()).toEqual(["mobile", "shipping"]);
  await page.getByRole("checkbox", { name: "Shipping", exact: true }).click();
  await expect
    .poll(async () => {
      snapshot = await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
      return snapshot.issues.find((issue) => issue.id === created.id)!.projectIds;
    })
    .toEqual(["mobile"]);
  expect(snapshot.issues.find((issue) => issue.id === created.id)).toMatchObject({
    teamId: "multi-team",
    key: "MUL-1",
  });
  await app.waitForUrl(
    (url) => url.searchParams.get("source") === "source-1" && url.hash === "#evidence-context",
  );
  expect(new Set(operations).size).toBe(operations.length);
});
