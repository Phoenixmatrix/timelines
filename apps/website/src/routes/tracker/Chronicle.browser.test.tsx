import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { mutate } from "../../testing/timelines.ts";

const LONG =
  "Rank search results by freshness and click-through so the newest useful answer comes first for everyone";

test("a truncated Chronicle row shows its whole title when hovered anywhere on the row", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "chronicle-team",
      data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
    },
    { kind: "issue.create", id: "chronicle-long", data: { teamId: "chronicle-team", title: LONG } },
  ]);
  renderApp("/tracker/orbit?view=chronicle&q=");
  const title = page.getByText(LONG, { exact: true });
  await expect.element(title).toBeVisible();
  // The label column is narrower than the title: it's truncated.
  const label = title.element() as HTMLElement;
  expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
  const tooltip = () => document.querySelector<HTMLElement>("[data-chronicle-tooltip]");
  expect(tooltip()).toBeNull();
  await title.hover();
  await expect.poll(() => tooltip()?.textContent).toContain(`ENG-1 ${LONG}`);
  // The tooltip wraps rather than truncating the title again.
  const first = tooltip()!.firstElementChild as HTMLElement;
  expect(first.scrollWidth).toBeLessThanOrEqual(first.clientWidth);
  // Leaving the row hides it.
  await page.getByRole("heading", { name: "Issues", level: 1 }).hover();
  await expect.poll(tooltip).toBeNull();
});
