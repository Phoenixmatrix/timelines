import { setTimeout as delay } from "node:timers/promises";

export interface IndexedItem {
  id: string;
  key: string;
  status: string;
}
export interface VisibilityTarget {
  repo: string;
  key: string;
  path: string;
  symbolId: string;
  fileId: string;
}
export interface SearchResult {
  entities: { id: string }[];
  passages: { kind: string; path: string; text: string }[];
}
export interface VisibilityAttempt {
  attempt: number;
  elapsedMs: number;
  entityFound: boolean;
  passageFound: boolean;
}
export interface VisibilityReport {
  target: VisibilityTarget;
  timeoutMs: number;
  outcome: "running" | "passed" | "failed";
  elapsedMs: number;
  itemChecks: { elapsedMs: number; item: IndexedItem | null }[];
  attempts: VisibilityAttempt[];
  missing: string[];
}

/** Separate cheap item-status observations from paid, consumer-visible retrieval. */
export async function waitForIndexVisibility({
  target,
  item,
  search,
  report,
  timeoutMs = 10 * 60_000,
  pollMs = 20_000,
  retrievalDelays = [0, 20_000, 40_000, 60_000, 80_000, 100_000],
  now = () => performance.now(),
  sleep = delay,
}: {
  target: VisibilityTarget;
  item: (remainingMs: number) => Promise<IndexedItem | null>;
  search: (remainingMs: number) => Promise<SearchResult>;
  report: VisibilityReport;
  timeoutMs?: number;
  pollMs?: number;
  retrievalDelays?: number[];
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<void> {
  if (!(timeoutMs > 0) || !(pollMs > 0) || !retrievalDelays.length)
    throw new Error("Visibility wait requires positive bounds and at least one retrieval");
  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const remaining = () => Math.max(0, timeoutMs - elapsed());
  Object.assign(report, {
    target,
    timeoutMs,
    outcome: "running",
    elapsedMs: 0,
    itemChecks: [],
    attempts: [],
    missing: ["Vectorize entity", "AI Search source passage"],
  });
  const fail = (reason: string): never => {
    report.outcome = "failed";
    report.elapsedMs = elapsed();
    const last = report.itemChecks.at(-1)?.item;
    throw new Error(
      `Index visibility failed for ${target.repo} ${target.key} (item ${last?.id ?? "not found"}, status ${last?.status ?? "missing"}) after ${report.elapsedMs}ms; ${reason}; missing: ${report.missing.join(", ")}`,
    );
  };
  const pause = async (ms: number) => {
    if (ms > 0) await sleep(Math.min(ms, remaining()));
    if (remaining() === 0) fail("deadline exceeded");
  };
  try {
    while (remaining() > 0) {
      const current = await item(remaining());
      report.itemChecks.push({ elapsedMs: elapsed(), item: current });
      if (remaining() === 0) fail("deadline exceeded while reading item status");
      if (current?.key !== undefined && current.key !== target.key)
        fail("item status returned a different key");
      if (current?.status === "completed") break;
      if (current?.status === "error" || current?.status === "skipped")
        fail("provider reported a terminal indexing failure");
      await pause(pollMs);
    }
    for (const [index, wait] of retrievalDelays.entries()) {
      // Reserve the last bounded call for the end of the shared visibility
      // window; Vectorize can lag even after AI Search reports completion.
      const finalProbe = index > 0 && index === retrievalDelays.length - 1;
      await pause(finalProbe ? Math.max(0, remaining() - 30_000) : wait);
      const result = await search(remaining());
      const entityFound = result.entities.some(
        (entity) => entity.id === target.symbolId || entity.id === target.fileId,
      );
      const passageFound = result.passages.some(
        (passage) =>
          passage.kind === "code" &&
          passage.path === target.path &&
          passage.text.includes("copperFinchChecksum") &&
          passage.text.includes("65521"),
      );
      report.attempts.push({
        attempt: report.attempts.length + 1,
        elapsedMs: elapsed(),
        entityFound,
        passageFound,
      });
      report.missing = [
        ...(!entityFound ? ["Vectorize entity"] : []),
        ...(!passageFound ? ["AI Search source passage"] : []),
      ];
      if (remaining() === 0) fail("deadline exceeded during retrieval");
      // Both invariants must be true in the same consumer response.
      if (entityFound && passageFound) {
        report.outcome = "passed";
        report.elapsedMs = elapsed();
        return;
      }
    }
    fail("retrieval attempts exhausted after indexing completed");
  } catch (error) {
    if (report.outcome === "failed") throw error;
    // Provider/transport failures stay failures; don't leak provider diagnostics or credentials.
    fail("provider observation failed");
  }
}
