// Settings → AI providers (CORE-294): an account owner connects OpenRouter
// with their own key, finds a model by searching its catalog, adds it, and
// chooses it in AI settings; models in use can't be removed. TypeSafe and
// OpenRouter are the in-memory fakes in worker/testing/ai-providers.ts.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { AiProvidersView, AiSettingsView } from "../../shared/ai.ts";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";
import { searchModels } from "./AiProviders.tsx";

async function choose(name: string, option: string) {
  await userEvent.click(page.getByRole("combobox", { name }));
  await userEvent.click(page.getByRole("option", { name: option, exact: true }));
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
}

test("an owner connects OpenRouter, adds a model from search and uses it for Fast work", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  const app = renderApp("/settings/ai-providers?owner=orbit");
  await expect.element(page.getByRole("heading", { name: "AI providers", level: 1 })).toBeVisible();
  const openRouter = page.getByRole("region", { name: "OpenRouter" });
  await expect.element(openRouter.getByText("Not connected")).toBeVisible();

  await userEvent.fill(openRouter.getByLabelText("OpenRouter API key"), "sk-or-v1-browser-9999");
  await userEvent.click(openRouter.getByRole("button", { name: "Connect" }));
  await expect.element(openRouter.getByText(/Connected OpenRouter/)).toBeVisible();
  await expect.element(openRouter.getByText(/key ending 9999 · by @marco/)).toBeVisible();
  // The key field goes away until a replacement is asked for, and the key is never sent back.
  await expect.element(openRouter.getByLabelText(/API key/)).not.toBeInTheDocument();
  await userEvent.click(openRouter.getByRole("button", { name: "Replace key" }));
  await expect.element(openRouter.getByLabelText("New OpenRouter API key")).toHaveValue("");
  await userEvent.click(openRouter.getByRole("button", { name: "Keep current key" }));
  const stored = await server.call<AiProvidersView>("GET", "/api/accounts/orbit/ai-providers");
  expect(JSON.stringify(stored)).not.toContain("browser-9999");

  // The catalog offers only text models, searchable by name or id.
  const search = openRouter.getByLabelText("Search OpenRouter models");
  await expect.element(openRouter.getByText("4 models.")).toBeVisible();
  await expect
    .element(openRouter.getByRole("link", { name: /GPT Image 2/ }))
    .not.toBeInTheDocument();
  await userEvent.fill(search, "gemini");
  await expect.element(openRouter.getByText("1 model.")).toBeVisible();
  await userEvent.fill(search, "no such model");
  await expect
    .element(openRouter.getByText("No OpenRouter text models match “no such model”."))
    .toBeVisible();
  await userEvent.fill(search, "google/gem");
  await userEvent.click(openRouter.getByRole("button", { name: "Add Google: Gemini 3 Flash" }));
  await expect.element(openRouter.getByText(/Added Google: Gemini 3 Flash/)).toBeVisible();
  await expect
    .element(openRouter.getByRole("button", { name: "Google: Gemini 3 Flash added" }))
    .toBeDisabled();
  // Every published price, per million tokens.
  await expect
    .element(
      openRouter
        .getByRole("listitem")
        .filter({ hasText: "Prices checked" })
        .getByText("$0.30 input / $2.50 output / $0.075 cached input / $2.50 reasoning"),
    )
    .toBeVisible();

  // AI settings offers it for Fast and Task (not Classification), with its provider named.
  await userEvent.click(page.getByRole("link", { name: "AI settings", exact: true }).first());
  await app.waitForUrl((url) => url.pathname === "/settings/ai");
  await choose("Fast model", "Google: Gemini 3 Flash (OpenRouter)");
  await userEvent.click(page.getByRole("button", { name: "Save AI settings" }));
  await expect.element(page.getByText(/AI settings saved for @orbit/)).toBeVisible();
  const settings = await server.call<AiSettingsView>("GET", "/api/accounts/orbit/settings/ai");
  expect(settings.models.fast).toBe("openrouter:google/gemini-3-flash");
  expect(settings.catalog.classification.map((option) => option.id)).not.toContain(
    "openrouter:google/gemini-3-flash",
  );

  // In use, it can't be removed, and the provider can't be disconnected.
  await userEvent.click(page.getByRole("link", { name: "AI providers", exact: true }).first());
  await app.waitForUrl((url) => url.pathname === "/settings/ai-providers");
  await expect.element(openRouter.getByText("Used for Fast")).toBeVisible();
  await expect
    .element(openRouter.getByRole("button", { name: "Remove Google: Gemini 3 Flash" }))
    .toBeDisabled();
  await expect.element(openRouter.getByText("Choose another Fast model first")).toBeVisible();
  await expect
    .element(openRouter.getByRole("button", { name: "Disconnect OpenRouter" }))
    .toBeDisabled();
});

