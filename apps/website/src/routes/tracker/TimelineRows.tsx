// What a row of the timeline graph says (CORE-402): an event reads like a log
// line, its kind and number first, then what happened, then who; a timeline's
// own row leads with its name and state. Rows with more behind them expand in
// place: a checkpoint's commits, CI, previews and approval; a landing's note
// and merges; a long approval note.

import { useEffect, useState, type ReactNode } from "react";
import type { TimelineGraphData } from "../../../shared/timeline-graph.ts";
import type { CheckpointView, Timeline, TimelineEvent } from "../../../shared/timelines.ts";
import { api, ApiError } from "../../lib/api.ts";
import { commitPanelUrl } from "../../lib/commitPanel.ts";
import { shortOid, timeAgo } from "../../lib/format.ts";
import { treeUrl } from "../../lib/refs.ts";
import { Link } from "react-router";
import { CheckpointPanel } from "./Checkpoint.tsx";
import { RowText } from "./TimelineLanes.tsx";
import { STATUS_LABEL, type Row } from "./timelineGraph.ts";
import { MarkdownText } from "./ui.tsx";

export interface RowContext {
  data: TimelineGraphData;
  /** A timeline's name, linked to select it; null is main. */
  name: (timeline: Timeline | null) => ReactNode;
  /** A merge's commit, linked, when the row has one. */
  commit?: ReactNode;
}

export interface RowSummary {
  /** What happened, or whose row it is. */
  title: ReactNode;
  /** The rest of the first line: a summary, an outcome, the other side. */
  detail?: ReactNode;
  /** Chips after the title (state, policy). */
  chips?: ReactNode;
  /** The second line: who, and what else is known. */
  by?: string;
  /** Whether the row has more to show when expanded. */
  expandable: boolean;
}

const LANDING_OUTCOME: Record<Extract<TimelineEvent, { kind: "landing" }>["outcome"], string> = {
  queued: "entered the landing queue",
  conflict: "conflicts with main: needs a sync",
  failed: "stopped: its checks failed",
  blocked_dependency: "waits on a timeline it depends on",
  partly_landed: "partly landed: the rest retry",
  landed: "landed on main",
};

/** The first line of a summary, for the row; the rest is in its details. */
const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

