import { Tooltip } from "@base-ui/react/tooltip";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useSearchParams } from "react-router";
import { expect, onTestFinished, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { Snapshot } from "../../../shared/tracker.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { visual } from "../../testing/visual.ts";
import { mutate } from "../../testing/timelines.ts";
import { focusOn, press } from "../../testing/focus.ts";
import { Chronicle } from "./Chronicle.tsx";

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
  await visual("Chronicle - issues");
  await title.hover();
  await expect.poll(() => tooltip()?.textContent).toContain(`ENG-1 ${LONG}`);
  // The tooltip wraps rather than truncating the title again.
  const first = tooltip()!.firstElementChild as HTMLElement;
  expect(first.scrollWidth).toBeLessThanOrEqual(first.clientWidth);
  // Leaving the row hides it.
  await page.getByRole("heading", { name: "Issues", level: 1 }).hover();
  await expect.poll(tooltip).toBeNull();
});

test("list playhead preserves successive keyboard increments and browser history", async () => {
  const server = await TestServer.start({ world: true });
  await mutate(server, [
    {
      kind: "team.create",
      id: "chronicle-keyboard-team",
      data: { key: "KEYS", name: "Keyboard", memberIds: ["acc_marco"] },
    },
  ]);
  const from = Date.parse("2026-01-01T00:00:00.000Z");
  const at = from + 9 * 3_600_000;
  const params = new URLSearchParams({
    view: "chronicle",
    layout: "list",
    from: new Date(from).toISOString(),
    to: new Date(from + 24 * 3_600_000).toISOString(),
    at: new Date(at).toISOString(),
  });
  const app = renderApp(`/tracker/orbit?${params}`);
  const scrubber = page.getByRole("slider", { name: "Playhead" });
  await expect.element(scrubber).toBeVisible();
  const input = scrubber.element() as HTMLInputElement;
  const step = Number(input.step);
  await focusOn(scrubber);
  for (let increment = 1; increment <= 3; increment++) {
    await press("ArrowRight");
    await expect.element(scrubber).toHaveValue(String(at + increment * step));
  }
  await press("ArrowLeft");
  await expect.element(scrubber).toHaveValue(String(at + 2 * step));
  expect(document.activeElement).toBe(input);
  await app.waitForUrl(
    (url) => url.searchParams.get("at") === new Date(at + 2 * step).toISOString(),
  );
  await expect.element(scrubber).toHaveValue(String(at + 2 * step));
  await app.back();
  await expect.element(scrubber).toHaveValue(String(at + 3 * step));
  await app.forward();
  await expect.element(scrubber).toHaveValue(String(at + 2 * step));
});

test("older navigation acknowledgements cannot erase a newer playhead gesture", async () => {
  await TestServer.start({ world: true });
  const from = Date.parse("2026-01-01T00:00:00.000Z");
  const at = from + 9 * 3_600_000;
  const to = from + 24 * 3_600_000;
  const initial = new URLSearchParams({
    view: "chronicle",
    layout: "list",
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    at: new Date(at).toISOString(),
  });
  const writes: Parameters<ComponentProps<typeof Chronicle>["setParams"]>[] = [];
  function DelayedNavigation() {
    const [params] = useSearchParams();
    return (
      <Chronicle
        space="orbit"
        base="/tracker/orbit"
        query=""
        params={params}
        setParams={(...write) => writes.push(write)}
        selectedIssue={null}
        serverNow={to}
      />
    );
  }
  const router = createMemoryRouter([{ path: "*", element: <DelayedNavigation /> }], {
    initialEntries: [`/tracker/orbit?${initial}`],
  });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let held = false;
  onTestFinished(async () => {
    if (held) await userEvent.keyboard("{/ArrowLeft}");
    await act(async () => root.unmount());
    router.dispose();
    container.remove();
  });
  await act(async () =>
    root.render(
      <Tooltip.Provider>
        <RouterProvider router={router} />
      </Tooltip.Provider>,
    ),
  );
  const acknowledge = async () => {
    const next = writes.shift();
    if (!next) throw new Error("Expected a pending playhead navigation");
    await act(async () => router.navigate(`/tracker/orbit?${next[0]}`, next[1]));
  };
  const scrubber = page.getByRole("slider", { name: "Playhead" });
  await focusOn(scrubber);
  const step = Number((scrubber.element() as HTMLInputElement).step);
  await press("ArrowRight");
  await expect.element(scrubber).toHaveValue(String(at + step));
  held = true;
  await userEvent.keyboard("{ArrowLeft>}");
  await expect.element(scrubber).toHaveValue(String(at));
  await acknowledge();
  await expect.element(scrubber).toHaveValue(String(at));
  await userEvent.keyboard("{/ArrowLeft}");
  held = false;
  await press("ArrowRight");
  await expect.element(scrubber).toHaveValue(String(at + step));
  await acknowledge();
  await expect.element(scrubber).toHaveValue(String(at + step));
  await acknowledge();
  await expect.element(scrubber).toHaveValue(String(at + step));
  await act(async () => router.navigate(-1));
  await expect.element(scrubber).toHaveValue(String(at));
  await act(async () => router.navigate(1));
  await expect.element(scrubber).toHaveValue(String(at + step));
  await expect.element(scrubber).toHaveFocus();
});

