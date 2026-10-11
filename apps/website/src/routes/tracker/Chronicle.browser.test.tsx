import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";
import { mutate } from "../../testing/timelines.ts";
import { focusOn, press } from "../../testing/focus.ts";

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

test.each([
  { committed: false, direction: "ArrowRight", offset: 2 },
  { committed: true, direction: "ArrowRight", offset: 2 },
  { committed: true, direction: "ArrowLeft", offset: 0 },
])(
  "an older URL acknowledgement preserves $direction (committed: $committed)",
  async ({ committed, direction, offset }) => {
    const server = await TestServer.start({ world: true });
    await mutate(server, [
      {
        kind: "team.create",
        id: "chronicle-ack-team",
        data: { key: "ACK", name: "Acknowledgements", memberIds: ["acc_marco"] },
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
    const nextAt = at + offset * step;
    await focusOn(scrubber);
    const navigate = app.router.navigate.bind(app.router);
    const pending: Array<() => Promise<void>> = [];
    const navigation = vi.spyOn(app.router, "navigate").mockImplementation((to, options) => {
      if (typeof to === "number") return navigate(to);
      return new Promise<void>((resolve, reject) => {
        pending.push(() => navigate(to, options).then(resolve, reject));
      });
    });
    let held = false;
    try {
      await press("ArrowRight");
      await expect.poll(() => pending.length).toBe(1);
      if (committed) await press(direction);
      else {
        await userEvent.keyboard(`{${direction}>}`);
        held = true;
      }
      await expect.element(scrubber).toHaveValue(String(nextAt));
      await pending.shift()!();
      await app.waitForUrl(
        (url) => url.searchParams.get("at") === new Date(at + step).toISOString(),
      );
      // Router state leads React's commit; wait for the rendered URL before
      // checking that its acknowledgement did not erase the newer gesture.
      await expect
        .element(page.getByRole("link", { name: "Settings", exact: true }))
        .toHaveAttribute(
          "href",
          expect.stringContaining(`at=${encodeURIComponent(new Date(at + step).toISOString())}`),
        );
      await expect.element(scrubber).toHaveValue(String(nextAt));
      if (held) {
        await userEvent.keyboard(`{/${direction}}`);
        held = false;
      }
      await expect.poll(() => pending.length).toBe(1);
      await pending.shift()!();
      await app.waitForUrl((url) => url.searchParams.get("at") === new Date(nextAt).toISOString());
      navigation.mockRestore();
      expect(document.activeElement).toBe(input);
      await app.back();
      await expect.element(scrubber).toHaveValue(String(at + step));
      await app.forward();
      await expect.element(scrubber).toHaveValue(String(nextAt));
    } finally {
      navigation.mockRestore();
      if (held) await userEvent.keyboard(`{/${direction}}`);
      for (const acknowledge of pending) await acknowledge();
    }
  },
);
