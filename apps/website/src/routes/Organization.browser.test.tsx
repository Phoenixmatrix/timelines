import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { OrganizationPage, SpacePage } from "../../shared/spaces.ts";
import { CONTENT_CONTRACT_HEADER } from "../../shared/spaces.ts";
import { renderApp } from "../testing/render.tsx";
import { focusOn, focused, press } from "../testing/focus.ts";
import { TestServer } from "../testing/server.ts";

async function organization(server: TestServer, slug: string) {
  return server.call<OrganizationPage>("POST", "/api/organizations", {
    slug,
    displayName: "Navigation Company",
    spaceSlug: `${slug}-general`,
    spaceDisplayName: "General",
  });
}

test("a single-Space Organization opens its explicit default; directory stays reachable", async () => {
  const server = await TestServer.start({ world: true });
  const created = await organization(server, "one-space-browser");
  const app = renderApp(`/organizations/${created.organization.slug}?enter=1`);
  await expect.element(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Switch Organization" })).toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Switch Space" })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "New repository", exact: true }))
    .toHaveAttribute("href", `/${created.spaces[0]!.space.slug}/-/repositories/new`);
  await page.getByRole("link", { name: "Organization directory" }).click();
  await expect
    .element(page.getByRole("heading", { name: "Navigation Company", exact: true }))
    .toBeVisible();
  expect(app.container.textContent).toContain("Default Space");
  const requests = vi.mocked(window.fetch).mock.calls.filter(([input]) => {
    const pathname = new URL(input instanceof Request ? input.url : input, location.origin)
      .pathname;
    return pathname.startsWith("/api/organizations") || pathname.startsWith("/api/spaces");
  });
  expect(requests.length).toBeGreaterThan(0);
  for (const [, init] of requests)
    expect(new Headers(init?.headers).get(CONTENT_CONTRACT_HEADER)).toBe("4");
});

test("multiple Spaces use the directory, never whichever Space happens to be first", async () => {
  const server = await TestServer.start({ world: true });
  const created = await organization(server, "multi-space-browser");
  await server.call<SpacePage>("POST", "/api/spaces", {
    organizationId: created.organization.id,
    slug: "multi-space-browser-tools",
    displayName: "Tools",
  });
  renderApp(`/organizations/${created.organization.slug}?enter=1`);
  await expect
    .element(page.getByRole("heading", { name: "Navigation Company", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("link", { name: "Tools", exact: true })).toBeVisible();
  await expect.element(page.getByRole("link", { name: "General", exact: true })).toBeVisible();
});

test("Organization ownership without a Space grant exposes directory administration but no Tracker reads", async () => {
  const server = await TestServer.start({ world: true });
  const created = await organization(server, "directory-only-browser");
  const initial = created.spaces[0]!;
  await server.call(
    "DELETE",
    `/api/spaces/${initial.space.slug}/grants/${initial.grant!.accountId}`,
  );
  const mark = server.requests.length;
  renderApp(`/${initial.space.slug}`);
  await expect.element(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "People and explicit grants", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "New repository", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("navigation", { name: "Space work" }))
    .not.toBeInTheDocument();
  expect(
    server
      .since(mark)
      .some((request) => request.url.pathname.startsWith(`/api/tracker/${initial.space.slug}/`)),
  ).toBe(false);
});

test("scope selectors support keyboard dismissal without switching or creating", async () => {
  const server = await TestServer.start({ world: true });
  const created = await organization(server, "keyboard-space-browser");
  renderApp(`/${created.spaces[0]!.space.slug}`);
  const selector = page.getByRole("combobox", { name: "Switch Organization" });
  await focusOn(selector);
  const mark = server.requests.length;
  await press("Enter");
  await expect.element(page.getByRole("listbox")).toBeVisible();
  await press("Escape");
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
  expect(focused().name).toBe("Switch Organization");
  expect(server.since(mark).some((request) => request.method !== "GET")).toBe(false);
  await expect.element(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
});

test("Space navigation and browser history retain concrete destinations without creating repositories", async () => {
  const server = await TestServer.start({ world: true });
  const created = await organization(server, "history-space-browser");
  const second = await server.call<SpacePage>("POST", "/api/spaces", {
    organizationId: created.organization.id,
    slug: "history-space-browser-tools",
    displayName: "Tools",
  });
  const first = created.spaces[0]!.space;
  const app = renderApp(`/${first.slug}?source=retained-source#repositories-heading`);
  await expect.element(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  const mark = server.requests.length;
  await app.navigate(`/${second.space.slug}`);
  await expect.element(page.getByRole("heading", { name: "Tools", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "New repository", exact: true }))
    .toHaveAttribute("href", `/${second.space.slug}/-/repositories/new`);
  await app.back();
  await app.waitForUrl(
    (url) =>
      url.pathname === `/${first.slug}` &&
      url.searchParams.get("source") === "retained-source" &&
      url.hash === "#repositories-heading",
  );
  await expect.element(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await app.forward();
  await app.waitForUrl((url) => url.pathname === `/${second.space.slug}`);
  expect(
    server
      .since(mark)
      .some((request) => request.method === "POST" && request.url.pathname === "/api/repos"),
  ).toBe(false);
});

test("phone scope controls remain reachable and repository creation stays in Repositories", async () => {
  const server = await TestServer.start({ world: true });
  const created = await organization(server, "phone-space-browser");
  await page.viewport(320, 720);
  try {
    renderApp(`/${created.spaces[0]!.space.slug}`);
    for (const name of ["Switch Organization", "Switch Space"]) {
      const control = page.getByRole("combobox", { name });
      await expect.element(control).toBeVisible();
      const box = control.element().getBoundingClientRect();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(320);
    }
    const repositories = page.getByRole("region", { name: "Repositories" });
    await expect.element(repositories.getByRole("link", { name: "New repository" })).toBeVisible();
    await expect
      .element(
        page
          .getByRole("navigation", { name: "Organization and Space" })
          .getByRole("link", { name: "New repository" }),
      )
      .not.toBeInTheDocument();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  } finally {
    await page.viewport(1280, 900);
  }
});
