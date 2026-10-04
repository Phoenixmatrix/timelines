// Cleanups by category id (CORE-198). A category without an entry here can be
// configured but never runs: scheduled runs skip it and manual runs refuse it.
// To add one, implement CategoryCleanup (worker/retention/engine.ts, following
// preview-records.ts) in its own file and register it below.

import type { CategoryId } from "../categories.ts";
import type { CategoryCleanup } from "../engine.ts";
import { ciLogs } from "./ci-logs.ts";
import { ciRuns } from "./ci-runs.ts";
import { previewRecords } from "./preview-records.ts";
import { closedIssues, trackerActivity } from "./tracker.ts";

// Items are opaque to the engine: each cleanup gets back what it selected.
// oxlint-disable-next-line typescript/no-explicit-any
const CLEANUPS: Partial<Record<CategoryId, CategoryCleanup<any>>> = {
  "ci-logs": ciLogs,
  "ci-runs": ciRuns,
  "preview-records": previewRecords,
  "closed-issues": closedIssues,
  "tracker-activity": trackerActivity,
};

export function cleanupFor(id: string): CategoryCleanup | undefined {
  return CLEANUPS[id as CategoryId];
}
