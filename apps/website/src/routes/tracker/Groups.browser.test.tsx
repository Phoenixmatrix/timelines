// The list's progress groups (CORE-295) in a real browser: claimed and
// in-progress work leads under one column header, sorting reorders inside
// each group, a group folds away (and j/k skips it), and the list goes flat
// on request or when the filter leaves one group.
// Sorting and query context survive inspector navigation and browser history.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { press } from "../../testing/focus.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { visual } from "../../testing/visual.ts";
import { mutate } from "../../testing/timelines.ts";

test("progress groups: work underway first, sorted inside, foldable, and flat on request", async () => {
  const server = await TestServer.start({ world: true });
  const issue = (id: string, title: string, data: Record<string, unknown> = {}) => ({
    kind: "issue.create",
    id,
    data: { teamId: "grp", title, ...data },
  });
  await mutate(server, [
    {
      kind: "team.create",
      id: "grp",
      data: { key: "GRP", name: "Groups", memberIds: ["acc_marco"] },
    },
    issue("next", "Write the release notes", { priority: 1 }),
    issue("later", "Someday tidy-up", { status: "backlog", priority: 4 }),
    issue("doing", "Fix the login race", { priority: 3 }),
    issue("taken", "Index the docs", { priority: 2 }),
  ]);
  await mutate(server, [
    { kind: "issue.update", id: "doing", expectedVersion: 1, data: { status: "in_progress" } },
    { kind: "issue.claim", id: "taken", data: { agent: "laptop" } },
  ]);
  localStorage.setItem("gitmatrix:tracker-shortcuts", "true");
  const app = renderApp("/tracker/orbit?q=team%3Agrp+is%3Aopen#issue-list");

  const table = page.getByRole("table", { name: "Issues" });
  const titles = async () =>
    [...table.element().querySelectorAll('a[role="row"]')]
      .sort(
        (a, b) =>
          parseFloat((a as HTMLElement).style.top) - parseFloat((b as HTMLElement).style.top),
      )
      .map((row) => row.querySelector('[role="cell"]:nth-child(3)')!.textContent);
  const group = (name: RegExp) => table.getByRole("button", { name });
  await expect.element(group(/^In progress 2/)).toHaveAttribute("aria-expanded", "true");
  await expect.element(group(/^Up next 1/)).toBeVisible();
  await expect.element(group(/^Backlog 1/)).toBeVisible();
  // One column header for every group.
  expect(table.getByRole("button", { name: "Updated" }).elements()).toHaveLength(1);
  await expect
    .poll(titles)
    .toEqual([
      "Index the docs",
      "Fix the login race",
      "Write the release notes",
      "Someday tidy-up",
    ]);
  await visual("Issue list - progress groups");

  // Priority sorts inside each group; claimed work still leads.
  await userEvent.click(table.getByRole("button", { name: "P", exact: true }));
  await app.waitForUrl((url) => url.searchParams.get("sort") === "priority");
  await expect
    .poll(titles)
    .toEqual([
      "Index the docs",
      "Fix the login race",
      "Write the release notes",
      "Someday tidy-up",
    ]);

  // Folding a group hides its rows, keeps its count, and j/k step past it.
  await userEvent.click(group(/^Up next 1/));
  await expect.element(group(/^Up next 1/)).toHaveAttribute("aria-expanded", "false");
  await expect.poll(titles).toEqual(["Index the docs", "Fix the login race", "Someday tidy-up"]);
  // Shortcuts act from the page, not from a control the inspector focused.
  const shortcut = async (key: string) => {
    (document.activeElement as HTMLElement | null)?.blur();
    await press(key);
  };
  const context = () => {
    expect(app.url().searchParams.get("sort")).toBe("priority");
    expect(app.url().searchParams.get("q")).toBe("team:grp is:open");
    expect(app.url().hash).toBe("#issue-list");
  };
  const opened = async (key: string) => {
    await expect.element(page.getByRole("complementary", { name: `Issue ${key}` })).toBeVisible();
    context();
  };
  await shortcut("j");
  await opened("GRP-4");
  await shortcut("j");
  await opened("GRP-3");
  await shortcut("j");
  await opened("GRP-2");
  await shortcut("Escape");
  await app.waitForUrl((url) => !url.pathname.includes("/issues/"));
  context();

  // Flat on request: no group rows, and the priority sort runs across everything.
  await userEvent.click(page.getByRole("button", { name: "Group", exact: true }));
  await app.waitForUrl((url) => url.searchParams.get("group") === "none");
  context();
  await expect.element(group(/^In progress/)).not.toBeInTheDocument();
  await expect
    .poll(titles)
    .toEqual([
      "Write the release notes",
      "Index the docs",
      "Fix the login race",
      "Someday tidy-up",
    ]);
  await userEvent.click(page.getByRole("button", { name: "Group", exact: true }));
  await app.waitForUrl((url) => !url.searchParams.has("group"));
  context();
  // Grouping replaces the current entry, but inspector navigation pushes:
  // Back restores the selected issue, Forward restores the list and its sort.
  await app.back();
  await opened("GRP-2");
  await app.forward();
  await app.waitForUrl((url) => !url.pathname.includes("/issues/"));
  context();
  // A toolbar action immediately after Forward must not restore the inspector
  // from the previous render's pathname.
  await userEvent.click(page.getByRole("button", { name: "Group", exact: true }));
  await app.waitForUrl((url) => url.searchParams.get("group") === "none");
  expect(app.url().pathname).toBe("/tracker/orbit");
  await expect
    .element(page.getByRole("complementary", { name: "Issue GRP-2" }))
    .not.toBeInTheDocument();
  context();

  // A filter that leaves one group needs no group row.
  await app.navigate("/tracker/orbit?q=team%3Agrp+is%3Aclaimed");
  await expect.poll(titles).toEqual(["Index the docs"]);
  await expect.element(group(/^In progress/)).not.toBeInTheDocument();
});

