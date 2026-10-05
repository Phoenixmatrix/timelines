// The quiet period for a timeline's heavy work (CORE-238): full CI and
// knowledge overlays run for a timeline's latest head once its pushes have
// paused this long, or right away on a checkpoint, never once per step.
// Step runs and step context are never delayed.

/** The default, ten minutes. */
export const TIMELINE_QUIET_SECONDS = 600;

/**
 * The quiet period in milliseconds. Development environments may shorten it
 * (`GITMATRIX_TIMELINE_QUIET_SECONDS`, the TIMELINE_QUIET_SECONDS text
 * binding); deployed Workers use the default.
 */
export function timelineQuietMs(env: Env): number {
  const raw = Reflect.get(env, "TIMELINE_QUIET_SECONDS");
  const seconds = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : TIMELINE_QUIET_SECONDS) * 1000;
}
