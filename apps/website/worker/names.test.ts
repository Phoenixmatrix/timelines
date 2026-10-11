import { expect, test } from "vite-plus/test";
import { slugProblem } from "./names.ts";

test("the global highlights page cannot be claimed as an account", () => {
  expect(slugProblem("highlights")).not.toBeNull();
  expect(slugProblem("highlights-team")).toBeNull();
});
