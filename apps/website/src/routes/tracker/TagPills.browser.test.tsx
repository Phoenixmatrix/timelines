// Tag pills under the tracker's query bar (CORE-253) in a real browser: the
// most used tags are one click away, a pressed pill shows each tag the query
// filters on (typed or clicked), and clicking it removes that filter.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { mutate } from "../../testing/timelines.ts";

test("tag pills: add a common tag in one click, see what's filtered, remove it", async () => {
  const server = await TestServer.start({ world: true });
  const issue = (id: string, title: string, tags: string[]) => ({
    kind: "issue.create",
    id,
    data: { teamId: "tgp", title, tags },
  });
  await mutate(server, [
    { kind: "team.create", id: "tgp", data: { key: "TGP", name: "Tag pills" } },
    issue("a", "Align the capture row", ["ux", "frontend"]),
    issue("b", "Tidy the facet column", ["ux"]),
    issue("c", "Index the docs", ["backend"]),
  ]);
  const app = renderApp("/tracker/orbit?q=team%3Atgp+is%3Aopen");

  const pills = page.getByRole("group", { name: "Filter by tag" });
  const rows = () =>
    [...page.getByRole("table", { name: "Issues" }).element().querySelectorAll('a[role="row"]')]
      // The title cell also lists the row's tags ("Tags: ux, …" and its chips).
      .map((row) => {
        const title = row.querySelector('[role="cell"]:nth-child(3)')!.textContent ?? "";
        return title.split("Tags:")[0] ?? "";
      })
      .sort((a, b) => a.localeCompare(b));
  // The most used tags come first, with how many issues each would show.
  await expect
    .element(pills.getByRole("button", { name: "Show issues tagged ux (2)" }))
    .toBeVisible();
  await expect
    .element(pills.getByRole("button", { name: "Show issues tagged backend (1)" }))
    .toHaveAttribute("aria-pressed", "false");

  await userEvent.click(pills.getByRole("button", { name: /^Show issues tagged ux/ }));
  await app.waitForUrl((url) => url.searchParams.get("q") === "team:tgp is:open tag:ux");
  await expect.poll(rows).toEqual(["Align the capture row", "Tidy the facet column"]);
  const on = pills.getByRole("button", { name: "Showing issues tagged ux. Remove this filter" });
  await expect.element(on).toHaveAttribute("aria-pressed", "true");
  // The other common tags stay offered beside the active one.
  await expect
    .element(pills.getByRole("button", { name: /^Show issues tagged backend/ }))
    .toBeVisible();

  await userEvent.click(on);
  await app.waitForUrl((url) => url.searchParams.get("q") === "team:tgp is:open");
  await expect
    .poll(rows)
    .toEqual(["Align the capture row", "Index the docs", "Tidy the facet column"]);

  // A typed exclusion shows as a pressed pill too, and clicking it drops just that term.
  const input = page.getByRole("textbox", { name: "Filter issues" });
  await userEvent.clear(input);
  await userEvent.type(input, "team:tgp is:open -tag:backend{Enter}");
  const hiding = pills.getByRole("button", {
    name: "Hiding issues tagged backend. Remove this filter",
  });
  await expect.element(hiding).toHaveAttribute("aria-pressed", "true");
  await expect.poll(rows).toEqual(["Align the capture row", "Tidy the facet column"]);
  // Straight from typing: the query box still has focus when the pill is pressed.
  await userEvent.click(hiding);
  await expect.poll(() => app.url().searchParams.get("q")).toBe("team:tgp is:open");
});
