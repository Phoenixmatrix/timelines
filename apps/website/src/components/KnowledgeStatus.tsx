import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import type { KnowledgeStatus } from "../../shared/api.ts";
import { api } from "../lib/api.ts";
import { timeAgo } from "../lib/format.ts";

const PHASES: Record<string, string> = {
  queued: "Starting",
  snapshot: "Reading files",
  analyze: "Analyzing changed files",
  graph: "Updating the graph",
  align: "Linking concepts",
  synthesize: "Summarizing components",
  atlas: "Mapping the atlas",
  index: "Updating search indexes",
  wiki: "Rewriting affected pages",
};

/** "14:05", local time: when a pending update starts. */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * What Knowledge reflects while pushes wait for their update (CORE-286):
 * "Reflects abc1234 · 3 pushes pending · update at ~14:05".
 */
export function describePending(status: KnowledgeStatus): string {
  const pending = status.pending;
  const parts = [
    status.indexedCommit ? `Reflects ${status.indexedCommit.slice(0, 7)}` : "Not built yet",
  ];
  if (pending) {
    parts.push(`${pending.pushes} ${pending.pushes === 1 ? "push" : "pushes"} pending`);
    if (pending.dueAt) {
      const soon = new Date(pending.dueAt).getTime() - Date.now() < 60_000;
      parts.push(soon ? "updating shortly" : `update at ~${clock(pending.dueAt)}`);
    }
  } else parts.push("update queued");
  return parts.join(" · ");
}

function describe(status: KnowledgeStatus): string {
  switch (status.state) {
    case "building": {
      const current = status.current;
      const phase = PHASES[current?.phase ?? "queued"] ?? "Updating";
      const s = current?.stats ?? {};
      if (current?.phase === "analyze" && typeof s.toAnalyze === "number" && s.toAnalyze > 0) {
        return `${phase} (${Number(s.analyzeDone ?? 0)}/${s.toAnalyze})`;
      }
      if (current?.phase === "wiki" && typeof s.wikiPages === "number" && s.wikiPages > 0) {
        return `${phase} (${Number(s.wikiDone ?? 0)}/${s.wikiPages})`;
      }
      return phase;
    }
    case "queued":
      return describePending(status);
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
 * revalidates the page when the graph changes or the build finishes, so new
 * content appears on its own.
 */
export function useKnowledgeStatus(space: string, name: string, initial: KnowledgeStatus) {
  const [status, setStatus] = useState(initial);
  const revalidator = useRevalidator();
  const wasBusy = useRef(initial.state === "building" || initial.state === "queued");

  useEffect(() => setStatus(initial), [initial]);

  useEffect(() => {
    const busy = status.state === "building" || status.state === "queued";
    if (!busy) return;
    // A pending update minutes away is checked every half minute, not every two seconds.
    const dueAt = status.state === "queued" ? status.pending?.dueAt : null;
    const later = dueAt && new Date(dueAt).getTime() - Date.now() > 60_000;
    const timer = setTimeout(
      async () => {
        try {
          const next = await api<KnowledgeStatus>(`/repos/${space}/${name}/knowledge/status`);
          setStatus(next);
          const nowBusy = next.state === "building" || next.state === "queued";
          // A build writes the graph and wiki pages long before it finishes: show
          // each as it lands.
          const landed =
            next.graphVersion !== status.graphVersion ||
            next.current?.stats.wikiDone !== status.current?.stats.wikiDone;
          if ((wasBusy.current && !nowBusy) || landed) void revalidator.revalidate();
          wasBusy.current = nowBusy;
        } catch {
          // Try again on the next tick.
          setStatus((s) => ({ ...s }));
        }
      },
      later ? 30_000 : 2000,
    );
    return () => clearTimeout(timer);
  }, [status, space, name, revalidator]);

  return status;
}

export function KnowledgeStatusPill({
  status,
  repo,
}: {
  status: KnowledgeStatus;
  /** Given, a repository admin can start a pending update now (CORE-286). */
  repo?: { space: string; name: string };
}) {
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
  const [asked, setAsked] = useState<"idle" | "asking" | "asked" | "failed">("idle");
  const canUpdate =
    repo && status.canUpdate && status.state === "queued" && status.pending && asked !== "asked";
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-flex items-center gap-2 rounded-full bg-raised px-3 py-1 text-body-sm text-ink-muted"
        title={failure ?? (status.indexedAt ? `Indexed ${timeAgo(status.indexedAt)}` : undefined)}
        role="status"
        aria-live="polite"
      >
        <span className={`size-2 rounded-full ${dot}`} aria-hidden />
        {asked === "asked" && status.state === "queued" ? "Updating shortly" : describe(status)}
      </span>
      {canUpdate && (
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm"
          disabled={asked === "asking"}
          title={asked === "failed" ? "Couldn't start the update; try again" : undefined}
          onClick={async () => {
            setAsked("asking");
            try {
              await api(`/repos/${repo.space}/${repo.name}/knowledge/update`, { method: "POST" });
              setAsked("asked");
            } catch {
              setAsked("failed");
            }
          }}
        >
          Update now
        </button>
      )}
    </span>
  );
}
