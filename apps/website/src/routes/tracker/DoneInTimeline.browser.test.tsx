// "Done in a timeline" on an issue (CORE-74) in a real browser, against the
// tracker in memory: on main the issue says where it was done, its status
// picker is locked with the reason beside it, and both links lead to the
// timeline's view of it, where the status can change again.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { commitId } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";

test("done in a timeline: the callout, the locked picker and the way to reopen it", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  await server.push("orbit/engine", "main", commitId());
  const mutate = async (mutations: unknown[], timeline?: string) =>
    server.call("POST", "/api/tracker/orbit/mutate", {
      ...(await server.trackerContract("orbit")),
      operationId: crypto.randomUUID(),
      mutations,
      ...(timeline ? { timeline } : {}),
    });
  await mutate([
    {
      kind: "team.create",
      id: "team",
      data: { key: "ENG", name: "Eng", memberIds: ["acc_marco"] },
    },
    { kind: "issue.create", id: "docs", data: { teamId: "team", title: "Index the docs" } },
  ]);
  const slug = "search";
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug,
    name: "Search",
    repos: ["orbit/engine"],
  });
  await mutate(
    [{ kind: "issue.update", id: "docs", expectedVersion: 1, data: { status: "done" } }],
    slug,
  );

  const app = renderApp("/tracker/orbit/issues/docs");
  await expect.element(page.getByText("Index the docs", { exact: true }).first()).toBeVisible();
  const callout = page.getByText(/Done in timeline/).first();
  await expect
    .element(callout)
    .toMatchTextContent("done on main when it lands. Its status is locked here.");
  const edit = page.getByRole("button", { name: "Edit issue" });
  const status = page.getByRole("combobox", { name: "Issue status" });
  await userEvent.click(edit);
  await expect.element(status).toBeDisabled();
  await expect
    .element(page.getByText(/Locked while it's done in timeline/))
    .toMatchTextContent(`Locked while it's done in timeline ${slug}: it lands with the timeline.`);
  await expect
    .element(page.getByRole("link", { name: "Open in the timeline" }))
    .toHaveAttribute("href", `/tracker/orbit/issues/ENG-1?tl=${slug}`);

  // Reopen it there: the timeline's view, where its status isn't locked.
  await userEvent.click(page.getByRole("link", { name: "Reopen it there" }));
  await app.waitForUrl((url) => url.searchParams.get("tl") === slug);
  await expect.element(page.getByText(/Locked while/)).not.toBeInTheDocument();
  if (edit.query()) await userEvent.click(edit);
  await expect.element(status).toBeEnabled();
  expect(page.getByRole("link", { name: "Open in the timeline" }).elements()).toHaveLength(0);
});
