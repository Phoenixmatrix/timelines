// What the Knowledge tab keeps around the Atlas after the cutover (CORE-174):
// the timeline picker (CORE-83), the wiki, live build status and, only on an
// explicit click, the whole graph as a JSON download. Nothing here reads the
// graph during normal navigation.

import { BookOpenTextIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { KnowledgeOverlaySummary, KnowledgeStatus } from "../../../shared/api.ts";
import { KnowledgeStatusPill } from "../../components/KnowledgeStatus.tsx";
import { api } from "../../lib/api.ts";
import { repoPath } from "../../lib/refs.ts";
import { scopeOf, withScope } from "../../lib/timelineScope.ts";
import { TimelinePicker } from "./TimelineOverlay.tsx";

export function KnowledgeBar({
  repo,
  base,
  status,
  overlays,
}: {
  repo: { owner: string; name: string };
  /** The Knowledge page, e.g. `/orbit/engine/knowledge`. */
  base: string;
  status: KnowledgeStatus | null;
  overlays: KnowledgeOverlaySummary[];
}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
      {overlays.length > 0 && (
        <TimelinePicker
          overlays={overlays}
          value={scopeOf(params)}
          onChange={(timeline) => {
            // Choosing here switches the whole app's scope, as the switcher does.
            void navigate(withScope(`${base}?${params}`, timeline), { preventScrollReset: true });
          }}
        />
      )}
      <Link
        className="mk-btn mk-btn--ghost mk-btn--sm no-underline"
        to={repoPath(repo.owner, repo.name, "wiki")}
      >
        <BookOpenTextIcon weight="bold" aria-hidden />
        Wiki
      </Link>
      <ExportGraph repo={repo} disabled={!status?.indexedCommit} />
      {status && <KnowledgeStatusPill status={status} />}
    </div>
  );
}

/** The whole graph as JSON, fetched only when asked for. */
function ExportGraph({
  repo,
  disabled,
}: {
  repo: { owner: string; name: string };
  disabled: boolean;
}) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const run = async () => {
    setState("busy");
    try {
      const graph = await api<{ commit: string | null }>(
        `/repos/${repo.owner}/${repo.name}/knowledge/graph/export`,
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(graph)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${repo.name}-knowledge-${graph.commit?.slice(0, 7) ?? "graph"}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  return (
    <button
      type="button"
      className="mk-btn mk-btn--ghost mk-btn--sm"
      disabled={disabled || state === "busy"}
      onClick={() => void run()}
      title="Download the whole knowledge graph (nodes and edges) as JSON"
    >
      <DownloadSimpleIcon weight="bold" aria-hidden />
      {state === "busy"
        ? "Exporting…"
        : state === "failed"
          ? "Export failed, retry"
          : "Export graph"}
    </button>
  );
}
