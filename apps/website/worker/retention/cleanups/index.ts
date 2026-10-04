// Cleanups by category id (CORE-198). A category without an entry here can be
// configured but never runs: scheduled runs skip it and manual runs refuse it.
// To add one, implement CategoryCleanup (worker/retention/engine.ts, following
// preview-records.ts) in its own file and register it below.

import type { CategoryId } from "../categories.ts";
import type { CategoryCleanup } from "../engine.ts";
import { ciLogs } from "./ci-logs.ts";
import { ciRuns } from "./ci-runs.ts";
import { aiSpend } from "./ai-spend.ts";
import { analysisCaches } from "./analysis-caches.ts";
import { endedTimelineData } from "./ended-timeline-data.ts";
import { knowledgeBuilds } from "./knowledge-builds.ts";
import { assistantChats } from "./assistant-chats.ts";
import { previewRecords } from "./preview-records.ts";
import { aiUsage, durableRegistry, usageHistory } from "./usage.ts";
import { closedIssues, trackerActivity } from "./tracker.ts";
import { registryAudit, registryProxyCache } from "./registry.ts";
import { authHygiene } from "./auth-hygiene.ts";
import { releaseNotes } from "./release-notes.ts";
import { pushLog } from "./push-log.ts";
import { timelineWorkSources } from "./work-sources.ts";

// Items are opaque to the engine: each cleanup gets back what it selected.
// oxlint-disable-next-line typescript/no-explicit-any
const CLEANUPS: Partial<Record<CategoryId, CategoryCleanup<any>>> = {
  "ci-logs": ciLogs,
  "ci-runs": ciRuns,
  "preview-records": previewRecords,
  "usage-history": usageHistory,
  "ai-usage": aiUsage,
  "durable-registry": durableRegistry,
  "closed-issues": closedIssues,
  "tracker-activity": trackerActivity,
  "timeline-work-sources": timelineWorkSources,
  "registry-proxy-cache": registryProxyCache,
  "registry-audit": registryAudit,
  "knowledge-builds": knowledgeBuilds,
  "ended-timeline-data": endedTimelineData,
  "analysis-caches": analysisCaches,
  "ai-spend": aiSpend,
  "assistant-chats": assistantChats,
  "release-notes": releaseNotes,
  "auth-hygiene": authHygiene,
  "push-log": pushLog,
};

export function cleanupFor(id: string): CategoryCleanup | undefined {
  return CLEANUPS[id as CategoryId];
}
