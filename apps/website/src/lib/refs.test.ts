import { expect, test } from "vite-plus/test";
import { encodePath, treeUrl } from "./refs.ts";

test("URLs keep slashes but encode each segment", () => {
  expect(encodePath("docs/a b#1.md")).toBe("docs/a%20b%231.md");
  expect(treeUrl("orbit", "engine", "jun/feature", "src")).toBe(
    "/orbit/engine/tree/jun/feature/src",
  );
});
