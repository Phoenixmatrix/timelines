import { expect, test } from "vite-plus/test";
import { watchdog } from "./watchdog.ts";

const MIN = 60_000;
const start = Date.parse("2026-10-02T12:00:00Z");
const at = (minutes: number) => new Date(start + minutes * MIN).toISOString();

test("the watchdog stops builds that stop finishing steps, not builds that run long", () => {
  // No step finished yet: judged from the start.
  expect(watchdog(start + 30 * MIN, start, null)).toBe("running");
  expect(watchdog(start + 41 * MIN, start, null)).toBe("stalled");
  // Two hours in, but a step finished ten minutes ago.
  expect(watchdog(start + 120 * MIN, start, at(110))).toBe("running");
  expect(watchdog(start + 160 * MIN, start, at(110))).toBe("stalled");
  // Progress or not, no build runs past the overall cap.
  expect(watchdog(start + 361 * MIN, start, at(360))).toBe("overdue");
});
