import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { OrganizationPage, SpacePage } from "../../shared/spaces.ts";
import { CONTENT_CONTRACT_HEADER } from "../../shared/spaces.ts";
import { renderApp } from "../testing/render.tsx";
import { sidewaysOverflow } from "../testing/atlas.ts";
import { focusOn, focused, press } from "../testing/focus.ts";
import { TestServer } from "../testing/server.ts";

// Organization and Space switching lives in the rail's account menu (CORE-414).
const accountMenu = () => page.getByRole("button", { name: /account menu$/ });
const scopeItem = (name: "Organization" | "Space") =>
  page.getByRole("menuitem", { name: new RegExp(`^${name}`) });

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
  await expect
    .element(page.getByRole("link", { name: "New repository", exact: true }))
    .toHaveAttribute("href", `/${created.spaces[0]!.space.slug}/-/repositories/new`);
  await expect
    .element(page.getByRole("navigation", { name: "Organization and Space" }))
    .not.toBeInTheDocument();
  await userEvent.click(accountMenu());
  await expect
    .element(scopeItem("Organization"))
    .toHaveAccessibleName("Organization: Navigation Company");
  await expect.element(scopeItem("Space")).toHaveAccessibleName("Space: General");
  await userEvent.click(scopeItem("Organization"));
  await expect
    .element(page.getByRole("menuitem", { name: "Navigation Company" }))
    .toHaveAttribute("aria-current", "true");
  await page.getByRole("menuitem", { name: "Organization directory" }).click();
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

test("scope menus support keyboard dismissal without switching or creating", async () => {
  const server = await TestServer.start({ world: true });
  const created = await organization(server, "keyboard-space-browser");
  renderApp(`/${created.spaces[0]!.space.slug}`);
  await expect.element(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await focusOn(accountMenu());
  const mark = server.requests.length;
  await press("Enter");
  await expect.element(scopeItem("Organization")).toHaveFocus();
  await press("ArrowRight");
  const choice = page.getByRole("menuitem", { name: "Navigation Company", exact: true });
  await expect.element(choice).toHaveFocus();
  // Escape leaves only the submenu, then the menu, returning focus each step.
  await press("Escape");
  await expect.element(choice).not.toBeInTheDocument();
  await expect.element(scopeItem("Organization")).toHaveFocus();
  await press("ArrowDown");
  await expect.element(scopeItem("Space")).toHaveFocus();
  await press("ArrowRight");
  await expect
    .element(page.getByRole("menuitem", { name: /^General/ }))
    .toHaveAttribute("aria-current", "true");
  await press("ArrowLeft");
  await expect.element(scopeItem("Space")).toHaveFocus();
  await press("Escape");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  expect(focused().name).toMatch(/account menu$/);
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

test("phone scope menus remain reachable and repository creation stays in Repositories", async () => {
  const server = await TestServer.start({ world: true });
  const created = await organization(server, "phone-space-browser");
  await page.viewport(320, 720);
  try {
    renderApp(`/${created.spaces[0]!.space.slug}`);
    const repositories = page.getByRole("region", { name: "Repositories" });
    await expect.element(repositories.getByRole("link", { name: "New repository" })).toBeVisible();
    const within = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left >= 0, right: box.right <= 320, tall: box.height >= 44 };
    };
    const fits = { left: true, right: true, tall: true };
    await userEvent.click(accountMenu());
    for (const name of ["Organization", "Space"] as const) {
      await expect.element(scopeItem(name)).toBeVisible();
      expect(within(scopeItem(name).element())).toEqual(fits);
    }
    await userEvent.click(scopeItem("Space"));
    const choice = page.getByRole("menuitem", { name: /^General/ });
    await expect.element(choice).toBeVisible();
    await expect.poll(() => within(choice.element())).toEqual(fits);
    await expect
      .element(page.getByRole("menuitem", { name: "New repository" }))
      .not.toBeInTheDocument();
    await expect.poll(sidewaysOverflow).toBeLessThanOrEqual(0);
  } finally {
    await page.viewport(1280, 900);
  }
});

test("entering an Organization reads the session once per navigation and its Space without a waterfall", async () => {
  const server = await TestServer.start({ world: true });
  const created = await organization(server, "session-once-browser");
  const slug = created.spaces[0]!.space.slug;
  // When each request starts and ends, to see which reads wait on which.
  const events: string[] = [];
  const serve = vi.mocked(window.fetch).getMockImplementation()!;
  vi.mocked(window.fetch).mockImplementation(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input, location.origin).pathname;
    events.push(`start ${path}`);
    try {
      return await serve(input, init);
    } finally {
      events.push(`end ${path}`);
    }
  });
  const mark = server.requests.length;
  // Two navigations: the Organization, then the redirect into its only Space.
  renderApp(`/organizations/${created.organization.slug}?enter=1`);
  await expect.element(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  const sessions = server.since(mark).filter((request) => request.url.pathname === "/api/session");
  expect(sessions).toHaveLength(2);
  const at = (event: string) => {
    const index = events.indexOf(event);
    expect(index, event).toBeGreaterThanOrEqual(0);
    return index;
  };
  // The Organization page is read alongside the session, not after it.
  expect(at(`start /api/organizations/${created.organization.slug}`)).toBeLessThan(
    at("end /api/session"),
  );
  // The Space page doesn't wait for its repositories, nor its teams for directory administration.
  expect(at(`start /api/spaces/${slug}`)).toBeLessThan(at("end /api/repos"));
  expect(at(`start /api/tracker/${slug}/teams`)).toBeLessThan(at(`end /api/spaces/${slug}/grants`));
});
