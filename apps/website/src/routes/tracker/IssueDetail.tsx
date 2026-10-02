import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  actorName,
  attribution,
  claimAttribution,
  leasedAncestor,
  readinessIndex,
  type Comment,
  type Issue,
  type IssueFields,
  type Mutation,
  type Snapshot,
} from "../../../shared/tracker.ts";
import { FormError, link as LINK, SelectField, TextField } from "../../components/ui.tsx";
import {
  blockers,
  Field,
  IssuePicker,
  IssueState,
  MarkdownText,
  MultiCheck,
  statuses,
  typeLabel,
  types,
} from "./ui.tsx";
import type { IssueIndex } from "./query.ts";
import { RequestCard } from "./Requests.tsx";
import { useViewer } from "../../lib/session.ts";
import { Actor } from "./Actor.tsx";

export type MutationOutcome = { ok: true } | { ok: false; error: string; code?: string };
export type Mutate = (mutations: Mutation[]) => Promise<MutationOutcome>;
type Draft = { version: number; fields: IssueFields; base?: IssueFields };
const fieldNames: Record<keyof IssueFields, string> = {
  title: "Title",
  description: "Description / PRD",
  acceptance: "Acceptance criteria",
  type: "Type",
  status: "Status",
  priority: "Priority",
  assigneeId: "Assignee",
  parentId: "Parent issue",
  workspaceIds: "Workspaces",
  labels: "Labels",
};
const fieldKeys = Object.keys(fieldNames) as (keyof IssueFields)[];

// The detail renders in a narrow inspector: hairline-split sections, small headings.
const SECTION = "border-t border-line-soft py-4";
const HEADING = "m-0 text-body-sm font-semibold";
const SUBHEADING = "mt-4 mb-1 text-label text-ink-faint";
const META = "m-0 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-body-sm";
const LIST = "m-0 list-none p-0";
const ROW =
  "flex items-center justify-between gap-2 border-b border-line-soft py-1.5 text-body-sm [overflow-wrap:anywhere] last:border-b-0 max-md:items-start";
const TEXTAREA = "mk-input min-h-28 resize-y leading-[1.6]";
const normalizedSet = (values: string[]) =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
const same = (a: IssueFields[keyof IssueFields], b: IssueFields[keyof IssueFields]) =>
  Array.isArray(a) && Array.isArray(b)
    ? JSON.stringify(normalizedSet(a)) === JSON.stringify(normalizedSet(b))
    : a === b;
