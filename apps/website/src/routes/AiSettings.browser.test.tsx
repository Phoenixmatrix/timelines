// An Instance operator sets the logging default; an explicit Space admin
// overrides it. Saved settings must preserve inheritance and Space isolation.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { AiSettingsView, PersonAiSettingsView, SiteAiSettingsView } from "../../shared/ai.ts";
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

test("an Instance operator turns body logging on, then back to the environment default", async () => {
  const server = await TestServer.start({ world: true, persona: "priya" });
  renderApp("/settings/site-ai");
  await expect
    .element(page.getByRole("heading", { name: "Instance AI settings", level: 1 }))
    .toBeVisible();
  const knowledge = page.getByRole("checkbox", { name: "Knowledge", exact: true });
  const assistant = page.getByRole("checkbox", { name: "Assistant", exact: true });
  // The browser world binds no AI: its environment default is off.
  await expect.element(knowledge).not.toBeChecked();
  await userEvent.click(knowledge);
  await userEvent.click(assistant);
  await expect.element(page.getByText("You have unsaved changes.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Save Instance AI settings" }));
  await expect.element(page.getByText(/Instance AI settings saved/)).toBeVisible();
  const saved = await server.call<SiteAiSettingsView>("GET", "/api/admin/ai");
  expect(entry(saved, "knowledge")).toMatchObject({
    site: true,
    siteFrom: "site",
    effective: true,
  });
  expect(entry(saved, "assistant")).toMatchObject({ site: true, siteFrom: "site" });
  expect(entry(saved, "avatars")).toMatchObject({ site: false, siteFrom: "environment" });
  // Spaces without an override follow it.
  const orbit = await server.call<AiSettingsView>(
    "GET",
    "/api/spaces/orbit/settings/ai",
    undefined,
    "marco",
  );
  expect(entry(orbit, "knowledge")).toMatchObject({ space: null, effective: true });

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

test("an explicit Space admin overrides the Instance default for the Space's own calls", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  await server.call("PATCH", "/api/admin/ai", { logBodies: { knowledge: true } }, "priya");
  renderApp("/settings/ai?space=orbit");
  const fieldset = page.getByRole("group", {
    name: "Keep AI request and response bodies in gateway logs",
  });
  await expect.element(fieldset).toBeVisible();
  const knowledge = page.getByRole("combobox", {
    name: "Knowledge: keep request and response bodies",
  });
  await expect.poll(() => knowledge.element().textContent).toContain("Instance default (on)");
  await choose("Knowledge: keep request and response bodies", "Off: metadata only");
  await choose("Release notes: keep request and response bodies", "On: keep bodies");
  await userEvent.click(page.getByRole("button", { name: "Save AI settings" }));
  await expect.element(page.getByText(/AI settings saved for @orbit/)).toBeVisible();
  const saved = await server.call<AiSettingsView>("GET", "/api/spaces/orbit/settings/ai");
  expect(entry(saved, "knowledge")).toMatchObject({ site: true, space: false, effective: false });
  expect(entry(saved, "release-notes")).toMatchObject({
    site: false,
    space: true,
    effective: true,
  });
  expect(entry(saved, "merge-queue")).toMatchObject({ space: null, effective: false });
  // Back to following the Instance.
  await choose("Knowledge: keep request and response bodies", "Instance default (on)");
  await userEvent.click(page.getByRole("button", { name: "Save AI settings" }));
  await expect
    .poll(async () =>
      entry(await server.call<AiSettingsView>("GET", "/api/spaces/orbit/settings/ai"), "knowledge"),
    )
    .toMatchObject({ space: null, effective: true });
});

test("a member sees the body-logging setting read-only", async () => {
  await TestServer.start({ world: true, persona: "jun" });
  renderApp("/settings/ai?space=orbit");
  await expect
    .element(
      page.getByRole("group", { name: "Keep AI request and response bodies in gateway logs" }),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Knowledge: keep request and response bodies" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Save AI settings" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("spinbutton", { name: "Highlights refresh interval" }))
    .toBeDisabled();
});

