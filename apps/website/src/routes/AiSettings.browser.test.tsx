// "Keep AI request and response bodies in gateway logs" (CORE-290): a site
// administrator sets the site default, an account's owner overrides it for
// the account, each page shows the retention note, and what they save is
// what the real settings routes store.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  AI_LOG_BODIES_NOTE,
  type AiSettingsView,
  type SiteAiSettingsView,
} from "../../shared/ai.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";

/** Pick `option` in the select named `name`, and wait for its list to close. */
async function choose(name: string, option: string) {
  await userEvent.click(page.getByRole("combobox", { name }));
  await userEvent.click(page.getByRole("option", { name: option, exact: true }));
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
}

const entry = (view: { logBodies: { components: { component: string }[] } }, component: string) =>
  view.logBodies.components.find((e) => e.component === component)!;

test("a site administrator turns body logging on for the site, then back to the environment default", async () => {
  const server = await TestServer.start({ world: true, persona: "priya" });
  renderApp("/settings/site-ai");
  await expect
    .element(page.getByRole("heading", { name: "Site AI settings", level: 1 }))
    .toBeVisible();
  await expect.element(page.getByText(AI_LOG_BODIES_NOTE)).toBeVisible();
  const knowledge = page.getByRole("checkbox", { name: "Knowledge", exact: true });
  const assistant = page.getByRole("checkbox", { name: "Assistant", exact: true });
  // The browser world binds no AI: its environment default is off.
  await expect.element(knowledge).not.toBeChecked();
  await userEvent.click(knowledge);
  await userEvent.click(assistant);
  await expect.element(page.getByText("You have unsaved changes.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Save site AI settings" }));
  await expect.element(page.getByText(/Site AI settings saved/)).toBeVisible();
  const saved = await server.call<SiteAiSettingsView>("GET", "/api/admin/ai");
  expect(entry(saved, "knowledge")).toMatchObject({
    site: true,
    siteFrom: "site",
    effective: true,
  });
  expect(entry(saved, "assistant")).toMatchObject({ site: true, siteFrom: "site" });
  expect(entry(saved, "avatars")).toMatchObject({ site: false, siteFrom: "environment" });
  // Accounts without an override follow it.
  const orbit = await server.call<AiSettingsView>(
    "GET",
    "/api/accounts/orbit/settings/ai",
    undefined,
    "marco",
  );
  expect(entry(orbit, "knowledge")).toMatchObject({ account: null, effective: true });

  await userEvent.click(page.getByRole("button", { name: "Use the environment default" }));
  await expect
    .element(page.getByText(/every part follows the environment default \(off\)/))
    .toBeVisible();
  await expect.element(knowledge).not.toBeChecked();
  const reset = await server.call<SiteAiSettingsView>("GET", "/api/admin/ai");
  expect(reset.logBodies.components.every((e) => e.siteFrom === "environment" && !e.site)).toBe(
    true,
  );
});

test("an account's owner overrides the site default for the account's own calls", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  await server.call("PATCH", "/api/admin/ai", { logBodies: { assistant: true } }, "priya");
  renderApp("/settings/ai?owner=orbit");
  const fieldset = page.getByRole("group", {
    name: "Keep AI request and response bodies in gateway logs",
  });
  await expect.element(fieldset).toBeVisible();
  await expect.element(fieldset.getByText(AI_LOG_BODIES_NOTE)).toBeVisible();
  const assistant = page.getByRole("combobox", {
    name: "Assistant: keep request and response bodies",
  });
  await expect.poll(() => assistant.element().textContent).toContain("Site default (on)");
  await choose("Assistant: keep request and response bodies", "Off: metadata only");
  await choose("Release notes: keep request and response bodies", "On: keep bodies");
  await userEvent.click(page.getByRole("button", { name: "Save AI settings" }));
  await expect.element(page.getByText(/AI settings saved for @orbit/)).toBeVisible();
  const saved = await server.call<AiSettingsView>("GET", "/api/accounts/orbit/settings/ai");
  expect(entry(saved, "assistant")).toMatchObject({ site: true, account: false, effective: false });
  expect(entry(saved, "release-notes")).toMatchObject({
    site: false,
    account: true,
    effective: true,
  });
  expect(entry(saved, "knowledge")).toMatchObject({ account: null, effective: false });
  // Back to following the site.
  await choose("Assistant: keep request and response bodies", "Site default (on)");
  await userEvent.click(page.getByRole("button", { name: "Save AI settings" }));
  await expect
    .poll(async () =>
      entry(
        await server.call<AiSettingsView>("GET", "/api/accounts/orbit/settings/ai"),
        "assistant",
      ),
    )
    .toMatchObject({ account: null, effective: true });
});

test("a member sees the setting and the note, read-only", async () => {
  await TestServer.start({ world: true, persona: "jun" });
  renderApp("/settings/ai?owner=orbit");
  await expect.element(page.getByText(AI_LOG_BODIES_NOTE)).toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Assistant: keep request and response bodies" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Save AI settings" }))
    .not.toBeInTheDocument();
});
