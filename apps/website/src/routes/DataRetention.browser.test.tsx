import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { RetentionSettings } from "../../shared/retention.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";

test("personal retention shows personal policies without Space content categories", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  renderApp("/settings/retention?person=marco");
  await expect
    .element(page.getByText("Personal retention for @marco", { exact: true }))
    .toBeVisible();
  const settings = await server.call<RetentionSettings>("GET", "/api/accounts/marco/retention");
  expect(settings.target.kind).toBe("person");
  expect(settings.canEdit).toBe(true);
  expect(settings.categories.length).toBeGreaterThan(0);
  expect(settings.categories.every((category) => category.scope === "person")).toBe(true);
});

test("Space retention uses the selected Space and preserves scoped usage links", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  renderApp("/settings/retention?space=orbit");
  await expect.element(page.getByText("Space retention for @orbit", { exact: true })).toBeVisible();
  const settings = await server.call<RetentionSettings>("GET", "/api/spaces/orbit/retention");
  expect(settings.target.kind).toBe("space");
  expect(settings.canEdit).toBe(true);
  expect(settings.categories.length).toBeGreaterThan(0);
  expect(settings.categories.every((category) => category.scope === "space")).toBe(true);
  await expect
    .element(page.getByRole("link", { name: "Usage & costs", exact: true }))
    .toHaveAttribute("href", "/settings/usage?space=orbit");
});

test("Instance retention is visibly separate from personal and Space policy", async () => {
  const server = await TestServer.start({ world: true, persona: "priya" });
  renderApp("/settings/site-retention");
  await expect
    .element(page.getByRole("heading", { name: "Instance data retention", level: 1 }))
    .toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "Defaults for Spaces and people" }))
    .toBeVisible();
  const settings = await server.call<RetentionSettings>("GET", "/api/admin/retention");
  expect(settings.target).toEqual({ kind: "instance", id: "" });
});
