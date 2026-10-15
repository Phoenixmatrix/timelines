import { vi } from "vite-plus/test";

/**
 * Settles `run` while fake timers stand in for setTimeout and setInterval,
 * advancing them `step` ms at a time: a retry pause or poll interval in the
 * code under test takes no real time. Date stays real (spy on it to move it).
 */
export async function withoutWaiting<T>(run: () => Promise<T>, step = 100): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const running = run();
    let settled = false;
    running.then(
      () => (settled = true),
      () => (settled = true),
    );
    while (!settled) {
      // Let real I/O and immediates run before moving the clock again.
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(step);
    }
    return await running;
  } finally {
    vi.useRealTimers();
  }
}