test.each([
  { committed: false, direction: "ArrowRight", offset: 2 },
  { committed: true, direction: "ArrowRight", offset: 2 },
  { committed: true, direction: "ArrowLeft", offset: 0 },
])(
  "an older URL acknowledgement preserves $direction (committed: $committed)",
  async ({ committed, direction, offset }) => {
    await TestServer.start({ world: true });
    const from = Date.parse("2026-01-01T00:00:00.000Z");
    const at = from + 9 * 3_600_000;
    const to = from + 24 * 3_600_000;
    const initial = new URLSearchParams({
      view: "chronicle",
      layout: "list",
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      at: new Date(at).toISOString(),
    });
    // Each playhead write waits here until the test acknowledges it, inside
    // act(), so React has committed the older address before the assertions.
    const writes: Parameters<ComponentProps<typeof Chronicle>["setParams"]>[] = [];
    function DelayedNavigation() {
      const [params] = useSearchParams();
      return (
        <Chronicle
          space="orbit"
          base="/tracker/orbit"
          query=""
          params={params}
          setParams={(...write) => writes.push(write)}
          selectedIssue={null}
          serverNow={to}
        />
      );
    }
    const router = createMemoryRouter([{ path: "*", element: <DelayedNavigation /> }], {
      initialEntries: [`/tracker/orbit?${initial}`],
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    let held = false;
    onTestFinished(async () => {
      if (held) await userEvent.keyboard(`{/${direction}}`);
      await act(async () => root.unmount());
      router.dispose();
      container.remove();
    });
    await act(async () =>
      root.render(
        <Tooltip.Provider>
          <RouterProvider router={router} />
        </Tooltip.Provider>,
      ),
    );
    const acknowledge = async () => {
      const next = writes.shift();
      if (!next) throw new Error("Expected a pending playhead navigation");
      await act(async () => router.navigate(`/tracker/orbit?${next[0]}`, next[1]));
    };
    const scrubber = page.getByRole("slider", { name: "Playhead" });
    await focusOn(scrubber);
    const input = scrubber.element() as HTMLInputElement;
    const step = Number(input.step);
    const nextAt = at + offset * step;
    await press("ArrowRight");
    await expect.poll(() => writes.length).toBe(1);
    if (committed) await press(direction);
    else {
      await userEvent.keyboard(`{${direction}>}`);
      held = true;
    }
    await expect.element(scrubber).toHaveValue(String(nextAt));
    // The first gesture's address arrives after the newer one began.
    await acknowledge();
    expect(router.state.location.search).toContain(
      `at=${encodeURIComponent(new Date(at + step).toISOString())}`,
    );
    await expect.element(scrubber).toHaveValue(String(nextAt));
    if (held) {
      await userEvent.keyboard(`{/${direction}}`);
      held = false;
    }
    await expect.poll(() => writes.length).toBe(1);
    await acknowledge();
    expect(router.state.location.search).toContain(
      `at=${encodeURIComponent(new Date(nextAt).toISOString())}`,
    );
    await expect.element(scrubber).toHaveValue(String(nextAt));
    expect(document.activeElement).toBe(input);
    await act(async () => router.navigate(-1));
    await expect.element(scrubber).toHaveValue(String(at + step));
    await act(async () => router.navigate(1));
    await expect.element(scrubber).toHaveValue(String(nextAt));
  },
);

test.each(["chart", "list", "phone"] as const)(
  "%s checkpoints disclose readable summaries and navigate time without losing the range",
  async (layout) => {
    await page.viewport(layout === "phone" ? 390 : 1280, 900);
    try {
      const server = await TestServer.start({ world: true });
      const summary =
        "The selected range survives checkpoint navigation. Keyboard and touch access work, and this summary wraps so the next person can read the outcome.";
      await mutate(server, [
        {
          kind: "team.create",
          id: "checkpoint-team",
          data: { key: "CP", name: "Checkpoints", memberIds: ["acc_marco"] },
        },
        {
          kind: "issue.create",
          id: "checkpoint-work",
          data: { teamId: "checkpoint-team", title: "Read progress without overlapping flags" },
        },
        {
          kind: "comment.add",
          id: "checkpoint-first",
          data: { issueId: "checkpoint-work", kind: "checkpoint", body: summary },
        },
        {
          kind: "comment.add",
          id: "checkpoint-second",
          data: {
            issueId: "checkpoint-work",
            kind: "checkpoint",
            body: "Ready for the next person.",
          },
        },
        {
          kind: "comment.add",
          id: "checkpoint-evidence",
          data: { issueId: "checkpoint-work", kind: "evidence", body: "Verified separately." },
        },
      ]);
      const snapshot = await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
      const checkpointTime = snapshot.comments.find(
        (comment) => comment.id === "checkpoint-first",
      )!.createdAt;
      const time = Date.parse(checkpointTime);
      const params = new URLSearchParams({
        view: "chronicle",
        q: "",
        from: new Date(time - 3_600_000).toISOString(),
        to: new Date(time + 3_600_000).toISOString(),
        at: new Date(time - 1_800_000).toISOString(),
        rs: new Date(time - 600_000).toISOString(),
        re: new Date(time + 600_000).toISOString(),
        ...(layout === "list" ? { layout: "list" } : {}),
      });
      const app = renderApp(`/tracker/orbit?${params}`);
      const entry = page.getByRole("link", { name: "Read 2 checkpoints for CP-1" });
      await expect.element(entry).toBeVisible();
      if (layout === "chart") {
        await focusOn(entry);
        await press("Enter");
      } else {
        expect(entry.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        await entry.click();
      }
      const section = page.getByRole("region", { name: "Checkpoints 2", exact: true });
      await expect.element(section).toBeVisible();
      await expect.poll(() => document.activeElement?.id).toBe("chronicle-checkpoints");
      const text = section.getByText(summary, { exact: true });
      await expect.element(text).toBeVisible();
      const content = text.element() as HTMLElement;
      expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
      expect(content.getBoundingClientRect().height).toBeGreaterThan(
        Number.parseFloat(getComputedStyle(content).lineHeight) * 2,
      );
      await expect.element(section.getByText("Verified separately.")).not.toBeInTheDocument();
      const jump = section.getByRole("link", { name: /^Go to checkpoint at / }).first();
      await jump.click();
      const selected = await app.waitForUrl((url) => url.searchParams.get("at") === checkpointTime);
      expect(selected.pathname).toBe("/tracker/orbit/issues/checkpoint-work");
      expect(selected.searchParams.get("from")).toBe(params.get("from"));
      expect(selected.searchParams.get("to")).toBe(params.get("to"));
      expect(selected.searchParams.get("rs")).toBe(params.get("rs"));
      expect(selected.searchParams.get("re")).toBe(params.get("re"));
      await app.back();
      await app.waitForUrl((url) => url.searchParams.get("at") === params.get("at"));
      await expect.element(section).toBeVisible();
      await app.forward();
      await app.waitForUrl((url) => url.searchParams.get("at") === checkpointTime);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    } finally {
      await page.viewport(1280, 900);
    }
  },
);
