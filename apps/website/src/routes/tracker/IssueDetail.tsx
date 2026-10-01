import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { Comment, Issue, IssueFields, Mutation, Snapshot } from "../../../shared/tracker.ts";
import { FormError, SelectField, TextField } from "../../components/ui.tsx";
import {
  blockers,
  Field,
  IssuePicker,
  IssueState,
  MarkdownText,
  MultiCheck,
  statuses,
  types,
} from "./ui.tsx";

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
  mutate,
  busy,
  href,
}: {
  issue: Issue;
  snapshot: Snapshot;
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
  const activeClaim = !!issue.claim && issue.claim.expiresAt > snapshot.serverTime;
  const unresolvedBlockers = blockers(issue, snapshot);
  const invalidStatus =
    draft.fields.status !== issue.status &&
    (activeClaim ||
      (unresolvedBlockers.length > 0 &&
        (draft.fields.status === "in_progress" || draft.fields.status === "done")));
  const team = snapshot.teams.find((team) => team.id === issue.teamId);
  const members = snapshot.members.filter(
    (member) => !team?.memberIds.length || team.memberIds.includes(member.id),
  );
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
        !detailRef.current?.closest(".tracker-shell[data-shortcuts='true']") ||
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
  const descendants = new Set([issue.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of snapshot.issues) {
      if (item.parentId && descendants.has(item.parentId) && !descendants.has(item.id)) {
        descendants.add(item.id);
        changed = true;
      }
    }
  }
  const relationCandidates = snapshot.issues.filter((item) => {
    if (item.id === issue.id) return false;
    if (relation !== "blocks" && relation !== "blocked_by") return true;
    const from = relation === "blocks" ? issue.id : item.id;
    const to = relation === "blocks" ? item.id : issue.id;
    const visited = new Set<string>();
    const queue = [to];
    while (queue.length) {
      const current = queue.pop()!;
      if (current === from) return false;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const link of snapshot.links)
        if (link.kind === "blocks" && link.fromId === current) queue.push(link.toId);
    }
    return !snapshot.links.some(
      (link) => link.kind === "blocks" && link.fromId === from && link.toId === to,
    );
  });
  const latestCheckpoint = comments
    .filter((comment) => comment.kind === "checkpoint")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const parent = snapshot.issues.find((item) => item.id === issue.parentId);
  const children = snapshot.issues.filter((item) => item.parentId === issue.id);
  const inheritedWorkspaces = snapshot.workspaces.filter(
    (workspace) => !workspace.archived && issue.workspaceIds.includes(workspace.id),
  );
  const displayField = (key: keyof IssueFields, fields: IssueFields) => {
    const value = fields[key];
    if (key === "description" || key === "acceptance")
      return <MarkdownText text={String(value) || "Empty"} />;
    if (key === "assigneeId")
      return (
        snapshot.members.find((member) => member.id === value)?.displayName ??
        (value ? "Unavailable member" : "Unassigned")
      );
    if (key === "parentId") {
      const item = snapshot.issues.find((item) => item.id === value);
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
      className="tracker-detail"
      aria-label={`${issue.key} issue detail`}
    >
      <header className="tracker-detail-header">
        <div className="flex flex-wrap items-center gap-2">
          <Link className="gm-link tracker-back" to={href()}>
            Back to issues
          </Link>
          <span className="mk-mono text-ink-muted">{issue.key}</span>
          <IssueState issue={issue} snapshot={snapshot} />
        </div>
        <h2 className="mt-3 mb-2 text-headline break-words">{issue.title}</h2>
        <p className="m-0 text-body-sm text-ink-muted">
          {team?.name} · {issue.type.toUpperCase()} · P{issue.priority} ·{" "}
          {snapshot.members.find((member) => member.id === issue.assigneeId)?.displayName ??
            "Unassigned"}
        </p>
        {(issue.workspaceIds.length > 0 || issue.labels.length > 0) && (
          <dl className="tracker-detail-metadata">
            {issue.workspaceIds.length > 0 && (
              <div>
                <dt>Workspaces</dt>
                <dd>
                  {issue.workspaceIds.map((id) => (
                    <Link
                      className="gm-link"
                      key={id}
                      to={`/tracker/${snapshot.owner.slug}?workspace=${encodeURIComponent(id)}`}
                    >
                      {snapshot.workspaces.find((workspace) => workspace.id === id)?.name ??
                        "Unavailable workspace"}
                    </Link>
                  ))}
                </dd>
              </div>
            )}
            {issue.labels.length > 0 && (
              <div>
                <dt>Labels</dt>
                <dd>
                  {issue.labels.map((label) => (
                    <span className="mk-chip mk-chip--tag" key={label}>
                      {label}
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        )}
        {activeClaim && (
          <p className="tracker-handoff-note" data-kind="checkpoint" id="tracker-claim-reason">
            {issue.claim!.agent} is working on this issue until{" "}
            {new Date(issue.claim!.expiresAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            . You can edit its details, but only that agent can change its status until the claim
            ends.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {!editing && (
            <button className="mk-btn mk-btn--primary" aria-keyshortcuts="e" onClick={beginEdit}>
              Edit issue
            </button>
          )}
          {!editing && (issue.status === "todo" || issue.status === "backlog") && (
            <button
              className="mk-btn"
              disabled={busy || activeClaim || unresolvedBlockers.length > 0}
              aria-describedby={statusReason}
              onClick={() => void updateStatus("in_progress", "Work started.")}
            >
              Start work
            </button>
          )}
          {!editing && issue.status !== "done" && issue.status !== "canceled" && (
            <button
              className="mk-btn"
              disabled={busy || activeClaim || unresolvedBlockers.length > 0}
              aria-describedby={statusReason}
              onClick={() => void updateStatus("done", "Issue completed.")}
            >
              Mark done
            </button>
          )}
          {!editing && (issue.status === "done" || issue.status === "canceled") && (
            <button
              className="mk-btn"
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
          <p className="mk-hint mt-3" id="tracker-completion-blockers">
            Complete or remove {unresolvedBlockers.map((blocker) => blocker.key).join(", ")} before
            starting or completing this issue.
          </p>
        )}
      </header>
      {latestCheckpoint && (
        <section
          className="tracker-handoff-note"
          data-kind="checkpoint"
          aria-label="Latest checkpoint"
        >
          <h3 className="text-title">Latest checkpoint</h3>
          <p className="mk-hint">
            {snapshot.members.find((member) => member.id === latestCheckpoint.actorId)
              ?.displayName ?? "Agent"}
            {" · "}
            <time
              dateTime={latestCheckpoint.createdAt}
              title={new Date(latestCheckpoint.createdAt).toLocaleString()}
            >
              {relativeTime(latestCheckpoint.createdAt, snapshot.serverTime)}
            </time>
          </p>
          <MarkdownText text={latestCheckpoint.body} />
        </section>
      )}
      {notice && (
        <p className="mk-hint" role="status">
          {notice}
        </p>
      )}
      {editing ? (
        <form
          className="tracker-section space-y-4"
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
          <h3 className="text-title m-0">Edit issue</h3>
          {draft.version !== issue.version && (
            <section className="tracker-conflict" role="alert">
              <h4 className="m-0 font-semibold">This issue changed while you were editing</h4>
              <p>
                Your draft is kept. Review differences below. Untouched fields will use the current
                version when you rebase.
              </p>
              {!draft.base && (
                <p className="mk-hint">
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
                    <section key={group} className="tracker-conflict-group">
                      <h4>{group}</h4>
                      {keys.map((key) => (
                        <section key={key} className="tracker-field-comparison">
                          <h5>{fieldNames[key]}</h5>
                          <div
                            className="tracker-comparison-values"
                            data-plain-text={key !== "description" && key !== "acceptance"}
                          >
                            <div>
                              <strong>Theirs</strong>
                              <div>{displayField(key, initial.fields)}</div>
                            </div>
                            <div>
                              <strong>
                                {group === "Your edited fields"
                                  ? "Your draft"
                                  : "Original (you didn't edit)"}
                              </strong>
                              <div>{displayField(key, draft.fields)}</div>
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
                            <p className="mk-hint">Theirs will be preserved when you rebase.</p>
                          )}
                        </section>
                      ))}
                    </section>
                  )
                );
              })}
              <button type="button" className="mk-btn mt-3" onClick={rebase}>
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
          <div className="tracker-form-grid">
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
                options={types.map((value) => ({ value, label: value.toUpperCase() }))}
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
                options={[
                  { value: "", label: "Unassigned" },
                  ...members.map((member) => ({ value: member.id, label: member.displayName })),
                ]}
                onChange={(value) => change("assigneeId", value || null)}
              />
            </Field>
            <IssuePicker
              label="Parent issue"
              value={draft.fields.parentId ?? ""}
              issues={snapshot.issues.filter((item) => !descendants.has(item.id))}
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
                className="mk-input tracker-markdown"
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
                className="mk-input tracker-markdown"
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
              className="mk-btn mk-btn--primary"
              disabled={busy || draft.version !== issue.version || invalidStatus}
              aria-describedby={invalidStatus ? statusReason : undefined}
            >
              {busy ? "Saving…" : "Save issue"}
            </button>
            <button
              className="mk-btn mk-btn--ghost"
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
        <>
          <section className="tracker-section">
            <h3 className="text-title">Description / PRD</h3>
            {issue.description ? (
              <MarkdownText text={issue.description} />
            ) : (
              <p className="text-ink-muted">
                No description yet. Edit this issue to add context or a full PRD.
              </p>
            )}
            <h3 className="text-title tracker-acceptance-heading">Acceptance criteria</h3>
            {issue.acceptance ? (
              <MarkdownText text={issue.acceptance} />
            ) : (
              <p className="text-ink-muted">No acceptance criteria yet.</p>
            )}
          </section>
        </>
      )}
      <section className="tracker-section">
        <h3 className="text-title">Dependencies & hierarchy</h3>
        <p className="mk-hint">
          A blocker must be done to unblock work. Parents organize subtasks; they do not block them.
        </p>
        {parent && (
          <section>
            <h4 className="tracker-detail-subheading">Parent</h4>
            <Link className="gm-link" to={href(parent.id)}>
              {parent.key} · {parent.title}
            </Link>
          </section>
        )}
        <section>
          <h4 className="tracker-detail-subheading">Subtasks</h4>
          {children.length ? (
            <ul className="tracker-relations">
              {children.map((child) => (
                <li key={child.id}>
                  <Link className="gm-link" to={href(child.id)}>
                    {child.key} · {child.title}
                  </Link>
                  <IssueState issue={child} snapshot={snapshot} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mk-hint">No subtasks yet. Break this issue into smaller outcomes.</p>
          )}
          <form
            className="tracker-subtask-form"
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
              label="New subtask"
              value={subtaskTitle}
              maxLength={500}
              required
              placeholder="Describe the next outcome…"
              onChange={(event) => {
                setSubtaskTitle(event.target.value);
                setSubtaskError("");
                setSubtaskNotice("");
                setNotice("");
              }}
            />
            <button className="mk-btn" disabled={busy || !subtaskTitle.trim()}>
              Add subtask
            </button>
            {issue.workspaceIds.length > 0 && (
              <p className="mk-hint">
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
                <h4 className="tracker-detail-subheading">{group}</h4>
                <ul className="tracker-relations">
                  {grouped.map((link) => {
                    const other = snapshot.issues.find(
                      (item) => item.id === (link.fromId === issue.id ? link.toId : link.fromId),
                    );
                    return (
                      <li key={link.id}>
                        <Link className="gm-link" to={href(other?.id)}>
                          {other?.key} · {other?.title}
                        </Link>
                        <div>
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
          className="tracker-relation-form"
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
            className="mk-btn"
            disabled={busy || !relationCandidates.some((item) => item.id === target)}
          >
            Add relation
          </button>
        </form>
      </section>
      <section className="tracker-section">
        <h3 className="text-title">Activity & handoff</h3>
        <p className="mk-hint">
          Leave decisions, a checkpoint for the next agent, or evidence of completion.
        </p>
        {comments.length === 0 && <p className="text-ink-muted">No activity notes yet.</p>}
        <ol className="tracker-activity">
          {comments.map((comment) => (
            <li key={comment.id} className="tracker-handoff-entry" data-kind={comment.kind}>
              <header>
                <strong>
                  {snapshot.members.find((member) => member.id === comment.actorId)?.displayName ??
                    comment.actorId}
                </strong>
                <span className="tracker-activity-kind" data-kind={comment.kind}>
                  {comment.kind[0]!.toUpperCase() + comment.kind.slice(1)}
                </span>
                <time
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
            className="mk-input tracker-markdown"
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
          <button className="mk-btn" disabled={busy || !body.trim()}>
            Post {kind}
          </button>
        </form>
      </section>
    </article>
  );
}
