import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { Snapshot } from "../../../shared/tracker.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { mutate } from "../../testing/timelines.ts";

test.each([
  ["not_ready", "Not ready"],
  ["human_only", "Human only"],
] as const)(
  "%s creation stays out of agent-ready work until a person enables pickup",
  async (pickup, label) => {
    const server = await TestServer.start({ world: true });
    await mutate(server, [
      {
        kind: "team.create",
        id: "pickup-team",
        data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
      },
    ]);
    let app = renderApp("/tracker/orbit?captureTeam=pickup-team");
    const title = `Review ${pickup} work`;
    await page.getByRole("textbox", { name: "New issue title", exact: true }).fill(title);
    await page.getByRole("button", { name: "More create options" }).click();
    await page.getByRole("menuitem", { name: "Add details" }).click();
    const dialog = page.getByRole("dialog", { name: "Create an issue" });
    await dialog.getByRole("combobox", { name: "Issue pickup" }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await dialog.getByRole("button", { name: "Create and edit", exact: true }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    const snapshot = await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
    const issue = snapshot.issues.find((issue) => issue.title === title)!;
    expect(issue).toMatchObject({ pickup, status: "todo" });
    app.unmount();
    app = renderApp("/tracker/orbit?q=is%3Aready");
    await expect
      .element(page.getByRole("textbox", { name: "Filter issues" }))
      .toHaveValue("is:ready");
    await expect.element(page.getByText(title, { exact: true })).not.toBeInTheDocument();
    app.unmount();
    app = renderApp(`/tracker/orbit/issues/${issue.id}`);
    await page.getByRole("button", { name: "Edit issue", exact: true }).click();
    await page.getByRole("combobox", { name: "Issue pickup" }).click();
    await page.getByRole("option", { name: "Anyone", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot")).issues.find(
            (entry) => entry.id === issue.id,
          )?.pickup,
      )
      .toBe("anyone");
    app.unmount();
    renderApp("/tracker/orbit?q=is%3Aready");
    await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  },
);
