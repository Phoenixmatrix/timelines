import { expect, onTestFinished, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type {
  AssistantSkillSummary,
  PersonalAssistantSkill,
} from "../../shared/assistant-skills.ts";
import { focusOn, press } from "../testing/focus.ts";
import { renderApp } from "../testing/render.tsx";
import { reply, TestServer } from "../testing/server.ts";

const addForm = () => page.getByRole("form", { name: "Add an assistant skill" });
const row = (name: string) => page.getByRole("listitem", { name: `/${name}`, exact: true });
const list = (server: TestServer) =>
  server.call<{ skills: PersonalAssistantSkill[] }>("GET", "/api/account/skills");
const catalog = (server: TestServer) =>
  server.call<{ skills: AssistantSkillSummary[] }>("GET", "/api/assistant/skills");

async function create(server: TestServer, name = "review-notes") {
  return server.call<{ skill: PersonalAssistantSkill }>("POST", "/api/account/skills", {
    name,
    description: "Check the reasoning",
    body: "# Review\nExplain the trade-offs.",
    enabled: true,
  });
}

test("personal skills persist across remounts, edit every field, toggle catalog availability and confirm removal", async () => {
  const server = await TestServer.start({ world: true });
  let app = renderApp("/settings/skills");
  await expect.element(page.getByText(/No personal skills yet/)).toBeVisible();
  await addForm().getByRole("textbox", { name: "Name", exact: true }).fill("release-check");
  await addForm()
    .getByRole("textbox", { name: "Markdown instructions" })
    .fill("# Release\nCheck the deployment plan.");
  await addForm().getByRole("button", { name: "Add skill", exact: true }).click();
  await expect.element(row("release-check")).toBeVisible();
  await expect
    .element(addForm().getByRole("textbox", { name: "Name", exact: true }))
    .toHaveValue("");
  await expect
    .element(row("release-check").getByText("No description", { exact: true }))
    .toBeVisible();
  const created = (await list(server)).skills[0]!;
  expect(created).toMatchObject({
    name: "release-check",
    description: "",
    body: "# Release\nCheck the deployment plan.",
    enabled: true,
  });
  expect((await catalog(server)).skills).toContainEqual(
    expect.objectContaining({ id: created.id, name: "release-check", source: "personal" }),
  );

  app.unmount();
  app = renderApp("/settings/skills");
  await focusOn(
    row("release-check").getByRole("button", { name: "Edit /release-check", exact: true }),
  );
  await press("Enter");
  const edit = page.getByRole("form", { name: "Edit /release-check", exact: true });
  await expect.element(edit.getByRole("textbox", { name: "Name", exact: true })).toHaveFocus();
  await expect
    .element(edit.getByRole("textbox", { name: "Markdown instructions" }))
    .toHaveValue(created.body);
  await edit.getByRole("textbox", { name: "Name", exact: true }).fill("ship-check");
  await edit
    .getByRole("textbox", { name: "Description (optional)" })
    .fill("Prepare a safe release");
  await edit
    .getByRole("textbox", { name: "Markdown instructions" })
    .fill("## Shipping\nList rollback steps first.");
  const enabled = edit.getByRole("checkbox", { name: "Enabled", exact: true });
  await expect.element(enabled).toBeChecked();
  await enabled.click();
  await expect.element(enabled).not.toBeChecked();
  await edit.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect.element(row("ship-check")).toBeVisible();
  await expect
    .element(row("ship-check").getByRole("button", { name: "Edit /ship-check", exact: true }))
    .toHaveFocus();
  expect((await list(server)).skills).toEqual([
    expect.objectContaining({
      id: created.id,
      name: "ship-check",
      description: "Prepare a safe release",
      body: "## Shipping\nList rollback steps first.",
      enabled: false,
    }),
  ]);
  expect((await catalog(server)).skills.some((skill) => skill.id === created.id)).toBe(false);

  await row("ship-check").getByRole("checkbox", { name: "Enable /ship-check" }).click();
  await expect
    .element(row("ship-check").getByRole("checkbox", { name: "Enable /ship-check" }))
    .toBeChecked();
  expect((await catalog(server)).skills).toContainEqual(
    expect.objectContaining({ id: created.id, name: "ship-check" }),
  );
  await row("ship-check").getByRole("button", { name: "Remove /ship-check" }).click();
  let dialog = page.getByRole("dialog", { name: "Remove /ship-check?" });
  await dialog.getByRole("button", { name: "Keep it" }).click();
  expect((await list(server)).skills).toHaveLength(1);
  await row("ship-check").getByRole("button", { name: "Remove /ship-check" }).click();
  dialog = page.getByRole("dialog", { name: "Remove /ship-check?" });
  await dialog.getByRole("button", { name: "Remove skill", exact: true }).click();
  await expect.element(page.getByText(/No personal skills yet/)).toBeVisible();
  expect((await list(server)).skills).toEqual([]);
  app.unmount();
  renderApp("/settings/skills");
  await expect.element(page.getByText(/No personal skills yet/)).toBeVisible();
});

test("reserved names and duplicate names show real API errors without losing a new draft", async () => {
  const server = await TestServer.start({ world: true });
  const builtin = (await catalog(server)).skills.find((skill) => skill.source === "builtin")!;
  const { skill: existing } = await create(server);
  renderApp("/settings/skills");
  const name = addForm().getByRole("textbox", { name: "Name", exact: true });
  const instructions = addForm().getByRole("textbox", { name: "Markdown instructions" });
  await name.fill(builtin.name);
  await instructions.fill("Keep my carefully written instructions.");
  await addForm().getByRole("button", { name: "Add skill", exact: true }).click();
  await expect.element(addForm().getByRole("alert")).toBeVisible();
  await expect
    .element(addForm().getByRole("button", { name: "Add skill", exact: true }))
    .toBeEnabled();
  expect((await list(server)).skills).toEqual([existing]);
  await expect.element(name).toHaveValue(builtin.name);
  await expect.element(instructions).toHaveValue("Keep my carefully written instructions.");
  await name.fill("review-notes");
  await addForm().getByRole("button", { name: "Add skill", exact: true }).click();
  await expect.element(addForm().getByRole("alert")).toBeVisible();
  await expect
    .element(addForm().getByRole("button", { name: "Add skill", exact: true }))
    .toBeEnabled();
  await expect.element(name).toHaveValue(existing.name);
  expect((await list(server)).skills).toEqual([existing]);
  await expect.element(instructions).toHaveValue("Keep my carefully written instructions.");
  await name.fill("my-review");
  await addForm().getByRole("button", { name: "Add skill", exact: true }).click();
  await expect.element(row("my-review")).toBeVisible();
  expect((await list(server)).skills.find((skill) => skill.name === "my-review")).toMatchObject({
    description: "",
    body: "Keep my carefully written instructions.",
  });
});

test("a failed save retains all edits and a retry persists the same draft", async () => {
  const server = await TestServer.start({ world: true });
  const { skill } = await create(server);
  let fail = true;
  server.on("PUT", "/api/account/skills/:id", ({ body }) =>
    fail
      ? reply({ error: "Skill storage is temporarily unavailable." }, 503)
      : server.call("PUT", `/api/account/skills/${skill.id}`, body),
  );
  renderApp("/settings/skills");
  await row(skill.name)
    .getByRole("button", { name: `Edit /${skill.name}`, exact: true })
    .click();
  const form = page.getByRole("form", { name: `Edit /${skill.name}`, exact: true });
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("revised-review");
  await form.getByRole("textbox", { name: "Description (optional)" }).fill("");
  await form
    .getByRole("textbox", { name: "Markdown instructions" })
    .fill("Do not discard this draft.");
  const enabled = form.getByRole("checkbox", { name: "Enabled", exact: true });
  await expect.element(enabled).toBeChecked();
  await enabled.click();
  await expect.element(enabled).not.toBeChecked();
  await form.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect.element(row(skill.name).getByRole("alert")).toBeVisible();
  await expect
    .element(form.getByRole("textbox", { name: "Name", exact: true }))
    .toHaveValue("revised-review");
  await expect
    .element(form.getByRole("textbox", { name: "Description (optional)" }))
    .toHaveValue("");
  await expect
    .element(form.getByRole("textbox", { name: "Markdown instructions" }))
    .toHaveValue("Do not discard this draft.");
  await expect
    .element(form.getByRole("checkbox", { name: "Enabled", exact: true }))
    .not.toBeChecked();
  expect((await list(server)).skills[0]).toMatchObject(skill);
  fail = false;
  await form.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect.element(row("revised-review")).toBeVisible();
  expect((await list(server)).skills[0]).toMatchObject({
    id: skill.id,
    description: "",
    body: "Do not discard this draft.",
    enabled: false,
  });
});

test("loading failure can be retried and a failed remove remains recoverable in its confirmation", async () => {
  const server = await TestServer.start({ world: true });
  const { skill } = await create(server);
  let failLoad = true;
  let failRemove = true;
  server.on("GET", "/api/account/skills", () =>
    failLoad ? reply({ error: "Could not read your skills." }, 503) : list(server),
  );
  server.on("DELETE", "/api/account/skills/:id", async () => {
    if (failRemove) return reply({ error: "Could not remove this skill." }, 503);
    await server.call("DELETE", `/api/account/skills/${skill.id}`);
    return reply(null, 204);
  });
  renderApp("/settings/skills");
  await expect.element(page.getByRole("alert")).toBeVisible();
  failLoad = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.element(row(skill.name)).toBeVisible();
  await row(skill.name)
    .getByRole("button", { name: `Remove /${skill.name}` })
    .click();
  const dialog = page.getByRole("dialog", { name: `Remove /${skill.name}?` });
  await dialog.getByRole("button", { name: "Remove skill", exact: true }).click();
  await expect.element(dialog.getByRole("alert")).toBeVisible();
  expect((await list(server)).skills).toHaveLength(1);
  failRemove = false;
  await dialog.getByRole("button", { name: "Remove skill", exact: true }).click();
  await expect.element(page.getByText(/No personal skills yet/)).toBeVisible();
});

for (const theme of ["light", "dark"]) {
  test(`personal skills are reachable from Profile and mobile settings in ${theme} theme`, async () => {
    const oldTheme = localStorage.getItem("gitmatrix.theme");
    const size = { width: window.innerWidth, height: window.innerHeight };
    onTestFinished(async () => {
      if (oldTheme === null) localStorage.removeItem("gitmatrix.theme");
      else localStorage.setItem("gitmatrix.theme", oldTheme);
      await page.viewport(size.width, size.height);
    });
    localStorage.setItem("gitmatrix.theme", theme);
    await page.viewport(320, 720);
    await TestServer.start({ world: true });
    const app = renderApp("/settings/profile");
    await page.getByRole("link", { name: "Manage assistant skills" }).click();
    await app.waitForUrl((url) => url.pathname === "/settings/skills");
    await expect
      .element(page.getByRole("heading", { name: "Assistant skills", exact: true, level: 1 }))
      .toBeVisible();
    await page.getByText("Settings /", { exact: true }).click();
    await expect
      .element(page.getByRole("link", { name: "Assistant skills", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await app.waitForUrl((url) => url.pathname === "/settings/profile");
    await page.getByRole("link", { name: "Manage assistant skills" }).click();
    await expect
      .element(addForm().getByRole("textbox", { name: "Name", exact: true }))
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await focusOn(addForm().getByRole("textbox", { name: "Name", exact: true }));
    await press("Tab");
    await expect
      .element(addForm().getByRole("textbox", { name: "Description (optional)" }))
      .toHaveFocus();
  });
}
