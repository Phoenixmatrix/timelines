// A person's own default Organization and Space (CORE-413) on Preferences,
// against the Worker's routes in memory: choosing one saves it on the server,
// Home and the tracker then open it, and resetting returns to the personal default.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { SessionResponse } from "../../shared/api.ts";
import type { OrganizationPage, SpacePage } from "../../shared/spaces.ts";
import type { TrackerList } from "../../shared/tracker.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";
import { visual } from "../testing/visual.ts";

async function choose(name: string, option: string) {
  await userEvent.click(page.getByRole("combobox", { name }));
  await userEvent.click(page.getByRole("option", { name: option, exact: true }));
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
}

test("a chosen default Space is where Home and the tracker open, until reset", async () => {
  const server = await TestServer.start({ world: true });
  const created = await server.call<OrganizationPage>("POST", "/api/organizations", {
    slug: "default-scope-company",
    displayName: "Default Company",
    spaceSlug: "default-scope-general",
    spaceDisplayName: "General",
  });
  const tools = await server.call<SpacePage>("POST", "/api/spaces", {
    organizationId: created.organization.id,
    slug: "default-scope-tools",
    displayName: "Tools",
  });
  const before = await server.call<SessionResponse>("GET", "/api/session");
  expect(before.viewer!.savedDefault).toEqual({ organizationId: null, spaceId: null });

  let app = renderApp("/settings/preferences");
  await expect
    .element(page.getByRole("heading", { name: "Default Organization and Space" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Use personal default" }))
    .not.toBeInTheDocument();
  await choose("Default Organization", "Default Company");
  await expect
    .poll(() => page.getByRole("combobox", { name: "Default Space" }).element().textContent)
    .toContain("Organization's default (General)");
  await choose("Default Space", "Tools (default-scope-tools)");
  await userEvent.click(page.getByRole("button", { name: "Save default" }));
  await expect.element(page.getByText("Default saved")).toBeVisible();
  await expect
    .element(page.getByRole("status").filter({ hasText: "Opens" }))
    .toHaveTextContent("Opens Default Company / Tools now.");
  window.scrollTo(0, 0);
  await visual("Preferences default Space");

  const after = await server.call<SessionResponse>("GET", "/api/session");
  expect(after.viewer).toMatchObject({
    defaultSpaceId: tools.space.id,
    savedDefault: { organizationId: created.organization.id, spaceId: tools.space.id },
  });
  const trackers = await server.call<TrackerList>("GET", "/api/tracker");
  expect(trackers.defaultSpaceId).toBe(tools.space.id);
  app.unmount();

  app = renderApp("/");
  await expect
    .element(page.getByRole("link", { name: "New repository" }))
    .toHaveAttribute("href", "/default-scope-tools/-/repositories/new");
  app.unmount();

  renderApp("/settings/preferences");
  await userEvent.click(page.getByRole("button", { name: "Use personal default" }));
  await expect.element(page.getByText("Default reset")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Use personal default" }))
    .not.toBeInTheDocument();
  const reset = await server.call<SessionResponse>("GET", "/api/session");
  expect(reset.viewer).toMatchObject({
    defaultSpaceId: before.viewer!.defaultSpaceId,
    savedDefault: { organizationId: null, spaceId: null },
  });
});