function relativeTime(value: string, now: string) {
  const seconds = Math.max(
    0,
    Math.floor((new Date(now).getTime() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function IssueDetail({
  issue,
  snapshot,
  index,
  mutate,
  busy,
  href,
}: {
  issue: Issue;
  snapshot: Snapshot;
  /** The workbench's index; keeps lookups constant-time at tens of thousands of issues. */
  index: IssueIndex;
  mutate: Mutate;
  busy: boolean;
  href: (id?: string) => string;
}) {
  const storageKey = `gitmatrix:issue-draft:${snapshot.owner.id}:${issue.id}`;
  const initial: Draft = {
    version: issue.version,
    fields: {
      title: issue.title,
      description: issue.description,
      acceptance: issue.acceptance,
      type: issue.type,
      status: issue.status,
      priority: issue.priority,
      assigneeId: issue.assigneeId,
      parentId: issue.parentId,
      workspaceIds: issue.workspaceIds,
      labels: issue.labels,
    },
  };
  initial.base = initial.fields;
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      return saved ? (JSON.parse(saved) as Draft) : initial;
    } catch {
      return initial;
    }
  });
  const [editing, setEditing] = useState(() => {
    try {
      return !!sessionStorage.getItem(storageKey);
    } catch {
      return false;
    }
  });
  const [preview, setPreview] = useState(false);
  const [localError, setLocalError] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<Comment["kind"]>("comment");
  const [relation, setRelation] = useState("blocks");
  const [target, setTarget] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [relationError, setRelationError] = useState("");
  const [commentError, setCommentError] = useState("");
  const [subtaskError, setSubtaskError] = useState("");
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [subtaskNotice, setSubtaskNotice] = useState("");
  const [removeError, setRemoveError] = useState<{ id: string; error: string } | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) detailRef.current?.focus();
  }, []);
  useEffect(() => {
    if (busy) {
      setNotice("");
      setSubtaskNotice("");
    }
  }, [busy]);
  useEffect(() => {
    if (editing) {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(draft));
      } catch {
        /* The in-memory draft remains usable when storage is unavailable. */
      }
    }
  }, [draft, editing, storageKey]);
  const change = <K extends keyof IssueFields>(key: K, value: IssueFields[K]) => {
    setNotice("");
    setLocalError("");
    setDraft((previous) => ({ ...previous, fields: { ...previous.fields, [key]: value } }));
  };
  const links = snapshot.links.filter((link) => link.fromId === issue.id || link.toId === issue.id);
  const comments = snapshot.comments.filter((comment) => comment.issueId === issue.id);
  // The issue's own lease, or an ancestor's: either way only its holder changes the status.
  const covering =
    issue.claim && issue.claim.expiresAt > snapshot.serverTime
      ? issue
      : leasedAncestor(issue, readinessIndex(snapshot.issues, snapshot.links), snapshot.serverTime);
  const activeClaim = covering !== null;
  const unresolvedBlockers = blockers(issue, snapshot, index);
  const invalidStatus =
    draft.fields.status !== issue.status &&
    (activeClaim ||
      (unresolvedBlockers.length > 0 &&
        (draft.fields.status === "in_progress" || draft.fields.status === "done")));
  const team = snapshot.teams.find((team) => team.id === issue.teamId);
  const members = snapshot.members.filter(
    (member) => !team?.memberIds.length || team.memberIds.includes(member.id),
  );
  // Agents can be assigned when their human could be.
  const assignable = [
    ...members.map((member) => ({ value: member.id, label: member.displayName })),
    ...snapshot.agents
      .filter((agent) => members.some((member) => member.id === agent.accountable.id))
      .map((agent) => ({ value: agent.id, label: actorName(snapshot, agent.id) })),
  ];
  const beginEdit = () => {
    setDraft(initial);
    setPreview(false);
    setNotice("");
    setActionError("");
    setLocalError("");
    setEditing(true);
    requestAnimationFrame(() =>
      detailRef.current?.querySelector<HTMLInputElement>("input")?.focus(),
    );
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !detailRef.current?.closest("[data-shortcuts='true']") ||
        busy ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        (event.target instanceof Element &&
          event.target.closest(
            "input, textarea, select, button, [contenteditable], [role=combobox], [role=listbox]",
          ))
      )
        return;
      if (event.key === "e" && !editing) {
        event.preventDefault();
        beginEdit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const statusReason =
    [
      unresolvedBlockers.length ? "tracker-completion-blockers" : "",
      activeClaim ? "tracker-claim-reason" : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const updateStatus = async (status: Issue["status"], message: string) => {
    setNotice("");
    setActionError("");
    const result = await mutate([
      { kind: "issue.update", id: issue.id, expectedVersion: issue.version, data: { status } },
    ]);
    if (result.ok) setNotice(message);
    else setActionError(result.error);
  };
  // Parent candidates exclude this issue's own subtree, so a move can't make a cycle.
  const descendants = useMemo(() => {
    const seen = new Set([issue.id]);
    const queue = [issue.id];
    while (queue.length)
      for (const child of index.children.get(queue.pop()!) ?? [])
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
    return seen;
  }, [issue.id, index]);
  const parentCandidates = useMemo(
    () => snapshot.issues.filter((item) => !descendants.has(item.id)),
    [snapshot.issues, descendants],
  );
  // A new blocks link must not close a cycle: one walk over the blocks graph
  // finds every issue that can't be linked in the chosen direction.
  const relationCandidates = useMemo(() => {
    if (relation !== "blocks" && relation !== "blocked_by")
      return snapshot.issues.filter((item) => item.id !== issue.id);
    const forward = relation === "blocked_by";
    const next = new Map<string, string[]>();
    const direct = new Set<string>();
    for (const link of snapshot.links) {
      if (link.kind !== "blocks") continue;
      const [a, b] = forward ? [link.fromId, link.toId] : [link.toId, link.fromId];
      next.set(a, [...(next.get(a) ?? []), b]);
      if (relation === "blocks" ? link.fromId === issue.id : link.toId === issue.id)
        direct.add(relation === "blocks" ? link.toId : link.fromId);
    }
    const reached = new Set([issue.id]);
    const queue = [issue.id];
    while (queue.length)
      for (const id of next.get(queue.pop()!) ?? [])
        if (!reached.has(id)) {
          reached.add(id);
          queue.push(id);
        }
    return snapshot.issues.filter((item) => !reached.has(item.id) && !direct.has(item.id));
  }, [relation, snapshot.issues, snapshot.links, issue.id]);
  const viewer = useViewer();
  // What this issue is waiting on: open requests first, then the answered history.
  const requests = snapshot.requests
    .filter((request) => request.issueId === issue.id)
    .sort(
      (a, b) =>
        Number(b.status === "open") - Number(a.status === "open") ||
        b.createdAt.localeCompare(a.createdAt),
    );
  const latestCheckpoint = comments
    .filter((comment) => comment.kind === "checkpoint")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const parent = issue.parentId ? index.byId.get(issue.parentId) : undefined;
  const children = (index.children.get(issue.id) ?? []).flatMap((id) => index.byId.get(id) ?? []);
  const inheritedWorkspaces = snapshot.workspaces.filter(
    (workspace) => !workspace.archived && issue.workspaceIds.includes(workspace.id),
  );
  const displayField = (key: keyof IssueFields, fields: IssueFields) => {
    const value = fields[key];
    if (key === "description" || key === "acceptance")
      return <MarkdownText text={String(value) || "Empty"} />;
    if (key === "assigneeId")
      return (typeof value === "string" ? actorName(snapshot, value) : null) ?? "Unassigned";
    if (key === "parentId") {
      const item = typeof value === "string" ? index.byId.get(value) : undefined;
      return item ? `${item.key} · ${item.title}` : value ? "Unavailable issue" : "No parent";
    }
    if (key === "workspaceIds")
      return (
        fields.workspaceIds
          .map(
            (id) =>
              snapshot.workspaces.find((workspace) => workspace.id === id)?.name ??
              "Unavailable workspace",
          )
          .join(", ") || "None"
      );
    if (key === "labels") return fields.labels.join(", ") || "None";
    if (key === "status") return statuses.find((status) => status.value === value)?.label;
    if (key === "priority") return `P${fields.priority}`;
    return String(value);
  };
  const rebase = () => {
    setDraft((previous) => {
      const fields = { ...initial.fields };
      for (const key of fieldKeys) {
        if (!previous.base || !same(previous.fields[key], previous.base[key]))
          Object.assign(fields, { [key]: previous.fields[key] });
      }
      return { version: issue.version, base: initial.fields, fields };
    });
    setLocalError("");
  };

  return (
    <article
      ref={detailRef}
      tabIndex={-1}
      className="min-w-0 outline-none max-sm:scroll-mt-[calc(var(--size-dock)+16px)]"
      aria-label={`${issue.key} issue detail`}
    >
      <header className="pr-10 pb-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            className={`${LINK} inline-flex min-h-11 items-center text-body-sm lg:hidden`}
            to={href()}
          >
            Back to issues
          </Link>
          <span className="mk-mono text-ink-muted">{issue.key}</span>
          <IssueState issue={issue} snapshot={snapshot} index={index} />
        </div>
        <h2 className="mt-1 mb-0 text-title-lg break-words">{issue.title}</h2>
        <dl className={`${META} mt-3`}>
          <dt className="text-ink-faint">Team</dt>
          <dd className="m-0 min-w-0">{team?.name}</dd>
          <dt className="text-ink-faint">Type</dt>
          <dd className="m-0 min-w-0">{typeLabel(issue.type)}</dd>
          <dt className="text-ink-faint">Priority</dt>
          <dd className="m-0 min-w-0">P{issue.priority}</dd>
          {(issue.attempts ?? 0) > 0 && (
            <>
              <dt className="text-ink-faint">Attempts</dt>
              <dd className="m-0 min-w-0">{issue.attempts} released unfinished</dd>
            </>
          )}
          <dt className="text-ink-faint">Assignee</dt>
          <dd className="m-0 min-w-0">
            {issue.assigneeId ? (
              <Actor who={attribution(snapshot, issue.assigneeId)} />
            ) : (
              "Unassigned"
            )}
          </dd>
          {issue.workspaceIds.length > 0 && (
            <>
              <dt className="text-ink-faint">Workspaces</dt>
              <dd className="m-0 flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                {issue.workspaceIds.map((id) => (
                  <Link
                    className={`${LINK} max-md:inline-flex max-md:min-h-11 max-md:items-center`}
                    key={id}
                    to={`/tracker/${snapshot.owner.slug}?workspace=${encodeURIComponent(id)}`}
                  >
                    {snapshot.workspaces.find((workspace) => workspace.id === id)?.name ??
                      "Unavailable workspace"}
                  </Link>
                ))}
              </dd>
            </>
          )}
          {issue.labels.length > 0 && (
            <>
              <dt className="text-ink-faint">Labels</dt>
              <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1">
                {issue.labels.map((label) => (
                  <span className="mk-chip mk-chip--tag" key={label}>
                    {label}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
        {activeClaim && (
          <p
            className="mt-3 mb-0 flex gap-2 rounded-control bg-sunken px-3 py-2 text-body-sm text-ink-muted"
            data-kind="checkpoint"
            id="tracker-claim-reason"
          >
            <span
              className="mt-1.5 size-2 shrink-0 rounded-full ring-[1.5px] ring-inset ring-ink"
              aria-hidden
            />
            <span>
              <Actor
                who={claimAttribution(snapshot, covering!.claim!)}
                className="font-semibold text-ink"
              />
              {covering!.claim!.delegatedFrom &&
                ` (delegated from ${index.byId.get(covering!.claim!.delegatedFrom)?.key ?? "a parent"})`}{" "}
              is working on{" "}
              {covering === issue ? "this issue" : `${covering!.key}, which includes this issue,`}{" "}
              until{" "}
              {new Date(covering!.claim!.expiresAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              . You can edit its details, but only its holder can change its status until the claim
              ends.
              {covering === issue &&
                issue.handoff &&
                issue.handoff.expiresAt > snapshot.serverTime &&
                ` It's handing the work to ${issue.handoff.to ? actorName(snapshot, issue.handoff.to) : "whoever has its code"}.`}
            </span>
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2 max-sm:flex-nowrap max-sm:[&>.mk-btn]:min-w-0 max-sm:[&>.mk-btn]:flex-1 max-sm:[&>.mk-btn]:px-2">
          {!editing && (
            <button
              className="mk-btn mk-btn--primary mk-btn--sm"
              aria-keyshortcuts="e"
              onClick={beginEdit}
            >
              Edit issue
            </button>
          )}
          {!editing && (issue.status === "todo" || issue.status === "backlog") && (
            <button
              className="mk-btn mk-btn--sm"
              disabled={busy || activeClaim || unresolvedBlockers.length > 0}
              aria-describedby={statusReason}
              onClick={() => void updateStatus("in_progress", "Work started.")}
            >
              Start work
            </button>
          )}
          {!editing && issue.status !== "done" && issue.status !== "canceled" && (
            <button
              className="mk-btn mk-btn--sm"
              disabled={busy || activeClaim || unresolvedBlockers.length > 0}
              aria-describedby={statusReason}
              onClick={() => void updateStatus("done", "Issue completed.")}
            >
              Mark done
            </button>
          )}
          {!editing && (issue.status === "done" || issue.status === "canceled") && (
            <button
              className="mk-btn mk-btn--sm"
              disabled={busy || activeClaim}
              aria-describedby={activeClaim ? "tracker-claim-reason" : undefined}
              onClick={() => void updateStatus("todo", "Issue reopened.")}
            >
              Reopen
            </button>
          )}
        </div>
        <FormError message={actionError} />
        {unresolvedBlockers.length > 0 && (
          <p className="mk-hint mt-2 mb-0 max-w-[48ch]" id="tracker-completion-blockers">
            Complete or remove {unresolvedBlockers.map((blocker) => blocker.key).join(", ")} before
            starting or completing this issue.
          </p>
        )}
        {notice && (
          <p className="mk-hint mt-2 mb-0" role="status">
            {notice}
          </p>
        )}
      </header>
      {requests.length > 0 && (
        <section className={SECTION} aria-label="Requests to people">
          <h3 className={HEADING}>
            {issue.waiting
              ? `Waiting on ${issue.waiting === 1 ? "a person" : "people"}`
              : "Requests"}
          </h3>
          <div className="flex flex-col gap-2">
            {requests.map((request) => (
              <RequestCard
                key={request.id}
                request={request}
                name={(id) => actorName(snapshot, id)}
                onAnswer={(answer) =>
                  mutate([{ kind: "request.answer", id: request.id, data: answer }])
                }
                onCancel={
                  request.askedBy === viewer?.id
                    ? () => mutate([{ kind: "request.cancel", id: request.id }])
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      )}
      {latestCheckpoint && (
        <section className={SECTION} data-kind="checkpoint" aria-label="Latest checkpoint">
          <h3 className={`${HEADING} flex items-center gap-2`}>
            <span
              className="size-2 shrink-0 rounded-full ring-[1.5px] ring-inset ring-ink"
              aria-hidden
            />
            Latest checkpoint
          </h3>
          <p className="mk-hint mt-0.5 mb-2 flex flex-wrap items-center gap-x-1">
            <Actor who={attribution(snapshot, latestCheckpoint.actorId)} />
            {" · "}
            <time
              className="tabular-nums"
              dateTime={latestCheckpoint.createdAt}
              title={new Date(latestCheckpoint.createdAt).toLocaleString()}
            >
              {relativeTime(latestCheckpoint.createdAt, snapshot.serverTime)}
            </time>
          </p>
          <MarkdownText text={latestCheckpoint.body} />
        </section>
      )}
      {editing ? (
        <form
          className={`${SECTION} space-y-4`}
          onSubmit={async (event) => {
            event.preventDefault();
            setLocalError("");
            setNotice("");
            if (draft.version !== issue.version) {
              setLocalError("Review the newer version before saving.");
              return;
            }
            if (!draft.fields.title.trim()) {
              setLocalError("Give this issue a title.");
              return;
            }
            const fields = {
              ...draft.fields,
              labels: normalizedSet(draft.fields.labels),
              workspaceIds: normalizedSet(draft.fields.workspaceIds),
            };
            const changes = Object.fromEntries(
              Object.entries(fields).filter(
                ([key, value]) =>
                  !same(value, (draft.base ?? initial.fields)[key as keyof IssueFields]),
              ),
            ) as Partial<IssueFields>;
            const result: MutationOutcome = !Object.keys(changes).length
              ? { ok: true }
              : await mutate([
                  {
                    kind: "issue.update",
                    id: issue.id,
                    expectedVersion: draft.version,
                    data: changes,
                  },
                ]);
            if (result.ok) {
              setEditing(false);
              try {
                sessionStorage.removeItem(storageKey);
              } catch {
                /* Storage can be disabled. */
              }
              setNotice("Issue saved.");
            } else setLocalError(result.error);
          }}
        >
          <h3 className={HEADING}>Edit issue</h3>
          {draft.version !== issue.version && (
            <section className="rounded-control bg-danger-wash p-3 text-body-sm" role="alert">
              <h4 className="m-0 font-semibold">This issue changed while you were editing</h4>
              <p className="mt-1 mb-0 max-w-[48ch]">
                Your draft is kept. Review differences below. Untouched fields will use the current
                version when you rebase.
              </p>
              {!draft.base && (
                <p className="mk-hint mt-2 mb-0 max-w-[48ch]">
                  This older saved draft has no original comparison. Review every difference before
                  keeping your edits.
                </p>
              )}
              {(["Your edited fields", "Changed by others"] as const).map((group) => {
                const keys = fieldKeys.filter((key) => {
                  const edited = !draft.base || !same(draft.fields[key], draft.base[key]);
                  return (
                    !same(initial.fields[key], draft.fields[key]) &&
                    edited === (group === "Your edited fields")
                  );
                });
                return (
                  keys.length > 0 && (
                    <section key={group}>
                      <h4 className="mt-4 mb-1 text-body-sm font-semibold">{group}</h4>
                      {keys.map((key) => {
                        const plain = key !== "description" && key !== "acceptance";
                        return (
                          <section key={key} className="border-t border-line-soft py-3">
                            <h5 className="m-0 mb-2 text-body-sm font-semibold">
                              {fieldNames[key]}
                            </h5>
                            <div className="mb-3 grid grid-cols-1 gap-3 [overflow-wrap:anywhere] sm:grid-cols-2">
                              <div className="min-w-0">
                                <strong className="mb-1 block text-label text-ink-muted">
                                  Theirs
                                </strong>
                                <div className={plain ? "whitespace-pre-wrap" : undefined}>
                                  {displayField(key, initial.fields)}
                                </div>
                              </div>
                              <div className="min-w-0">
                                <strong className="mb-1 block text-label text-ink-muted">
                                  {group === "Your edited fields"
                                    ? "Your draft"
                                    : "Original (you didn't edit)"}
                                </strong>
                                <div className={plain ? "whitespace-pre-wrap" : undefined}>
                                  {displayField(key, draft.fields)}
                                </div>
                              </div>
                            </div>
                            {group === "Your edited fields" ? (
                              <button
                                type="button"
                                className="mk-btn mk-btn--sm"
                                onClick={() => change(key, initial.fields[key])}
                              >
                                Use theirs for {fieldNames[key]}
                              </button>
                            ) : (
                              <p className="mk-hint m-0">
                                Theirs will be preserved when you rebase.
                              </p>
                            )}
                          </section>
                        );
                      })}
                    </section>
                  )
                );
              })}
              <button type="button" className="mk-btn mk-btn--sm mt-3" onClick={rebase}>
                Keep my edits — rebase on version {issue.version}
              </button>
            </section>
          )}
          <TextField
            label="Title"
            value={draft.fields.title}
            required
            maxLength={500}
            onChange={(event) => change("title", event.target.value)}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Status">
              <select
                className="mk-input"
                aria-label="Issue status"
                aria-describedby={statusReason}
                value={draft.fields.status}
                onChange={(event) => change("status", event.target.value as Issue["status"])}
              >
                {statuses.map((status) => (
                  <option
                    key={status.value}
                    value={status.value}
                    disabled={
                      status.value !== issue.status &&
                      (activeClaim ||
                        (unresolvedBlockers.length > 0 &&
                          (status.value === "in_progress" || status.value === "done")))
                    }
                  >
                    {status.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Type">
              <SelectField
                ariaLabel="Issue type"
                value={draft.fields.type}
                options={types.map((value) => ({ value, label: typeLabel(value) }))}
                onChange={(value) => change("type", value as Issue["type"])}
              />
            </Field>
            <Field label="Priority">
              <SelectField
                ariaLabel="Issue priority"
                value={String(draft.fields.priority)}
                options={[0, 1, 2, 3, 4].map((value) => ({
                  value: String(value),
                  label: `P${value}${value === 0 ? " · Urgent" : value === 4 ? " · Lowest" : ""}`,
                }))}
                onChange={(value) => change("priority", Number(value) as Issue["priority"])}
              />
            </Field>
            <Field label="Assignee">
              <SelectField
                ariaLabel="Issue assignee"
                value={draft.fields.assigneeId ?? ""}
                options={[{ value: "", label: "Unassigned" }, ...assignable]}
                onChange={(value) => change("assigneeId", value || null)}
              />
            </Field>
            <IssuePicker
              label="Parent issue"
              value={draft.fields.parentId ?? ""}
              issues={parentCandidates}
              allowNone
              onChange={(value) => change("parentId", value || null)}
            />
            <TextField
              label="Labels (comma separated)"
              value={draft.fields.labels.join(",")}
              onChange={(event) => change("labels", event.target.value.split(","))}
            />
          </div>
          <MultiCheck
            label="Workspaces"
            options={snapshot.workspaces.filter(
              (workspace) =>
                !workspace.archived || draft.fields.workspaceIds.includes(workspace.id),
            )}
            values={draft.fields.workspaceIds}
            onChange={(values) => change("workspaceIds", values)}
          />
          <button
            className="mk-btn mk-btn--sm"
            type="button"
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            {preview ? "Write Markdown" : "Preview Markdown"}
          </button>
          <Field label="Description / PRD">
            {preview ? (
              <div className="mk-well">
                <MarkdownText text={draft.fields.description || "No description yet."} />
              </div>
            ) : (
              <textarea
                aria-label="Description / PRD"
                className={TEXTAREA}
                rows={12}
                value={draft.fields.description}
                onChange={(event) => change("description", event.target.value)}
                placeholder="Describe the outcome, context, and approach. Markdown supported."
              />
            )}
          </Field>
          <Field label="Acceptance criteria">
            {preview ? (
              <div className="mk-well">
                <MarkdownText text={draft.fields.acceptance || "No acceptance criteria yet."} />
              </div>
            ) : (
              <textarea
                aria-label="Acceptance criteria"
                className={TEXTAREA}
                rows={6}
                value={draft.fields.acceptance}
                onChange={(event) => change("acceptance", event.target.value)}
                placeholder="- [ ] What must be true when this is done?"
              />
            )}
          </Field>
          <FormError message={localError} />
          <div className="flex flex-wrap gap-2">
            <button
              className="mk-btn mk-btn--primary mk-btn--sm"
              disabled={busy || draft.version !== issue.version || invalidStatus}
              aria-describedby={invalidStatus ? statusReason : undefined}
            >
              {busy ? "Saving…" : "Save issue"}
            </button>
            <button
              className="mk-btn mk-btn--ghost mk-btn--sm"
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft(initial);
                try {
                  sessionStorage.removeItem(storageKey);
                } catch {
                  /* Storage can be disabled. */
                }
              }}
            >
              Discard draft
            </button>
          </div>
        </form>
      ) : (
        <section className={SECTION}>
          <h3 className={`${HEADING} mb-2`}>Description / PRD</h3>
          {issue.description ? (
            <MarkdownText text={issue.description} />
          ) : (
            <p className="m-0 max-w-[48ch] text-body-sm text-ink-muted">
              No description yet. Edit this issue to add context or a full PRD.
            </p>
          )}
          <h3 className={`${HEADING} mt-5 mb-2`}>Acceptance criteria</h3>
          {issue.acceptance ? (
            <MarkdownText text={issue.acceptance} />
          ) : (
            <p className="m-0 text-body-sm text-ink-muted">No acceptance criteria yet.</p>
          )}
        </section>
      )}
      <section className={SECTION}>
        <h3 className={HEADING}>Dependencies & hierarchy</h3>
        <p className="mk-hint mt-0.5 mb-0 max-w-[48ch]">
          A blocker must be done to unblock work. Parents organize subtasks; they do not block them.
        </p>
        {parent && (
          <section>
            <h4 className={SUBHEADING}>Parent</h4>
            <Link className={`${LINK} text-body-sm [overflow-wrap:anywhere]`} to={href(parent.id)}>
              <span className="mk-mono">{parent.key}</span> · {parent.title}
            </Link>
          </section>
        )}
        <section>
          <h4 className={SUBHEADING}>Subtasks</h4>
          {children.length ? (
            <ul className={LIST}>
              {children.map((child) => (
                <li key={child.id} className={ROW}>
                  <Link className={`${LINK} min-w-0`} to={href(child.id)}>
                    <span className="mk-mono">{child.key}</span> · {child.title}
                  </Link>
                  <IssueState issue={child} snapshot={snapshot} index={index} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mk-hint m-0">No subtasks yet. Break this issue into smaller outcomes.</p>
          )}
          <form
            className="mt-3 flex flex-wrap items-end gap-2 [&>p]:m-0 [&>p]:basis-full"
            onSubmit={async (event) => {
              event.preventDefault();
              setNotice("");
              setSubtaskError("");
              setSubtaskNotice("");
              const title = subtaskTitle.trim();
              if (!title) {
                setSubtaskError("Give the subtask a title.");
                return;
              }
              const result = await mutate([
                {
                  kind: "issue.create",
                  id: crypto.randomUUID(),
                  data: {
                    title,
                    teamId: issue.teamId,
                    parentId: issue.id,
                    workspaceIds: inheritedWorkspaces.map((workspace) => workspace.id),
                  },
                },
              ]);
              if (result.ok) {
                setSubtaskTitle("");
                setSubtaskNotice(`Added subtask: ${title}`);
              } else setSubtaskError(result.error);
            }}
          >
            <TextField
              className="min-w-0 flex-[1_1_180px]"
              label="New subtask"
              value={subtaskTitle}
              maxLength={500}
              required
              placeholder="Next outcome…"
              onChange={(event) => {
                setSubtaskTitle(event.target.value);
                setSubtaskError("");
                setSubtaskNotice("");
                setNotice("");
              }}
            />
            <button className="mk-btn h-(--size-field)" disabled={busy || !subtaskTitle.trim()}>
              Add subtask
            </button>
            {issue.workspaceIds.length > 0 && (
              <p className="mk-hint max-w-[48ch]">
                {inheritedWorkspaces.length > 0
                  ? `Subtasks inherit active workspaces: ${inheritedWorkspaces.map((workspace) => workspace.name).join(", ")}.`
                  : "This issue's workspaces are archived. New subtasks will have no workspace."}
                {inheritedWorkspaces.length > 0 &&
                  inheritedWorkspaces.length < issue.workspaceIds.length &&
                  " Archived workspaces are not inherited."}
              </p>
            )}
            <FormError message={subtaskError} />
            {subtaskNotice && (
              <p className="mk-hint" role="status">
                {subtaskNotice}
              </p>
            )}
          </form>
        </section>
        {(["Blocked by", "Blocks", "Related", "Duplicates"] as const).map((group) => {
          const grouped = links.filter((link) =>
            group === "Blocked by"
              ? link.kind === "blocks" && link.toId === issue.id
              : group === "Blocks"
                ? link.kind === "blocks" && link.fromId === issue.id
                : link.kind === (group === "Related" ? "related" : "duplicates"),
          );
          return (
            grouped.length > 0 && (
              <section key={group}>
                <h4 className={SUBHEADING}>{group}</h4>
                <ul className={LIST}>
                  {grouped.map((link) => {
                    const other = index.byId.get(
                      link.fromId === issue.id ? link.toId : link.fromId,
                    );
                    return (
                      <li key={link.id} className={ROW}>
                        <Link className={`${LINK} min-w-0`} to={href(other?.id)}>
                          <span className="mk-mono">{other?.key}</span> · {other?.title}
                        </Link>
                        <div className="flex shrink-0 flex-col items-end">
                          <button
                            className="mk-btn mk-btn--ghost mk-btn--sm"
                            disabled={busy}
                            aria-label={`Remove ${group.toLowerCase()} relation with ${other?.key}`}
                            onClick={async () => {
                              setNotice("");
                              setRemoveError(null);
                              const result = await mutate([{ kind: "link.remove", id: link.id }]);
                              if (!result.ok) setRemoveError({ id: link.id, error: result.error });
                            }}
                          >
                            Remove
                          </button>
                          {removeError?.id === link.id && <FormError message={removeError.error} />}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )
          );
        })}
        <form
          className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] [&>button]:justify-self-start [&>:is(p,button)]:col-span-full"
          onSubmit={async (event) => {
            event.preventDefault();
            setNotice("");
            setRelationError("");
            if (!relationCandidates.some((item) => item.id === target)) {
              setRelationError("Choose an issue that does not create a dependency cycle.");
              return;
            }
            const result = await mutate([
              {
                kind: "link.add",
                id: crypto.randomUUID(),
                data: {
                  fromId: relation === "blocked_by" ? target : issue.id,
                  toId: relation === "blocked_by" ? issue.id : target,
                  kind:
                    relation === "blocked_by"
                      ? "blocks"
                      : (relation as "blocks" | "related" | "duplicates"),
                },
              },
            ]);
            if (result.ok) setTarget("");
            else setRelationError(result.error);
          }}
        >
          <Field label="Relation type">
            <SelectField
              ariaLabel="Relation type"
              value={relation}
              options={[
                { value: "blocks", label: "This issue blocks…" },
                { value: "blocked_by", label: "This issue is blocked by…" },
                { value: "related", label: "This issue is related to…" },
                { value: "duplicates", label: "This issue duplicates…" },
              ]}
              onChange={(value) => {
                setRelation(value);
                setTarget("");
                setRelationError("");
                setNotice("");
              }}
            />
          </Field>
          <IssuePicker
            label="Related issue"
            value={target}
            issues={relationCandidates}
            onChange={(value) => {
              setTarget(value);
              setRelationError("");
              setNotice("");
            }}
          />
          <FormError message={relationError} />
          <button
            className="mk-btn mk-btn--sm"
            disabled={busy || !target || !relationCandidates.some((item) => item.id === target)}
          >
            Add relation
          </button>
        </form>
      </section>
      <section className={SECTION}>
        <h3 className={HEADING}>Activity & handoff</h3>
        <p className="mk-hint mt-0.5 mb-0 max-w-[48ch]">
          Leave decisions, a checkpoint for the next agent, or evidence of completion.
        </p>
        {comments.length === 0 && (
          <p className="mt-3 mb-0 text-body-sm text-ink-muted">No activity notes yet.</p>
        )}
        <ol className="m-0 mb-3 list-none p-0">
          {comments.map((comment) => (
            <li
              key={comment.id}
              className="border-b border-line-soft py-3"
              data-kind={comment.kind}
            >
              <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-ink-muted">
                <Actor
                  who={attribution(snapshot, comment.actorId)}
                  className="[&>span:last-child]:font-semibold [&>span:last-child]:text-ink"
                />
                <span className="inline-flex items-center gap-1.5" data-kind={comment.kind}>
                  {comment.kind !== "comment" && (
                    <span
                      className={`size-1.5 rounded-full ${comment.kind === "checkpoint" ? "ring-[1.5px] ring-inset ring-ink" : "bg-online"}`}
                      aria-hidden
                    />
                  )}
                  {comment.kind[0]!.toUpperCase() + comment.kind.slice(1)}
                </span>
                <time
                  className="text-ink-faint tabular-nums"
                  dateTime={comment.createdAt}
                  title={new Date(comment.createdAt).toLocaleString()}
                >
                  {relativeTime(comment.createdAt, snapshot.serverTime)}
                </time>
              </header>
              <MarkdownText text={comment.body} />
            </li>
          ))}
        </ol>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setNotice("");
            setCommentError("");
            const result = await mutate([
              {
                kind: "comment.add",
                id: crypto.randomUUID(),
                data: { issueId: issue.id, body, kind },
              },
            ]);
            if (result.ok) setBody("");
            else setCommentError(result.error);
          }}
        >
          <Field label="Activity type">
            <SelectField
              ariaLabel="Activity type"
              value={kind}
              options={["comment", "checkpoint", "evidence"].map((value) => ({
                value,
                label: value[0]!.toUpperCase() + value.slice(1),
              }))}
              onChange={(value) => {
                setKind(value as Comment["kind"]);
                setCommentError("");
                setNotice("");
              }}
            />
          </Field>
          <textarea
            aria-label="Activity note"
            className={TEXTAREA}
            rows={4}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              setCommentError("");
              setNotice("");
            }}
            required
            placeholder="Add a note. Markdown supported."
          />
          <FormError message={commentError} />
          <button className="mk-btn mk-btn--sm" disabled={busy || !body.trim()}>
            Post {kind}
          </button>
        </form>
      </section>
    </article>
  );
}
