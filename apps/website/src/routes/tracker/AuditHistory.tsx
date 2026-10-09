import { useEffect, useMemo, useState } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import { diffWordsWithSpace } from "diff";
import {
  actorName,
  CLOSE_REASONS,
  ISSUE_PICKUPS,
  TIMELINE_USES,
  type AuditActor,
  type Issue,
  type IssueAuditEvent,
  type IssueHistory,
  type Snapshot,
} from "../../../shared/tracker.ts";
import { api } from "../../lib/api.ts";
import { requirementsText, type IssueRequirements } from "../../../shared/requirements.ts";
import { FormError } from "../../components/ui.tsx";
import { statusLabel, typeLabel } from "./ui.tsx";

/** Prefer the immutable snapshot; the directory only fills gaps in legacy attribution. */
export function AuditIdentity({
  actor,
  snapshot,
  compact = false,
}: {
  actor?: AuditActor | null;
  snapshot: Snapshot;
  compact?: boolean;
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
          ? compact
            ? " · Agent"
            : ` · Agent · Accountable: ${accountable?.displayName ?? "Unknown"}`
          : kind === "person"
            ? compact
              ? ""
              : " · Person"
            : " · Unknown identity"}
        {actor.kind === "unknown" && kind !== "unknown" && " (current directory)"}
      </span>
    </span>
  );
}

