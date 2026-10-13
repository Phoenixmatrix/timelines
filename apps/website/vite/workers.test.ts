import { describe, expect, test } from "vite-plus/test";
import { memoryReserve, unitWorkers } from "./workers.ts";

const GiB = 2 ** 30;

describe("unitWorkers (CORE-406)", () => {
  test("low memory falls back to one worker", () => {
    expect(unitWorkers(24, 0.3 * GiB)).toBe(1);
    expect(unitWorkers(24, 0)).toBe(1);
  });

  test("typical hosts get several workers", () => {
    expect(unitWorkers(24, 3.7 * GiB)).toBe(6);
    expect(unitWorkers(8, 10 * GiB)).toBe(2);
    expect(unitWorkers(24, 2 * GiB)).toBe(3);
  });

  test("never exceeds six, nor drops below one", () => {
    expect(unitWorkers(128, 64 * GiB)).toBe(6);
    expect(unitWorkers(2, 64 * GiB)).toBe(1);
    expect(unitWorkers(24, Infinity)).toBe(6);
  });
});

describe("memory reserve for a concurrent browser run (CORE-406)", () => {
  test("the unit project subtracts the reserve before dividing", () => {
    expect(unitWorkers(24, 6 * GiB)).toBe(6);
    expect(unitWorkers(24, 6 * GiB, 3 * GiB)).toBe(5);
    expect(unitWorkers(24, 3 * GiB, 3 * GiB)).toBe(1);
    expect(unitWorkers(24, 1 * GiB, 3 * GiB)).toBe(1);
  });

  test("the reserve comes from the environment, and bad values mean none", () => {
    expect(memoryReserve({ GITMATRIX_TEST_MEMORY_RESERVE_BYTES: String(3 * GiB) })).toBe(3 * GiB);
    expect(memoryReserve({})).toBe(0);
    expect(memoryReserve({ GITMATRIX_TEST_MEMORY_RESERVE_BYTES: "nope" })).toBe(0);
    expect(memoryReserve({ GITMATRIX_TEST_MEMORY_RESERVE_BYTES: "-5" })).toBe(0);
  });
});
