import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { commitId, sidewaysOverflow } from "../testing/atlas.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";

const rail = () => page.getByRole("navigation", { name: "Places", exact: true });
const controls = () => Array.from(rail().element().querySelectorAll<HTMLElement>("a, button"));

async function seedIssue(server: TestServer) {
  await server.call("POST", "/api/tracker/orbit/mutate", {
    ...(await server.trackerContract("orbit")),
    operationId: crypto.randomUUID(),
    mutations: [
      { kind: "team.create", id: "team", data: { key: "ENG", name: "Engineering", memberIds: [] } },
      {
        kind: "issue.create",
        id: "rail-issue",
        data: {
          teamId: "team",
          title: "Keep navigation reachable",
          description: Array.from(
            { length: 35 },
            (_, i) => `Paragraph ${i + 1}: preserve the return path while reading a long issue.`,
          ).join("\n\n"),
        },
      },
    ],
  });
}

test("the phone rail stays in one row and every control is reachable without page overflow", async () => {
  const server = await TestServer.start({ world: true });
  await seedIssue(server);
  await page.viewport(390, 844);
  try {
    const app = renderApp("/tracker/orbit");
    await expect.element(rail().getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect.element(rail().getByRole("button", { name: /keyboard shortcuts/i })).toBeVisible();
    for (const width of [390, 320]) {
      await page.viewport(width, 844);
      const nav = rail().element();
      expect(nav.scrollWidth).toBeGreaterThan(nav.clientWidth);
      const boxes = controls().map((control) => control.getBoundingClientRect());
      const centers = boxes.map((box) => box.top + box.height / 2);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
      for (const control of controls()) {
        const size = control.getBoundingClientRect();
        expect(size.width).toBeGreaterThanOrEqual(44);
        expect(size.height).toBeGreaterThanOrEqual(44);
        // Focus must reveal even partially clipped trailing controls.
        control.focus();
        await expect
          .poll(() => {
            const box = control.getBoundingClientRect();
            const bounds = nav.getBoundingClientRect();
            const left = bounds.left + nav.clientLeft;
            return {
              control: control.getAttribute("aria-label"),
              focused: document.activeElement === control,
              leftVisible: box.left >= left,
              rightVisible: box.right <= left + nav.clientWidth,
            };
          })
          .toEqual({
            control: control.getAttribute("aria-label"),
            focused: true,
            leftVisible: true,
            rightVisible: true,
          });
      }
      expect(nav.scrollLeft).toBeGreaterThan(0);
      // Portalled tooltips retain their previous position during the 150ms exit.
      // Keep the zero-overflow invariant once focus/resize geometry settles.
      await expect.poll(sidewaysOverflow).toBeLessThanOrEqual(0);
    }
    await page.viewport(1280, 900);
    const boxes = controls().map((control) => control.getBoundingClientRect());
    expect(boxes[1]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom);
    expect(rail().element().getBoundingClientRect().width).toBeLessThan(100);
    await expect.poll(sidewaysOverflow).toBeLessThanOrEqual(0);
    await app.navigate("/tracker/orbit/issues/ENG-1");
    await expect.element(page.getByRole("article", { name: "ENG-1 issue detail" })).toBeVisible();
    await expect.element(page.getByRole("table", { name: "Issues", exact: true })).toBeVisible();
  } finally {
    await page.viewport(1280, 900);
  }
});

for (const width of [390, 320]) {
  for (const scoped of [false, true]) {
    test(`${width}px ${scoped ? "timeline" : "main"} issue deep links, selection and anchors clear the sticky rail`, async () => {
      const server = await TestServer.start({ world: true });
      await seedIssue(server);
      if (scoped) {
        await server.repo("orbit", "engine");
        await server.push("orbit/engine", "main", commitId());
        await server.call("POST", "/api/tracker/orbit/timelines", {
          slug: "phone-rail",
          name: "Phone rail",
          repos: ["orbit/engine"],
        });
      }
      const scope = scoped ? "?tl=phone-rail" : "";
      await page.viewport(width, 844);
      try {
        const app = renderApp(`/tracker/orbit/issues/ENG-1${scope}`);
        const back = page.getByRole("link", { name: "Back to issues", exact: true });
        const clear = () => {
          const box = back.element().getBoundingClientRect();
          const nav = rail().element().getBoundingClientRect();
          return box.top >= nav.bottom && box.bottom <= window.innerHeight;
        };
        await expect.element(back).toBeVisible();
        await expect.poll(clear).toBe(true);
        if (scoped)
          await expect.element(page.getByRole("region", { name: "Timeline scope" })).toBeVisible();
        await userEvent.click(back);
        await app.waitForUrl((url) => !url.pathname.includes("/issues/"));
        await userEvent.click(
          page
            .getByRole("table", { name: "Issues", exact: true })
            .getByText("Keep navigation reachable", { exact: true }),
        );
        await app.waitForUrl((url) => url.pathname.includes("/issues/"));
        await expect.element(back).toBeVisible();
        await expect.poll(clear).toBe(true);
        expect(app.url().searchParams.get("tl")).toBe(scoped ? "phone-rail" : null);

        // Exercise the browser's native fragment algorithm on real page content,
        // not a CSS-source assertion or a URL-specific shell scroll handler.
        back.element().id = "rail-return-anchor";
        window.scrollTo(0, document.documentElement.scrollHeight);
        window.location.hash = "rail-return-anchor";
        await expect.poll(clear).toBe(true);
        expect(rail().element().getBoundingClientRect().top).toBe(0);
        expect(sidewaysOverflow()).toBeLessThanOrEqual(0);
      } finally {
        await page.viewport(1280, 900);
      }
    });
  }
}