test("a Space admin saves highlights cadence, reloads it, and retains it while release notes are off", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  const app = renderApp("/settings/ai?space=orbit");
  const cadence = page.getByRole("spinbutton", { name: "Highlights refresh interval" });
  const save = page.getByRole("button", { name: "Save AI settings" });
  await expect.element(cadence).toHaveValue(24);
  await expect.element(save).toBeDisabled();
  await userEvent.fill(cadence, "48");
  await expect.element(save).toBeEnabled();
  await userEvent.click(save);
  await expect.element(page.getByText(/AI settings saved for @orbit/)).toBeVisible();
  await expect.element(save).toBeDisabled();
  const saved = await server.call<AiSettingsView>("GET", "/api/spaces/orbit/settings/ai");
  expect(saved.releaseHighlights.intervalHours).toBe(48);
  // A fresh route load must use persisted settings rather than the local draft.
  app.unmount();
  renderApp("/settings/ai?space=orbit");
  await expect.element(cadence).toHaveValue(48);
  await userEvent.fill(cadence, "72");
  await userEvent.click(page.getByRole("button", { name: "Discard changes" }));
  await expect.element(cadence).toHaveValue(48);
  await expect.element(save).toBeDisabled();
  const releaseNotes = page.getByRole("checkbox", { name: "Release notes", exact: true });
  await expect.element(releaseNotes).toBeChecked();
  await userEvent.click(releaseNotes);
  await userEvent.click(save);
  await expect
    .poll(async () => {
      const view = await server.call<AiSettingsView>("GET", "/api/spaces/orbit/settings/ai");
      return { enabled: view.features.releaseNotes, hours: view.releaseHighlights.intervalHours };
    })
    .toEqual({ enabled: false, hours: 48 });
  await expect.element(cadence).toBeEnabled();
});

test("invalid highlights intervals block saving other edits and can be discarded", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  renderApp("/settings/ai?space=orbit");
  const cadence = page.getByRole("spinbutton", { name: "Highlights refresh interval" });
  const save = page.getByRole("button", { name: "Save AI settings" });
  await expect.element(cadence).toHaveValue(24);
  // Even another valid change cannot submit an invalid cadence.
  await userEvent.click(page.getByRole("checkbox", { name: "Release notes", exact: true }));
  for (const value of ["0", "169", "-1", "1.5", ""]) {
    await userEvent.fill(cadence, value);
    await expect.element(cadence).toHaveAttribute("aria-invalid", "true");
    await expect.element(save).toBeDisabled();
    const unchanged = await server.call<AiSettingsView>("GET", "/api/spaces/orbit/settings/ai");
    expect(unchanged.releaseHighlights.intervalHours).toBe(24);
    expect(unchanged.features.releaseNotes).toBe(true);
  }
  await userEvent.click(page.getByRole("button", { name: "Discard changes" }));
  await expect.element(cadence).toHaveValue(24);
  await expect.element(cadence).not.toHaveAttribute("aria-invalid", "true");
  await expect.element(save).toBeDisabled();
  // Both inclusive bounds are accepted and persisted by the real API.
  for (const value of [1, 168]) {
    await userEvent.fill(cadence, String(value));
    await expect.element(save).toBeEnabled();
    await userEvent.click(save);
    await expect
      .poll(
        async () =>
          (await server.call<AiSettingsView>("GET", "/api/spaces/orbit/settings/ai"))
            .releaseHighlights.intervalHours,
      )
      .toBe(value);
    await expect.element(save).toBeDisabled();
  }
});

test("an Instance operator retains the separate power to change a Space's highlights cadence", async () => {
  const server = await TestServer.start({ world: true, persona: "priya" });
  renderApp("/settings/ai?space=orbit");
  const cadence = page.getByRole("spinbutton", { name: "Highlights refresh interval" });
  await expect.element(cadence).toBeEnabled();
  await userEvent.fill(cadence, "12");
  await userEvent.click(page.getByRole("button", { name: "Save AI settings" }));
  await expect
    .poll(
      async () =>
        (await server.call<AiSettingsView>("GET", "/api/spaces/orbit/settings/ai"))
          .releaseHighlights.intervalHours,
    )
    .toBe(12);
});

test("personal assistant logging never becomes Space spending policy", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  const app = renderApp("/settings/ai?person=marco");
  await expect
    .element(page.getByRole("heading", { name: "Personal AI logging", level: 1 }))
    .toBeVisible();
  await choose("Assistant: keep request and response bodies", "On: keep bodies");
  await userEvent.click(page.getByRole("button", { name: "Save personal AI logging" }));
  await expect.element(page.getByText("Personal AI logging saved.", { exact: true })).toBeVisible();
  const personal = await server.call<PersonAiSettingsView>(
    "GET",
    "/api/accounts/marco/settings/ai",
  );
  expect(entry(personal, "assistant")).toMatchObject({ person: true, effective: true });
  expect(personal.logBodies.components.map((component) => component.component)).not.toContain(
    "knowledge",
  );
  app.unmount();
  renderApp("/settings/ai?space=orbit");
  await expect.element(page.getByRole("heading", { name: "AI settings", level: 1 })).toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Assistant: keep request and response bodies" }))
    .not.toBeInTheDocument();
  const space = await server.call<AiSettingsView>("GET", "/api/spaces/orbit/settings/ai");
  expect(space.logBodies.components.map((component) => component.component)).not.toContain(
    "assistant",
  );
  expect(entry(space, "knowledge")).toMatchObject({ space: null, effective: false });
});
