// When builds last used the shared analysis caches (CORE-201): the cheap
// "last referenced" signal the "analysis-caches" retention category reads
// (worker/retention/cleanups/analysis-caches.ts).
//
// Reading an entry (loadAnalyses, cached) writes its `used_at` only when the
// stored time is more than a day old, so a build writes each entry it uses at
// most once a day and usually not at all; storing an entry stamps it. A null
// `used_at` means the entry hasn't been used since the column was added:
// USED_SINCE stands in for it.

/** When `used_at` was added; a null `used_at` counts as used then. */
export const USED_SINCE = "2026-10-04T00:00:00.000Z";

/** How stale `used_at` may get before a use writes it again. */
export const USE_REFRESH_MS = 86_400_000;

/** Whether a use at `now` should record itself. */
export function useIsStale(usedAt: string | null, now: Date): boolean {
  return (usedAt ?? USED_SINCE) < new Date(now.getTime() - USE_REFRESH_MS).toISOString();
}
