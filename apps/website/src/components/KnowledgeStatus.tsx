import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import type { KnowledgeStatus } from "../../shared/api.ts";
import { api } from "../lib/api.ts";
import { timeAgo } from "../lib/format.ts";

const PHASES: Record<string, string> = {
  queued: "Starting",
  snapshot: "Reading files",
  analyze: "Analyzing changed files",
  align: "Linking concepts",
  synthesize: "Summarizing components",
  index: "Updating search indexes",
  wiki: "Rewriting affected pages",
};

function describe(status: KnowledgeStatus): string {
  switch (status.state) {
    case "building": {
      const current = status.current;
      const phase = PHASES[current?.phase ?? "queued"] ?? "Updating";
      const s = current?.stats ?? {};
      if (current?.phase === "analyze" && typeof s.toAnalyze === "number" && s.toAnalyze > 0) {
        return `${phase} (${Number(s.analyzeDone ?? 0)}/${s.toAnalyze})`;
      }
      return phase;
    }
    case "queued":
      return "Update queued";
    case "failed":
      return "Last update failed";
    case "empty":
      return "Not built yet";
    default:
      return `Up to date with ${status.indexedCommit?.slice(0, 7)}`;
  }
}

/**
 * Live status of a repository's knowledge graph. Polls while a build runs and
 * revalidates the page once it finishes, so new content appears on its own.
 */
export function useKnowledgeStatus(owner: string, name: string, initial: KnowledgeStatus) {
  const [status, setStatus] = useState(initial);
  const revalidator = useRevalidator();
  const wasBusy = useRef(initial.state === "building" || initial.state === "queued");

  useEffect(() => setStatus(initial), [initial]);

  useEffect(() => {
    const busy = status.state === "building" || status.state === "queued";
    if (!busy) return;
    const timer = setTimeout(async () => {
      try {
        const next = await api<KnowledgeStatus>(`/repos/${owner}/${name}/knowledge/status`);
        setStatus(next);
        const nowBusy = next.state === "building" || next.state === "queued";
        if (wasBusy.current && !nowBusy) void revalidator.revalidate();
        wasBusy.current = nowBusy;
      } catch {
        // Try again on the next tick.
        setStatus((s) => ({ ...s }));
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [status, owner, name, revalidator]);

  return status;
}

export function KnowledgeStatusPill({ status }: { status: KnowledgeStatus }) {
  const busy = status.state === "building" || status.state === "queued";
  const dot = busy
    ? "bg-signal-line animate-pulse"
    : status.state === "failed"
      ? "bg-danger-text"
      : status.state === "up-to-date"
        ? "bg-online"
        : "bg-ink-faint";
  // Why the last update failed; it retries on the next push.
  const failure = status.state === "failed" ? status.recent[0]?.error : null;
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full bg-raised px-3 py-1 text-body-sm text-ink-muted"
      title={failure ?? (status.indexedAt ? `Indexed ${timeAgo(status.indexedAt)}` : undefined)}
      role="status"
      aria-live="polite"
    >
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      {describe(status)}
    </span>
  );
}
