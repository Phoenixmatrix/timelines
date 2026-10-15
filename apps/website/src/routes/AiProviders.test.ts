import { expect, test } from "vite-plus/test";
import { searchModels } from "./AiProviders.tsx";

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