/** What one row of the graph says. */
export function summarize(row: Row, ctx: RowContext): RowSummary {
  const { data } = ctx;
  const actor = (id: string | null | undefined) =>
    id ? (data.actors[id]?.name ?? "someone outside the tracker") : null;
  const t = row.timeline;
  const event = row.event ?? null;
  const by = event?.actorId ? `by ${actor(event.actorId)}` : undefined;
  switch (row.kind) {
    case "main": {
      const open = data.timelines.filter(
        (timeline) => timeline.status !== "landed" && timeline.status !== "abandoned",
      ).length;
      return {
        title: <span className="font-mono font-semibold text-ink">main</span>,
        detail: "where every timeline lands",
        by: `${open} open ${open === 1 ? "timeline" : "timelines"}`,
        expandable: false,
      };
    }
    case "head": {
      const issues = data.issues?.[t!.id]?.length ?? 0;
      const started = `Started ${timeAgo(t!.createdAt)} by ${actor(t!.startedBy)}`;
      return {
        title: <span className="text-body font-semibold text-ink">{t!.name}</span>,
        chips: (
          <>
            <span className="mk-chip mk-chip--tag">{STATUS_LABEL[t!.status]}</span>
            <span className="mk-chip mk-chip--tag">
              {t!.policy === "auto" ? "Lands automatically" : "Lands after approval"}
            </span>
            {t!.experimental && <span className="mk-chip mk-chip--tag">Experimental</span>}
          </>
        ),
        by: [
          started,
          issues ? `${issues} ${issues === 1 ? "issue" : "issues"}` : null,
          t!.agentIds.length
            ? `${t!.agentIds.length} ${t!.agentIds.length === 1 ? "agent" : "agents"}`
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
        expandable: false,
      };
    }
    case "fork":
      return {
        title: <span className="font-semibold text-ink">Forked</span>,
        detail: <>from {ctx.name(row.peer ?? null)}</>,
        by,
        expandable: false,
      };
    case "event":
      if (event?.kind === "checkpoint")
        return {
          title: <span className="font-semibold text-ink">Checkpoint #{event.number}</span>,
          detail: firstLine(event.summary) || <span className="text-ink-faint">No summary</span>,
          by,
          expandable: true,
        };
      if (event?.kind === "approval") {
        const how =
          event.via === "auto-approve"
            ? `by ${actor(event.actorId) ?? "someone"}’s approve-when-green setting`
            : event.outcome === "superseded"
              ? "newer commits came first"
              : (by ?? "");
        return {
          title: (
            <span className="font-semibold text-ink">
              #{event.number} {event.outcome}
            </span>
          ),
          detail: [how, event.note ? `“${firstLine(event.note)}”` : ""].filter(Boolean).join(": "),
          // A long note, or one with more than its first line, opens in full.
          expandable:
            !!event.note && (event.note.trim().length > 80 || event.note.trim().includes("\n")),
        };
      }
      if (event?.kind === "landing")
        return {
          title: <span className="font-semibold text-ink">Landing #{event.number}</span>,
          detail: LANDING_OUTCOME[event.outcome],
          by,
          expandable: !!event.note || Object.keys(event.merges).length > 0,
        };
      return {
        title: <span className="font-semibold text-ink">{event?.kind ?? "Event"}</span>,
        by,
        expandable: false,
      };
    default:
      // Merges, landings onto main and abandons say both sides in words.
      return {
        title: <RowText row={row} name={ctx.name} commit={ctx.commit} />,
        by,
        expandable: false,
      };
  }
}

/** A commit a timeline event pins, linked in its own source. */
function PinnedCommit({
  timeline,
  repoId,
  oid,
}: {
  timeline: Timeline;
  repoId: string;
  oid: string;
}) {
  const repo = timeline.repos.find((r) => r.id === repoId);
  if (!repo) return <span className="mk-mono">{shortOid(oid)}</span>;
  return (
    <>
      {repo.space}/{repo.name}{" "}
      <Link
        className="mk-mono underline underline-offset-2"
        to={
          repo.source && repo.source.sourceId !== "canonical"
            ? treeUrl(repo.space, repo.name, oid, "", repo.source.sourceId)
            : commitPanelUrl(repo.space, repo.name, oid)
        }
      >
        {shortOid(oid)}
      </Link>
    </>
  );
}

/** What an expanded row shows. */
export function RowDetails({
  row,
  space,
  name,
  revision,
}: {
  row: Row;
  space: string;
  /** How to name a person by id. */
  name: (id: string) => string;
  /** Changes when the graph is read again, so an open checkpoint is too. */
  revision: unknown;
}) {
  const event = row.event;
  const t = row.timeline;
  if (!event || !t) return null;
  if (event.kind === "checkpoint")
    return (
      <CheckpointDetails
        space={space}
        timeline={t}
        number={event.number}
        summary={event.summary}
        name={name}
        revision={revision}
      />
    );
  if (event.kind === "approval")
    return (
      <div className="text-body-sm text-ink">
        <MarkdownText text={event.note ?? ""} />
      </div>
    );
  if (event.kind === "landing")
    return (
      <div className="flex flex-col gap-1 text-body-sm">
        {event.note && <p className="m-0 text-ink [overflow-wrap:anywhere]">{event.note}</p>}
        {Object.entries(event.merges).map(([repoId, oid]) => (
          <p key={repoId} className="m-0 text-ink-muted">
            Main moved to <PinnedCommit timeline={t} repoId={repoId} oid={oid} />
          </p>
        ))}
      </div>
    );
  return null;
}

/** A checkpoint's full summary, then (read when opened) its commits, CI, previews and approval. */
function CheckpointDetails({
  space,
  timeline,
  number,
  summary,
  name,
  revision,
}: {
  space: string;
  timeline: Timeline;
  number: number;
  summary: string;
  name: (id: string) => string;
  revision: unknown;
}) {
  const [view, setView] = useState<CheckpointView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    api<CheckpointView>(
      `/tracker/${encodeURIComponent(space)}/timelines/${encodeURIComponent(timeline.slug)}/checkpoints/${number}`,
      { signal: abort.signal },
    )
      .then(setView)
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setError(
            failure instanceof ApiError ? failure.message : "Couldn't read this checkpoint.",
          );
      });
    return () => abort.abort();
    // Read again with the graph; the last view stays until the new one comes.
  }, [space, timeline.slug, number, revision]);
  if (view) return <CheckpointPanel view={view} tracker={space} name={name} />;
  return (
    <div className="flex flex-col gap-1 text-body-sm">
      {summary.trim() && (
        <div className="text-ink">
          <MarkdownText text={summary} />
        </div>
      )}
      {error ? (
        <p className="mk-error m-0">{error}</p>
      ) : (
        <p className="m-0 text-ink-faint">Reading its commits, CI and previews…</p>
      )}
    </div>
  );
}