const labels: Record<string, string> = {
  title: "Title",
  teamId: "Team",
  description: "Description / PRD",
  acceptance: "Acceptance criteria",
  status: "Status",
  pickup: "Pickup",
  closeReason: "Close reason",
  timelineUse: "Timeline",
  timelinePolicy: "Timeline policy",
  priority: "Priority",
  type: "Type",
  assigneeId: "Assignee",
  parentId: "Parent issue",
  workspaceIds: "Workspaces",
  labels: "Tags",
  requires: "Agent requirements",
  body: "Body",
  prompt: "Question",
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
function valueText(value: unknown, key?: string): string {
  if (key === "requires") return value ? requirementsText(value as IssueRequirements) : "Any agent";
  if (value === undefined) return "Not present";
  if (value === null) return "None";
  if (value === "") return "Empty text";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function changes(event: IssueAuditEvent) {
  const before = (event.before ?? {}) as Record<string, unknown>;
  const after = (event.entity ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => {
      if (bookkeeping[key]) return false;
      const oldValue = before[key];
      const newValue = after[key];
      // Tags and workspace associations are sets, not ordered text.
      if (
        (key === "labels" || key === "workspaceIds") &&
        Array.isArray(oldValue) &&
        Array.isArray(newValue)
      )
        return oldValue.length !== newValue.length || oldValue.some((v) => !newValue.includes(v));
      return JSON.stringify(oldValue) !== JSON.stringify(newValue);
    })
    .map((key) => ({ key, before: before[key], after: after[key] }));
}
type FieldChange = ReturnType<typeof changes>[number];
const fieldLabel = (key: string) => labels[key] ?? key.replaceAll(/([a-z])([A-Z])/g, "$1 $2");
const valueLabels: Record<string, Readonly<Record<string, string>>> = {
  pickup: ISSUE_PICKUPS,
  closeReason: CLOSE_REASONS,
  timelineUse: TIMELINE_USES,
};
const longTextFields = new Set(["description", "acceptance", "body", "prompt", "answer"]);

function previewValue(value: unknown, key: string, snapshot: Snapshot): string {
  if (typeof value === "number" && key === "priority") return `P${value}`;
  if (Array.isArray(value))
    return value.length
      ? value.map((item) => previewValue(item, key, snapshot)).join(", ")
      : "None";
  if (typeof value !== "string" || !value) return valueText(value, key);
  if (key === "status") return statusLabel({ status: value as Issue["status"] });
  if (key === "type") return typeLabel(value);
  if (key === "assigneeId") return actorName(snapshot, value);
  if (key === "workspaceIds")
    return snapshot.workspaces.find((workspace) => workspace.id === value)?.name ?? value;
  if (key === "teamId") return snapshot.teams.find((team) => team.id === value)?.key ?? value;
  if (["parentId", "fromId", "toId", "issueId"].includes(key))
    return snapshot.issues.find((issue) => issue.id === value)?.key ?? value;
  return valueLabels[key]?.[value] ?? value;
}
function excerpt(text: string): string {
  const compact = text.replaceAll(/\s+/g, " ").trim() || JSON.stringify(text);
  return compact.length > 100 ? `${compact.slice(0, 100)}…` : compact;
}

function FieldPreview({ field, snapshot }: { field: FieldChange; snapshot: Snapshot }) {
  const delta = useMemo(() => {
    if (
      (field.key === "labels" || field.key === "workspaceIds") &&
      Array.isArray(field.before) &&
      Array.isArray(field.after)
    ) {
      const before = new Set(field.before);
      const after = new Set(field.after);
      return [
        ...field.before
          .filter((value) => !after.has(value))
          .map((value) => ({ value, removed: true })),
        ...field.after
          .filter((value) => !before.has(value))
          .map((value) => ({ value, removed: false })),
      ];
    }
    if (
      longTextFields.has(field.key) &&
      typeof field.before === "string" &&
      typeof field.after === "string" &&
      field.before.length + field.after.length <= 20_000
    ) {
      // Bound work for large rewrites; a preview is not a reason to stall the feed.
      return diffWordsWithSpace(field.before, field.after, { maxEditLength: 128, timeout: 10 })
        ?.filter((part) => part.added || part.removed)
        .map((part) => ({ value: part.value, removed: part.removed }));
    }
    return undefined;
  }, [field.key, field.before, field.after]);
  const text = (value: unknown) => excerpt(previewValue(value, field.key, snapshot));
  return (
    <span className="block line-clamp-2 [overflow-wrap:anywhere]">
      <span className="font-semibold">{fieldLabel(field.key)}:</span>{" "}
      {delta?.length ? (
        <>
          {delta.slice(0, 4).map((part, index) => (
            <span key={index}>
              {index > 0 && " "}
              {part.removed ? (
                <del className="text-ink-muted">
                  <span className="sr-only">Removed: </span>
                  {text(part.value)}
                </del>
              ) : (
                <ins className="no-underline">
                  <span className="sr-only">Added: </span>
                  {text(part.value)}
                </ins>
              )}
            </span>
          ))}
          {delta.length > 4 && " …"}
        </>
      ) : longTextFields.has(field.key) && typeof field.after === "string" ? (
        <span>
          {field.before !== undefined && "Updated · "}
          {text(field.after)}
        </span>
      ) : (
        <>
          {field.before !== undefined && (
            <>
              <span className="text-ink-muted">{text(field.before)}</span>
              <span aria-hidden> → </span>
              <span className="sr-only"> to </span>
            </>
          )}
          {text(field.after)}
        </>
      )}
    </span>
  );
}

const eventLabels: Record<string, string> = {
  "issue.create": "created an issue",
  "issue.update": "updated an issue",
  "comment.add": "added a comment",
  "comment.update": "edited a comment",
  "comment.delete": "deleted a comment",
  "request.open": "opened a request",
  "request.answer": "answered a request",
  "request.cancel": "withdrew a request",
  "link.add": "added a relation",
  "link.remove": "removed a relation",
};

function AuditEntry({ event, snapshot }: { event: IssueAuditEvent; snapshot: Snapshot }) {
  const [open, setOpen] = useState(false);
  const fields = useMemo(() => changes(event), [event]);
  const beforeUnknown =
    event.before === null &&
    !event.kind.endsWith(".create") &&
    !event.kind.endsWith(".add") &&
    event.kind !== "request.open";
  // Creation/deletion describes an event, not a change to every default field.
  // Missing historical values must never masquerade as a known delta.
  const previews = beforeUnknown
    ? []
    : event.before === null || event.entity === null
      ? fields.filter((field) => ["title", "body", "prompt", "fromId", "toId"].includes(field.key))
      : fields;
  return (
    <li className="min-w-0 border-b border-line-soft last:border-b-0">
      <details
        className="group/audit"
        onToggle={(event) => {
          if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
        }}
      >
        <summary className="flex min-h-11 cursor-pointer list-none gap-2 py-2 text-body-sm [&::-webkit-details-marker]:hidden">
          <CaretRightIcon
            aria-hidden
            className="mt-1 size-3 shrink-0 text-ink-muted group-open/audit:rotate-90"
          />
          <span className="block min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <AuditIdentity actor={event.actor} snapshot={snapshot} compact />{" "}
                <span className="text-ink-muted">
                  {eventLabels[event.kind] ?? event.kind.replaceAll(/[._]/g, " ")}
                </span>
              </span>
              <time
                className="text-label text-ink-muted tabular-nums"
                dateTime={event.createdAt}
                title={event.createdAt}
              >
                {new Date(event.createdAt).toLocaleString()}
              </time>
            </span>
            {beforeUnknown && (
              <span className="block text-ink-muted">Earlier values were not recorded.</span>
            )}
            {previews.slice(0, 3).map((field) => (
              <FieldPreview key={field.key} field={field} snapshot={snapshot} />
            ))}
            {previews.length > 3 && (
              <span className="block text-ink-muted">+{previews.length - 3} more changes</span>
            )}
          </span>
        </summary>
        {open && (
          <div className="min-w-0 pb-3 pl-5">
            <p className="mt-1 mb-0 text-body-sm">
              <AuditIdentity actor={event.actor} snapshot={snapshot} />
            </p>
            <p className="mt-1 mb-0 text-label text-ink-muted">
              Source: {event.source === "unknown" ? "Unknown (not recorded)" : event.source}
              {" · Client-reported, not proof of identity"}
              {event.mutationKind !== event.kind && <> · Triggered by {event.mutationKind}</>}
            </p>
            <p className="mt-1 mb-0 text-label text-ink-muted [overflow-wrap:anywhere]">
              {event.entityType}: <code>{event.entityId}</code> · Event {event.cursor}
              <br />
              Operation: <code>{event.operationId}</code>
            </p>
            {fields.length > 0 && (
              <dl className="mt-3 mb-0 space-y-3 text-body-sm">
                {fields.map((field) => (
                  <div key={field.key}>
                    <dt className="font-semibold">{fieldLabel(field.key)}</dt>
                    <dd className="m-0 grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-x-2 gap-y-1">
                      <span className="text-ink-muted">Before</span>
                      <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {beforeUnknown ? "Not recorded" : valueText(field.before, field.key)}
                      </span>
                      <span className="text-ink-muted">After</span>
                      <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {valueText(field.after, field.key)}
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
          </div>
        )}
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
        Newest first. Expand an event for full values and provenance.
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