test("TypeSafe's refused key saves nothing; Jev becomes a Classification choice once added", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  renderApp("/settings/ai-providers?owner=orbit");
  const typeSafe = page.getByRole("region", { name: "TypeSafe" });
  await userEvent.fill(typeSafe.getByLabelText("TypeSafe API key"), "wrong-key-1234");
  await userEvent.click(typeSafe.getByRole("button", { name: "Connect" }));
  await expect.element(typeSafe.getByRole("alert")).toBeVisible();
  await expect.element(typeSafe.getByText("Not connected")).toBeVisible();

  await userEvent.fill(typeSafe.getByLabelText("TypeSafe API key"), "ts-browser-key-5678");
  await userEvent.click(typeSafe.getByRole("button", { name: "Connect" }));
  await expect.element(typeSafe.getByText(/key ending 5678/)).toBeVisible();
  // No search for one model: Jev is simply offered.
  await expect.element(typeSafe.getByLabelText("Search TypeSafe models")).not.toBeInTheDocument();
  await userEvent.click(typeSafe.getByRole("button", { name: "Add Jev" }));
  await expect.element(typeSafe.getByText("$0.042 input / $0.00 output")).toBeVisible();
  // Nothing left to add.
  await expect
    .element(typeSafe.getByRole("heading", { name: "Add models" }))
    .not.toBeInTheDocument();
  const settings = await server.call<AiSettingsView>("GET", "/api/accounts/orbit/settings/ai");
  expect(settings.catalog.classification.map((option) => option.id)).toContain(
    "typesafe:jev-latest",
  );
  expect(settings.catalog.fast.some((option) => option.provider)).toBe(false);
});

test("an organization member sees the account's providers read-only", async () => {
  const server = await TestServer.start({ world: true, persona: "marco" });
  await server.call("PUT", "/api/accounts/orbit/ai-providers/openrouter", {
    apiKey: "sk-or-v1-owner-4321",
  });
  await server.call("POST", "/api/accounts/orbit/ai-providers/openrouter/models", {
    model: "anthropic/claude-sonnet-5",
  });
  await server.as("jun");
  renderApp("/settings/ai-providers?owner=orbit");
  await expect.element(page.getByText(/Read-only access/)).toBeVisible();
  const openRouter = page.getByRole("region", { name: "OpenRouter" });
  await expect.element(openRouter.getByText(/key ending 4321/)).toBeVisible();
  await expect
    .element(openRouter.getByRole("link", { name: /^Anthropic: Claude Sonnet 5/ }))
    .toBeVisible();
  await expect.element(openRouter.getByLabelText(/API key/)).not.toBeInTheDocument();
  await expect
    .element(openRouter.getByRole("button", { name: /Remove|Add|Disconnect/ }))
    .not.toBeInTheDocument();
});

test("search ranks name matches first and can sort by price or recency", () => {
  const entry = (model: string, name: string, input: number, releasedAt: string) => ({
    id: `openrouter:${model}` as const,
    model,
    name,
    description: "",
    provider: "openrouter" as const,
    capability: "generation" as const,
    releasedAt,
    inputUsdPerMillion: input,
    outputUsdPerMillion: 0,
    contextLength: null,
    jsonMode: true,
    url: "",
  });
  const models = [
    entry("x/flash-lite", "Vendor X: Lite", 0.1, "2026-01-01"),
    entry("google/gemini-3-flash", "Google: Gemini 3 Flash", 0.3, "2026-03-01"),
    entry("z/zeta", "Zeta Flash", 0.2, "2026-02-01"),
  ];
  const ids = (sort: "name" | "newest" | "cheapest", query = "flash") =>
    searchModels(models, query, sort).map((model) => model.model);
  // Name matches before id-only ones; equally good matches by name.
  expect(ids("name")).toEqual(["google/gemini-3-flash", "z/zeta", "x/flash-lite"]);
  expect(ids("cheapest")).toEqual(["x/flash-lite", "z/zeta", "google/gemini-3-flash"]);
  expect(ids("newest")).toEqual(["google/gemini-3-flash", "z/zeta", "x/flash-lite"]);
  expect(ids("name", "google gemini")).toEqual(["google/gemini-3-flash"]);
});
