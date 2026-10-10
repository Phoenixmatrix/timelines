import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { IssueHistory } from "../../../shared/tracker.ts";
import { sidewaysOverflow } from "../../testing/atlas.ts";
import { focusOn, press } from "../../testing/focus.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { mutate } from "../../testing/timelines.ts";

async function world(description = "Keep this unchanged description out of field-only updates.") {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "audit-team",
      data: { key: "AUD", name: "Audit", memberIds: ["acc_marco"] },
    },
    {
      kind: "issue.create",
      id: "audit-issue",
      data: {
        teamId: "audit-team",
        title: "Review the rollout",
        description,
        labels: ["backend", "ux"],
      },
    },
  ]);
  return server;
}
const history = () => page.getByRole("list", { name: "Issue audit events" });
const summary = (index: number) =>
  page.elementLocator(
    history().getByRole("listitem").nth(index).element().querySelector("summary")!,
  );
async function openHistory() {
  renderApp("/tracker/orbit/issues/audit-issue");
  await page.getByText("Audit history", { exact: true }).click();
  await expect.element(history().getByRole("listitem").first()).toBeVisible();
}

test("field-only edits show deltas, with complete provenance behind keyboard disclosure", async () => {
  const server = await world();
  await mutate(server, [
    {
      kind: "issue.update",
      id: "audit-issue",
      expectedVersion: 1,
      data: { status: "in_progress" },
    },
    {
      kind: "issue.update",
      id: "audit-issue",
      expectedVersion: 2,
      data: { priority: 1, assigneeId: "acc_marco", labels: ["backend", "frontend"] },
    },
  ]);
  const recorded = await server.call<IssueHistory>(
    "GET",
    "/api/tracker/orbit/issues/audit-issue/history",
  );
  await openHistory();
  const fields = history().getByRole("listitem").nth(0);
  await expect.element(fields).toMatchTextContent("P2");
  await expect.element(fields).toMatchTextContent("P1");
  await expect.element(fields).toMatchTextContent("Assignee: None");
  await expect.element(fields).toMatchTextContent("Marco Bellini");
  await expect.element(fields).toMatchTextContent("ux");
  await expect.element(fields).toMatchTextContent("frontend");
  expect(summary(0).element().textContent).not.toContain("backend");
  expect(summary(0).element().getBoundingClientRect().height).toBeLessThan(160);
  const status = history().getByRole("listitem").nth(1);
  await expect.element(status).toMatchTextContent("Status: To do");
  await expect.element(status).toMatchTextContent("In progress");
  expect(status.element().textContent).not.toContain("Description");
  expect(status.element().textContent).not.toContain("Operation:");
  expect(status.element().textContent).not.toContain("Priority");

  await focusOn(summary(1));
  await press("Enter");
  await expect.element(status).toMatchTextContent(recorded.events[1]!.operationId);
  await status.getByText("Full event details", { exact: true }).click();
  const raw = status.getByLabelText(`Full audit event ${recorded.events[1]!.cursor}`);
  await expect.element(raw).toBeVisible();
  expect(JSON.parse(raw.element().textContent!)).toMatchObject({
    before: {
      status: "todo",
      description: "Keep this unchanged description out of field-only updates.",
    },
    entity: { status: "in_progress" },
    actor: { name: "Marco Bellini", kind: "person" },
  });
  await focusOn(summary(1));
  await press("Enter");
  await expect.element(raw).not.toBeInTheDocument();
  await expect.element(status).toMatchTextContent("Status: To do");
});

test("distant description edits omit unchanged prose on phones but disclose both complete versions", async () => {
  const unchanged = Array.from(
    { length: 30 },
    (_, i) => `Unchanged requirement ${i}: preserve the original audit data.\n`,
  ).join("");
  const before = `${unchanged}The rollout is draft.\n${unchanged}Use the old endpoint.`;
  const after = before
    .replace("rollout is draft", "rollout is ready")
    .replace("old endpoint", "new endpoint");
  const server = await world(before);
  await mutate(server, [
    { kind: "issue.update", id: "audit-issue", expectedVersion: 1, data: { description: after } },
  ]);
  await page.viewport(390, 844);
  try {
    await openHistory();
    const row = history().getByRole("listitem").first();
    for (const changed of ["draft", "ready", "old", "new"])
      expect(summary(0).element().textContent).toContain(changed);
    expect(summary(0).element().textContent).not.toContain("Unchanged requirement");
    expect(summary(0).element().getBoundingClientRect().height).toBeLessThan(180);
    expect(sidewaysOverflow()).toBeLessThanOrEqual(1);
    await summary(0).click();
    await expect.poll(() => row.element().querySelector("dl")?.textContent).toContain(before);
    expect(row.element().querySelector("dl")!.textContent).toContain(after);
    expect(sidewaysOverflow()).toBeLessThanOrEqual(1);
    await summary(0).click();
    await expect.poll(() => row.element().querySelector("dl")).toBeNull();
  } finally {
    await page.viewport(1280, 900);
  }
});

test("missing prior values are not invented as deltas and large rewrites remain bounded", async () => {
  const server = await world();
  const rewritten = `Replacement specification. ${"Keep every historical detail. ".repeat(900)}End of the complete replacement.`;
  await mutate(server, [
    {
      kind: "issue.update",
      id: "audit-issue",
      expectedVersion: 1,
      data: { description: rewritten },
    },
    {
      kind: "issue.update",
      id: "audit-issue",
      expectedVersion: 2,
      data: { status: "in_progress" },
    },
  ]);
  const recorded = await server.call<IssueHistory>(
    "GET",
    "/api/tracker/orbit/issues/audit-issue/history",
  );
  // A retained legacy event may have no earlier snapshot. Preserve that gap.
  recorded.events[0] = { ...recorded.events[0]!, before: null };
  server.on("GET", "/api/tracker/orbit/issues/audit-issue/history", recorded);
  await openHistory();
  const legacy = history().getByRole("listitem").nth(0);
  await expect.element(legacy).toMatchTextContent("Earlier values were not recorded");
  expect(summary(0).element().textContent).not.toContain("Status:");
  expect(summary(0).element().textContent).not.toContain("Description");
  const rewrite = history().getByRole("listitem").nth(1);
  expect(summary(1).element().textContent).toContain("Replacement specification.");
  expect(summary(1).element().textContent).not.toContain("End of the complete replacement.");
  expect(summary(1).element().getBoundingClientRect().height).toBeLessThan(180);
  await summary(1).click();
  await expect.poll(() => rewrite.element().querySelector("dl")?.textContent).toContain(rewritten);
  await summary(1).click();
  await summary(0).click();
  await expect.element(legacy.getByText("Not recorded", { exact: true }).first()).toBeVisible();
  await expect.poll(() => legacy.element().querySelector("dl")?.textContent).toContain(rewritten);
});