test("progress groups: the group being read stays pinned under the header until the next one pushes it", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "pin",
      data: { key: "PIN", name: "Pinned", memberIds: ["acc_marco"] },
    },
    ...Array.from({ length: 80 }, (_, n) => ({
      kind: "issue.create",
      id: `pin-${n}`,
      data: { teamId: "pin", title: `Pinned ${n}`, ...(n >= 40 ? { status: "backlog" } : {}) },
    })),
  ]);
  renderApp("/tracker/orbit?q=team%3Apin+is%3Aopen");
  const table = page.getByRole("table", { name: "Issues" });
  await expect.element(table.getByRole("button", { name: /^Up next 40/ })).toBeVisible();
  const pane = table.element() as HTMLElement;
  // Organization/Space controls must leave the entire scroll pane on screen.
  await expect
    .poll(() => pane.getBoundingClientRect().bottom)
    .toBeLessThanOrEqual(window.innerHeight);
  const pinned = () => pane.querySelector<HTMLElement>(":scope > [aria-hidden]");
  const scrollTo = async (top: number) => {
    pane.scrollTop = top;
    pane.dispatchEvent(new Event("scroll"));
    await new Promise(requestAnimationFrame);
  };
  // At the top the group's own row shows; nothing is pinned.
  expect(pinned()).toBeNull();
  // Inside Up next, its row is pinned.
  await scrollTo(10 * 32);
  await expect.poll(() => pinned()?.textContent).toMatch(/^Up next40/);
  expect(pinned()!.style.transform).toBe("translateY(0px)");
  // Backlog's row (row 41) arriving pushes Up next up and out.
  await scrollTo(41 * 32 - 10);
  await expect.poll(() => pinned()?.style.transform).toBe("translateY(-22px)");
  await scrollTo(41 * 32 + 5);
  await expect.poll(() => pinned()?.textContent).toMatch(/^Backlog40/);
  // Folding from the pinned row folds the group and brings its own row back into view.
  await userEvent.click(pinned()!.querySelector("button")!);
  const backlog = table.getByRole("button", { name: /^Backlog 40/ });
  await expect.element(backlog).toHaveAttribute("aria-expanded", "false");
  await expect.element(backlog).toBeInViewport();
  await expect.poll(() => pinned()?.textContent ?? "").not.toMatch(/^Backlog/);
  expect(pane.textContent).not.toContain("Pinned 79");
});
