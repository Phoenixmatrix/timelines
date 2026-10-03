import { useEffect, useState } from "react";
import type {
  AuditActor,
  IssueAuditEvent,
  IssueHistory,
  Snapshot,
} from "../../../shared/tracker.ts";
import { api } from "../../lib/api.ts";
import { FormError } from "../../components/ui.tsx";

/** Prefer the immutable snapshot; the directory only fills gaps in legacy attribution. */
export function AuditIdentity({
  actor,
  snapshot,
}: {
  actor?: AuditActor | null;
  snapshot: Snapshot;
}) {
  if (!actor) return <span className="text-ink-muted">Unknown creator</span>;
  const agent = snapshot.agents.find((item) => item.id === actor.id);
  const person = snapshot.members.find((item) => item.id === actor.id);
  const kind =
    actor.kind === "unknown" ? (agent ? "agent" : person ? "person" : "unknown") : actor.kind;
  const name = actor.name ?? agent?.name ?? person?.displayName ?? actor.id;
  const accountable = actor.accountable ?? (actor.kind === "unknown" ? agent?.accountable : null);
  return (
    <span className="[overflow-wrap:anywhere]" title={`Actor ID: ${actor.id}`}>
      {name || "Unknown actor"}
      <span className="text-ink-muted">
        {kind === "agent"
          ? ` · Agent · Accountable: ${accountable?.displayName ?? "Unknown"}`
          : kind === "person"
            ? " · Person"
            : " · Unknown identity"}
        {actor.kind === "unknown" && kind !== "unknown" && " (current directory)"}
      </span>
    </span>
  );
}

const labels: Record<string, string> = {
  title: "Title",
  description: "Description / PRD",
  acceptance: "Acceptance criteria",
  status: "Status",
  closeReason: "Close reason",
  timelineUse: "Timeline",
  timelinePolicy: "Timeline policy",
  priority: "Priority",
  type: "Type",
  assigneeId: "Assignee",
  parentId: "Parent issue",
  workspaceIds: "Workspaces",
  labels: "Labels",
  body: "Body",
  fromId: "From issue",
  toId: "To issue",
  issueId: "Issue",
  kind: "Kind",
  answer: "Answer",
  claim: "Claim",
};
const bookkeeping: Record<string, true> = {
  id: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
};
function valueText(value: unknown): string {
  if (value === undefined) return "Not present";
  if (value === null) return "None";
  if (value === "") return "Empty text";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function changes(event: IssueAuditEvent) {
  const before = (event.before ?? {}) as Record<string, unknown>;
  const after = (event.entity ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(
      (key) => !bookkeeping[key] && JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    )
    .map((key) => ({ key, before: before[key], after: after[key] }));
}
function AuditEntry({ event, snapshot }: { event: IssueAuditEvent; snapshot: Snapshot }) {
  const fields = changes(event);
  const beforeUnknown =
    event.before === null &&
    !event.kind.endsWith(".create") &&
    !event.kind.endsWith(".add") &&
    event.kind !== "request.open";
  return (
    <li className="min-w-0 border-b border-line-soft py-3 last:border-b-0">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="m-0 text-body-sm font-semibold">
          {event.kind.replaceAll(".", " · ").replaceAll("_", " ")}
        </h4>
        <time
          className="text-label text-ink-muted tabular-nums"
          dateTime={event.createdAt}
          title={event.createdAt}
        >
          {new Date(event.createdAt).toLocaleString()}
        </time>
      </header>
      <p className="mt-1 mb-0 text-body-sm">
        <AuditIdentity actor={event.actor} snapshot={snapshot} />
      </p>
      <p className="mt-1 mb-0 text-label text-ink-muted">
        Source: {event.source === "unknown" ? "Unknown (not recorded)" : event.source}
        {event.mutationKind !== event.kind && <> · Triggered by {event.mutationKind}</>}
      </p>
      <p className="mt-1 mb-0 text-label text-ink-muted [overflow-wrap:anywhere]">
        {event.entityType}: <code>{event.entityId}</code> · Event {event.cursor}
        <br />
        Operation: <code>{event.operationId}</code>
      </p>
      {beforeUnknown && (
        <p className="mk-hint mt-2 mb-0">Earlier values were not recorded for this event.</p>
      )}
      {fields.length > 0 && (
        <dl className="mt-2 mb-0 space-y-2 text-body-sm">
          {fields.map((field) => (
            <div key={field.key}>
              <dt className="font-semibold">
                {labels[field.key] ?? field.key.replaceAll(/([a-z])([A-Z])/g, "$1 $2")}
              </dt>
              <dd className="m-0 grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                <span className="text-ink-muted">Before</span>
                <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {beforeUnknown ? "Not recorded" : valueText(field.before)}
                </span>
                <span className="text-ink-muted">After</span>
                <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {valueText(field.after)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <details className="mt-1 text-body-sm">
        <summary className="min-h-11 cursor-pointer content-center text-ink-muted">
          Full event details
        </summary>
        <pre
          tabIndex={0}
          aria-label={`Full audit event ${event.cursor}`}
          className="m-0 max-h-80 overflow-auto rounded-control bg-sunken p-3 font-mono text-mono whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {JSON.stringify(event, null, 2)}
        </pre>
      </details>
    </li>
  );
}

function AuditPages({ issueId, snapshot }: { issueId: string; snapshot: Snapshot }) {
  const [events, setEvents] = useState<IssueAuditEvent[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const owner = snapshot.owner.slug;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = before === null ? "limit=50" : `limit=50&before=${before}`;
    void api<IssueHistory>(
      `/tracker/${encodeURIComponent(owner)}/issues/${encodeURIComponent(issueId)}/history?${query}`,
      { signal: controller.signal },
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setEvents((previous) => (before === null ? page.events : [...previous, ...page.events]));
        setNextBefore(page.nextBefore);
        setHasMore(page.hasMore);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Audit history could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [owner, issueId, before, retry]);
  return (
    <div>
      <p className="mk-hint mt-0 mb-1">
        Newest first. Source is reported by the client, not proof of identity.
      </p>
      <ol className="m-0 list-none p-0" aria-label="Issue audit events">
        {events.map((event) => (
          <AuditEntry key={event.cursor} event={event} snapshot={snapshot} />
        ))}
      </ol>
      {loading && (
        <p className="mk-hint" role="status">
          Loading audit history…
        </p>
      )}
      {!loading && !error && events.length === 0 && (
        <p className="mk-hint">No audit events are recorded for this issue.</p>
      )}
      <FormError message={error} />
      {error ? (
        <button
          type="button"
          className="mk-btn mk-btn--sm"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setRetry((value) => value + 1);
          }}
        >
          Retry audit history
        </button>
      ) : hasMore && nextBefore !== null ? (
        <button
          type="button"
          className="mk-btn mk-btn--sm"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setBefore(nextBefore);
          }}
        >
          Load older events
        </button>
      ) : null}
    </div>
  );
}

/** The parent keys by owner/issue; cursor resets pages without closing the disclosure. */
export function AuditHistory({ issueId, snapshot }: { issueId: string; snapshot: Snapshot }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="border-t border-line-soft py-2"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary className="min-h-11 cursor-pointer content-center text-body-sm font-semibold">
        Audit history
      </summary>
      {open && <AuditPages key={snapshot.cursor} issueId={issueId} snapshot={snapshot} />}
    </details>
  );
}
