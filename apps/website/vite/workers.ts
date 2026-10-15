// Worker caps for the two Vitest projects (CORE-406). Each project sizes its own
// pool, so the memory-hungry browser project doesn't throttle the unit project.

const MiB = 2 ** 20;
const UNIT_WORKER_MEMORY = 600 * MiB;
const UNIT_WORKER_CAP = 6;

// Node unit tests are CPU-bound: a quarter of the CPUs, which leaves a shared
// host room for other agents, but on a small host (a 4-vCPU CI container) all
// but one CPU up to three, since a quarter there is a single serial worker.
// As many as free memory carries, never fewer than one nor more than the cap.
// `reserveBytes` is memory
// another process sizing itself from the same reading will take (the browser
// project when `vp run test` runs both at once).
export function unitWorkers(cpus: number, availableBytes: number, reserveBytes = 0): number {
  const byCpu = Math.max(Math.floor(cpus / 4), Math.min(cpus - 1, 3));
  const byMemory = Math.floor(Math.max(0, availableBytes - reserveBytes) / UNIT_WORKER_MEMORY);
  return Math.max(1, Math.min(UNIT_WORKER_CAP, byCpu, byMemory));
}

/** The reserve a concurrent run asks the unit project to leave (GITMATRIX_TEST_MEMORY_RESERVE_BYTES). */
export function memoryReserve(env: Record<string, string | undefined>): number {
  const value = Number(env.GITMATRIX_TEST_MEMORY_RESERVE_BYTES);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
