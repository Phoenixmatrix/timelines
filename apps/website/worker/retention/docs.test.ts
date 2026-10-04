// The README documents every retention category from the registry (CORE-211).

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { CATEGORIES } from "./categories.ts";
import { categoriesMarkdown, README, withCategories } from "./docs.ts";

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

describe("README retention categories", () => {
  const readme = readFileSync(README, "utf8");

  test("match the registry (regenerate: node apps/website/worker/retention/docs.ts)", () => {
    expect(squash(withCategories(readme))).toBe(squash(readme));
  });

  test("name every category with its scope, defaults and what it never deletes", () => {
    const section = categoriesMarkdown();
    for (const c of CATEGORIES) {
      expect(section).toContain(`\`${c.id}\``);
      for (const t of c.thresholds) expect(squash(section)).toContain(`${t.label}: ${t.default}`);
      for (const never of c.never) expect(squash(section)).toContain(squash(never.slice(1)));
    }
  });
});
