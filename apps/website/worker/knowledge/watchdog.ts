// When the coordinator gives up on a running build. Builds are judged by
// progress (each finished step records progress_at), not by how long they've
// run: a first build of a large repository takes far longer than a push.

/**
 * A build that finishes no step for this long is presumed hung: terminated and
 * retried. Room for a step to time out (15 minutes) and run once more.
 */
const STALL_MS = 40 * 60_000;
/** …and no build runs longer than this in all, which bounds what one can spend. */
const MAX_BUILD_MS = 6 * 60 * 60_000;

/** Whether a running build still counts as alive: it must keep finishing steps. */
export function watchdog(
  now: number,
  startedAt: number,
  progressAt: string | null,
): "running" | "stalled" | "overdue" {
  if (now - startedAt > MAX_BUILD_MS) return "overdue";
  const progressed = Math.max(startedAt, progressAt ? Date.parse(progressAt) : 0);
  return now - progressed > STALL_MS ? "stalled" : "running";
}
