import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { Link, useBlocker } from "react-router";
import {
  actorName,
  attribution,
  claimAttribution,
  CLOSE_REASONS,
  ISSUE_PICKUPS,
  issuePickup,
  issueTimeline,
  issueTimelineText,
  leasedAncestor,
  readinessIndex,
  type Comment,
  type Issue,
  type IssueCloseReason,
  type IssueFields,
  type Mutation,
  type Snapshot,
  type TrackerEvent,
} from "../../../shared/tracker.ts";
import {
  ConfirmDialog,
  FormError,
  link as LINK,
  SelectField,
  TextField,
} from "../../components/ui.tsx";
import {
  blockers,
  ClaimIcon,
  CloseReasonField,
  Field,
  IssuePicker,
  IssueState,
  MarkdownText,
  MultiCheck,
  PickupField,
  statuses,
  statusLabel,
  TimelineFields,
  typeLabel,
  types,
} from "./ui.tsx";
import type { IssueIndex } from "./query.ts";
import { RequestCard } from "./Requests.tsx";
import { DoneInTimelineCallout, LockedStatusHint, lockedIn } from "./DoneInTimeline.tsx";
import { useViewer } from "../../lib/session.ts";
import { Actor } from "./Actor.tsx";
import { repoPath } from "../../lib/refs.ts";
import { useRememberPlace } from "../../lib/recentPlaces.ts";
import { AuditHistory, AuditIdentity } from "./AuditHistory.tsx";
import { LabelPicker } from "./Labels.tsx";
import { LinkedWorkPanel } from "./LinkedWork.tsx";
import { Requirements } from "./Requirements.tsx";

export type MutationOutcome =
  | { ok: true; events: TrackerEvent[] }
  | { ok: false; error: string; code?: string };
export type Mutate = (mutations: Mutation[]) => Promise<MutationOutcome>;
type EditMode = "all" | "title" | "description" | "acceptance";
type Draft = { version: number; fields: IssueFields; base?: IssueFields; mode?: EditMode };
const fieldNames: Record<keyof IssueFields, string> = {
  title: "Title",
  description: "Description / PRD",
  acceptance: "Acceptance criteria",
  type: "Type",
  status: "Status",
  pickup: "Pickup",
  closeReason: "Close reason",
  timelineUse: "Timeline",
  timelinePolicy: "Timeline policy",
  priority: "Priority",
  assigneeId: "Assignee",
  parentId: "Parent issue",
  workspaceIds: "Workspaces",
  labels: "Tags",
};
const fieldKeys = Object.keys(fieldNames) as (keyof IssueFields)[];
const textFields = new Set<keyof IssueFields>(["title", "description", "acceptance"]);
const fieldsOf = (issue: Issue): IssueFields => ({
  title: issue.title,
  description: issue.description,
  acceptance: issue.acceptance,
  type: issue.type,
  status: issue.status,
  pickup: issuePickup(issue),
  closeReason: issue.closeReason ?? null,
  timelineUse: issueTimeline(issue).use,
  timelinePolicy: issueTimeline(issue).policy,
  priority: issue.priority,
  assigneeId: issue.assigneeId,
  parentId: issue.parentId,
  workspaceIds: issue.workspaceIds,
  labels: issue.labels,
});

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
    : a === b || (a == null && b == null);
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
  initialEditing = false,
}: {
  issue: Issue;
  snapshot: Snapshot;
  /** The workbench's index; keeps lookups constant-time at tens of thousands of issues. */
  index: IssueIndex;
  mutate: Mutate;
  busy: boolean;
  href: (id?: string) => string;
  initialEditing?: boolean;
}) {
  const storageKey = `gitmatrix:issue-draft:${snapshot.owner.id}:${issue.id}`;
  useRememberPlace({
    kind: "issue",
    title: issue.key,
    detail: issue.title,
    to: `/tracker/${encodeURIComponent(snapshot.owner.slug)}/issues/${encodeURIComponent(issue.id)}`,
  });
  const initial: Draft = {
    version: issue.version,
    fields: fieldsOf(issue),
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
  const mode = draft.mode ?? "all";
  const [editing, setEditing] = useState(() => {
    try {
      return initialEditing || !!sessionStorage.getItem(storageKey);
    } catch {
      return initialEditing;
    }
  });
  const [preview, setPreview] = useState(false);
  const [localError, setLocalError] = useState("");
  const [pendingFields, setPendingFields] = useState<(keyof IssueFields)[]>([]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const [finishRequested, setFinishRequested] = useState<"explicit" | "blur" | null>(null);
  const [updatedField, setUpdatedField] = useState<EditMode | null>(null);
  const discardButtonRef = useRef<HTMLButtonElement>(null);
  const dirty = fieldKeys.some((key) => !same(draft.fields[key], draft.base?.[key]));
  const hasUnsavedChanges = dirty || saving || pendingFields.length > 0;
  const navigation = useBlocker(hasUnsavedChanges);
  const enqueue = (keys: (keyof IssueFields)[]) => {
    setPendingFields((previous) => [...new Set([...previous, ...keys])]);
    setLocalError("");
  };
  const saveOnBlur = (event: FocusEvent, field: keyof IssueFields) => {
    // Discard must retain its error controls until its click runs, without saving.
    if (discardButtonRef.current && event.relatedTarget === discardButtonRef.current) return;
    enqueue([field]);
  };
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<Comment["kind"]>("comment");
  const [relation, setRelation] = useState("blocks");
  const [target, setTarget] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [closing, setClosing] = useState(false);
  const [closeReason, setCloseReason] = useState<IssueCloseReason | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeFormRef = useRef<HTMLFormElement>(null);
  const [relationError, setRelationError] = useState("");
  const [commentError, setCommentError] = useState("");
  const [subtaskError, setSubtaskError] = useState("");
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [subtaskNotice, setSubtaskNotice] = useState("");
  const [removeError, setRemoveError] = useState<{ id: string; error: string } | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const firstFocus = useRef(true);
  useLayoutEffect(() => {
    if (editing)
      detailRef.current
        ?.querySelector<HTMLElement>("[data-issue-editor] input, [data-issue-editor] textarea")
        ?.focus();
    else if (firstFocus.current && window.matchMedia("(max-width: 760px)").matches)
      detailRef.current?.focus();
    firstFocus.current = false;
  }, [editing, mode]);
  useEffect(() => {
    if (!updatedField) return;
    const timeout = setTimeout(() => setUpdatedField(null), 4000);
    return () => clearTimeout(timeout);
  }, [updatedField]);
  useEffect(() => {
    if (closing) closeFormRef.current?.querySelector("select")?.focus();
  }, [closing]);
  useEffect(() => {
    if (busy) {
      setNotice("");
      setSubtaskNotice("");
    }
  }, [busy]);
  useEffect(() => {
    try {
      if (hasUnsavedChanges) sessionStorage.setItem(storageKey, JSON.stringify(draft));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* The in-memory draft remains usable when storage is unavailable. */
    }
  }, [draft, hasUnsavedChanges, storageKey]);
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [hasUnsavedChanges]);
  useEffect(() => {
    if (navigation.state === "blocked" && !hasUnsavedChanges) navigation.proceed();
  }, [navigation, hasUnsavedChanges]);
  const change = <K extends keyof IssueFields>(
    key: K,
    value: IssueFields[K],
    autosave = !textFields.has(key),
  ) => {
    setNotice("");
    setLocalError("");
    setSaved(false);
    setDraft((previous) => ({
      ...previous,
      fields: {
        ...previous.fields,
        [key]: value,
        ...(key === "status" && value !== "canceled" ? { closeReason: null } : {}),
      },
    }));
    // Editing a queued/failed text value makes it a draft again until its next blur.
    if (textFields.has(key))
      setPendingFields((previous) => previous.filter((field) => field !== key));
    // Paired fields save together: the server validates them as one rule.
    if (autosave)
      enqueue(
        key === "status" || key === "closeReason"
          ? ["status", "closeReason"]
          : key === "timelineUse" || key === "timelinePolicy"
            ? ["timelineUse", "timelinePolicy"]
            : [key],
      );
  };
  const links = snapshot.links.filter((link) => link.fromId === issue.id || link.toId === issue.id);
  const comments = snapshot.comments.filter((comment) => comment.issueId === issue.id);
  // The issue's own lease, or an ancestor's: either way only its holder changes the status.
  // A lease retained by a timeline (CORE-75) doesn't guard a reopen there.
  const covering =
    issue.claim && !issue.claim.retainedIn && issue.claim.expiresAt > snapshot.serverTime
      ? issue
      : leasedAncestor(issue, readinessIndex(snapshot.issues, snapshot.links), snapshot.serverTime);
  const activeClaim = covering !== null;
  const unresolvedBlockers = blockers(issue, snapshot, index);
  const invalidStatus =
    draft.fields.status !== issue.status &&
    (activeClaim ||
      (unresolvedBlockers.length > 0 &&
        (draft.fields.status === "in_progress" || draft.fields.status === "done")));
  const requiresCloseReason =
    draft.fields.status === "canceled" && (issue.status !== "canceled" || !!issue.closeReason);
  const invalidCloseReason = requiresCloseReason && !draft.fields.closeReason;
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
  const beginEdit = (mode: EditMode = "all") => {
    setClosing(false);
    setDraft((previous) =>
      hasUnsavedChanges || previous.version > issue.version
        ? { ...previous, mode }
        : { ...initial, mode },
    );
    setPreview(false);
    setNotice("");
    setActionError("");
    if (!hasUnsavedChanges) setLocalError("");
    setEditing(true);
    if (!hasUnsavedChanges) setPendingFields([]);
    setSaved(false);
    setFinishRequested(null);
    setUpdatedField(null);
  };
  const discardEdit = () => {
    setEditing(false);
    setDraft(initial);
    setNotice("");
    setLocalError("");
    setSaved(false);
    setUpdatedField(null);
    setPendingFields([]);
    setFinishRequested(null);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Storage can be disabled. */
    }
    requestAnimationFrame(() =>
      detailRef.current?.querySelector<HTMLElement>(`[data-edit-field="${mode}"]`)?.focus(),
    );
  };
  const requestFinish = (restoreFocus = true) => {
    if (localError) return;
    enqueue(fieldKeys);
    setUpdatedField(null);
    // Invalid work stays open for correction; a failed save requires explicit retry.
    if (!draft.fields.title.trim() || invalidStatus || invalidCloseReason) return;
    setFinishRequested(restoreFocus ? "explicit" : "blur");
    setEditing(false);
    if (restoreFocus)
      requestAnimationFrame(() =>
        detailRef.current?.querySelector<HTMLElement>(`[data-edit-field="${mode}"]`)?.focus(),
      );
  };
  const retrySave = () => {
    enqueue(fieldKeys);
    if (!editing) setFinishRequested("blur");
  };
  useEffect(() => {
    if (finishRequested && !hasUnsavedChanges && !localError) {
      if (saved) setUpdatedField(mode);
      setFinishRequested(null);
    }
  });
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
  // Done in a timeline (CORE-74): locked here; it lands with the timeline or reopens there.
  const locked = lockedIn(issue);
  const statusReason =
    [
      unresolvedBlockers.length ? "tracker-completion-blockers" : "",
      activeClaim ? "tracker-claim-reason" : "",
      issue.status === "done_in_timeline" ? "tracker-done-in-timeline" : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const updateStatus = async (
    status: Issue["status"],
    message: string,
    reason: IssueCloseReason | null = null,
  ) => {
    setNotice("");
    setActionError("");
    const result = await mutate([
      {
        kind: "issue.update",
        id: issue.id,
        expectedVersion: issue.version,
        data: { status, closeReason: status === "canceled" ? reason : null },
      },
    ]);
    if (result.ok) {
      setNotice(message);
      if (closing) {
        setClosing(false);
        detailRef.current?.focus();
      }
    } else setActionError(result.error);
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
    if (key === "status") return statusLabel({ status: fields.status, doneIn: issue.doneIn });
    if (key === "closeReason")
      return fields.closeReason ? CLOSE_REASONS[fields.closeReason] : "No reason recorded";
    if (key === "priority") return `P${fields.priority}`;
    if (key === "pickup") return ISSUE_PICKUPS[issuePickup(fields)];
    if (key === "timelineUse") return issueTimelineText(fields);
    if (key === "timelinePolicy") return fields.timelinePolicy ?? "Either policy";
    return String(value);
  };
  const rebase = () => {
    setDraft((previous) => {
      const fields = { ...initial.fields };
      for (const key of fieldKeys) {
        if (!previous.base || !same(previous.fields[key], previous.base[key]))
          Object.assign(fields, { [key]: previous.fields[key] });
      }
      return { ...previous, version: issue.version, base: initial.fields, fields };
    });
    retrySave();
  };
  useEffect(() => {
    if (busy || savingRef.current || localError || !pendingFields.length) return;
    const fields = {
      ...draft.fields,
      closeReason: draft.fields.status === "canceled" ? (draft.fields.closeReason ?? null) : null,
      labels: normalizedSet(draft.fields.labels),
      workspaceIds: normalizedSet(draft.fields.workspaceIds),
    };
    const changes = Object.fromEntries(
      pendingFields
        .filter((key) => !same(fields[key], (draft.base ?? initial.fields)[key]))
        .map((key) => [key, fields[key]]),
    ) as Partial<IssueFields>;
    // An old canceled issue can retain its missing reason until explicitly reopened.
    if (fields.status === "canceled" && !fields.closeReason) delete changes.closeReason;
    if (!Object.keys(changes).length) {
      setPendingFields([]);
      return;
    }
    if (draft.version < issue.version) {
      setLocalError("Review the newer version before saving.");
      return;
    }
    if (!fields.title.trim()) {
      setLocalError("Give this issue a title.");
      return;
    }
    if (invalidStatus) {
      setLocalError("Resolve the blockers or active claim before changing this status.");
      return;
    }
    if (invalidCloseReason) {
      setLocalError("Choose a reason for closing this issue.");
      return;
    }
    // Only committed field gestures enter this queue. Typing in another field
    // during a request stays local until that field blurs.
    const submitted = draft;
    const attempted = pendingFields;
    savingRef.current = true;
    setSaving(true);
    setSaved(false);
    setPendingFields([]);
    void (async () => {
      try {
        const result = await mutate([
          { kind: "issue.update", id: issue.id, expectedVersion: submitted.version, data: changes },
        ]);
        if (!result.ok) throw new Error(result.error);
        const acknowledged = result.events.findLast(
          (event) => event.entityType === "issue" && event.entityId === issue.id,
        )?.entity as Issue | undefined;
        if (!acknowledged)
          throw new Error("The saved issue could not be confirmed. Refresh and retry.");
        const base = fieldsOf(acknowledged);
        setDraft((previous) => {
          const next = { ...base };
          for (const key of fieldKeys) {
            const unchanged = same(
              previous.fields[key],
              key in changes ? submitted.fields[key] : (submitted.base ?? initial.fields)[key],
            );
            if (!unchanged) Object.assign(next, { [key]: previous.fields[key] });
          }
          return { ...previous, version: acknowledged.version, base, fields: next };
        });
        setSaved(true);
      } catch (cause) {
        setLocalError(
          cause instanceof Error ? cause.message : "Could not save. Your draft is kept.",
        );
        setPendingFields((previous) => [...new Set([...attempted, ...previous])]);
        setFinishRequested(null);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
  });
  const optimisticFields =
    !editing && (hasUnsavedChanges || draft.version > issue.version)
      ? draft.fields
      : initial.fields;
  const updating = !editing && !localError && (saving || pendingFields.length > 0);
  const needsReview = !saving && hasUnsavedChanges && draft.version < issue.version;
  const updatingNotice = updating && (
    <span
      className="mk-chip mk-chip--tag"
      role="status"
      aria-label={`${mode === "all" ? "Issue" : fieldNames[mode]} updating`}
    >
      Updating…
    </span>
  );
  const updatedNotice = updatedField && !hasUnsavedChanges && !localError && (
    <span
      className="mk-chip mk-chip--tag gap-1"
      role="status"
      aria-label={`${updatedField === "all" ? "Issue" : fieldNames[updatedField]} updated`}
    >
      <CheckIcon className="size-3 text-online" weight="bold" aria-hidden />
      Updated
    </span>
  );
  const recovery = (
    <div className="space-y-3">
      <FormError message={localError} />
      {(localError || needsReview) && (
        <div className="flex flex-wrap gap-2">
          <button
            className="mk-btn mk-btn--sm"
            type="button"
            disabled={busy || saving}
            onClick={retrySave}
          >
            Retry saving
          </button>
          <button
            ref={discardButtonRef}
            className="mk-btn mk-btn--ghost mk-btn--sm"
            type="button"
            disabled={busy || saving}
            onClick={discardEdit}
          >
            Discard unsaved changes
          </button>
          {!editing && (
            <button
              className="mk-btn mk-btn--ghost mk-btn--sm"
              type="button"
              onClick={() => beginEdit(mode)}
            >
              Review draft
            </button>
          )}
        </div>
      )}
      {navigation.state === "blocked" && (
        <p className="mk-hint m-0" role="status">
          Finish saving before leaving this issue.{" "}
          <button className={LINK} type="button" onClick={() => navigation.reset()}>
            Keep editing
          </button>
        </p>
      )}
      {needsReview && (
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
                        <h5 className="m-0 mb-2 text-body-sm font-semibold">{fieldNames[key]}</h5>
                        <div className="mb-3 grid grid-cols-1 gap-3 [overflow-wrap:anywhere] sm:grid-cols-2">
                          <div className="min-w-0">
                            <strong className="mb-1 block text-label text-ink-muted">Theirs</strong>
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
                            onClick={() => change(key, initial.fields[key], false)}
                          >
                            Use theirs for {fieldNames[key]}
                          </button>
                        ) : (
                          <p className="mk-hint m-0">Theirs will be preserved when you rebase.</p>
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
      {!editing && (localError || needsReview) && (
        <p className="mk-hint m-0" role="status">
          Not saved
        </p>
      )}
    </div>
  );
  const editor = editing && (
    <form
      className="space-y-4"
      data-issue-editor
      aria-label={mode === "all" ? "Edit issue" : `Edit ${fieldNames[mode]}`}
      onFocusCapture={() => setUpdatedField(null)}
      onBlur={(event) => {
        // Dismiss the form immediately; the detail owns its submitted save queue.
        if (
          mode !== "all" &&
          !(
            event.relatedTarget instanceof Element &&
            event.currentTarget.contains(event.relatedTarget)
          )
        )
          requestFinish(false);
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        } else if (
          event.key === "Escape" &&
          !(
            event.target instanceof Element &&
            event.target.closest("select, [role=combobox], [role=listbox]")
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          requestFinish();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        requestFinish();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {mode === "all" && <h3 className={HEADING}>Edit issue</h3>}
          <p className="mk-hint m-0" role="status" aria-live="polite">
            {saving || (!localError && pendingFields.length > 0)
              ? "Updating…"
              : localError
                ? "Not saved"
                : dirty
                  ? "Unsaved changes"
                  : saved
                    ? "Updated"
                    : "Changes save automatically"}
          </p>
        </div>
        <button className="mk-btn mk-btn--ghost mk-btn--sm" type="submit">
          Done
        </button>
      </div>
      <p className="mk-hint m-0">Text saves when you leave a field. Selections save immediately.</p>
      {recovery}
      {(mode === "all" || mode === "title") && (
        <TextField
          label="Title"
          value={draft.fields.title}
          required
          maxLength={500}
          onChange={(event) => change("title", event.target.value)}
          onBlur={(event) => saveOnBlur(event, "title")}
        />
      )}
      {mode === "all" && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Status">
              <select
                className="mk-input"
                aria-label="Issue status"
                aria-describedby={statusReason}
                disabled={issue.status === "done_in_timeline"}
                title={
                  locked
                    ? `Done in timeline ${locked.slug}: it lands with the timeline, or reopen it there.`
                    : undefined
                }
                value={draft.fields.status}
                onChange={(event) => change("status", event.target.value as Issue["status"])}
              >
                {issue.status === "done_in_timeline" && (
                  <option value="done_in_timeline" disabled>
                    {statusLabel(issue)}
                  </option>
                )}
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
              <LockedStatusHint issue={issue} owner={snapshot.owner.slug} />
            </Field>
            {draft.fields.status === "canceled" && (
              <CloseReasonField
                value={draft.fields.closeReason}
                required={requiresCloseReason}
                onChange={(value) => change("closeReason", value)}
              />
            )}
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
            <PickupField
              value={draft.fields.pickup}
              onChange={(value) => change("pickup", value)}
            />
            <TimelineFields
              use={draft.fields.timelineUse}
              policy={draft.fields.timelinePolicy}
              onChange={(timelineUse, timelinePolicy) => {
                change("timelineUse", timelineUse);
                change("timelinePolicy", timelinePolicy);
              }}
            />
            <IssuePicker
              label="Parent issue"
              value={draft.fields.parentId ?? ""}
              issues={parentCandidates}
              allowNone
              onChange={(value) => change("parentId", value || null)}
            />
            <LabelPicker
              options={snapshot.labels}
              values={draft.fields.labels}
              onChange={(values) => change("labels", values)}
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
        </>
      )}
      {mode !== "title" && (
        <button
          className="mk-btn mk-btn--sm"
          type="button"
          aria-pressed={preview}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Write Markdown" : "Preview Markdown"}
        </button>
      )}
      {(mode === "all" || mode === "description") && (
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
              onBlur={(event) => saveOnBlur(event, "description")}
              placeholder="Describe the outcome, context, and approach. Markdown supported."
            />
          )}
        </Field>
      )}
      {(mode === "all" || mode === "acceptance") && (
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
              onBlur={(event) => saveOnBlur(event, "acceptance")}
              placeholder="- [ ] What must be true when this is done?"
            />
          )}
        </Field>
      )}
      <p className="mk-hint m-0">
        Ctrl/Cmd+Enter or Esc finishes editing. Saving continues after closing.
      </p>
    </form>
  );

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
        {editing && mode === "title" ? (
          <div className="mt-2">{editor}</div>
        ) : (
          <h2 className="mt-1 mb-0 text-title-lg break-words">
            <button
              type="button"
              className="w-full rounded-control text-left hover:bg-sunken disabled:bg-transparent max-sm:min-h-11"
              title="Edit title"
              data-edit-field="title"
              disabled={busy || editing}
              onClick={() => beginEdit("title")}
            >
              {optimisticFields.title}
            </button>
          </h2>
        )}
        {(mode === "title" || mode === "all") && (updating || updatedField === mode) && (
          <div className="mt-1 flex justify-end">{updatingNotice || updatedNotice}</div>
        )}
        <DoneInTimelineCallout issue={issue} snapshot={snapshot} />
        <dl className={`${META} mt-3`}>
          <dt className="text-ink-faint">Created by</dt>
          <dd className="m-0 min-w-0">
            <AuditIdentity actor={issue.createdBy} snapshot={snapshot} />
          </dd>
          <dt className="text-ink-faint">Created</dt>
          <dd className="m-0 min-w-0">
            <time dateTime={issue.createdAt} title={issue.createdAt}>
              {new Date(issue.createdAt).toLocaleString()}
            </time>
          </dd>
          <dt className="text-ink-faint">Team</dt>
          <dd className="m-0 min-w-0">{team?.name}</dd>
          <dt className="text-ink-faint">Type</dt>
          <dd className="m-0 min-w-0">{typeLabel(issue.type)}</dd>
          <dt className="text-ink-faint">Priority</dt>
          <dd className="m-0 min-w-0">P{issue.priority}</dd>
          <dt className="text-ink-faint">Pickup</dt>
          <dd className="m-0 min-w-0">{ISSUE_PICKUPS[issuePickup(issue)]}</dd>
          <dt className="text-ink-faint">Timeline</dt>
          <dd className="m-0 min-w-0">{issueTimelineText(issue)}</dd>
          {issue.status === "canceled" && (
            <>
              <dt className="text-ink-faint">Close reason</dt>
              <dd className="m-0 min-w-0">
                {issue.closeReason ? CLOSE_REASONS[issue.closeReason] : "No reason recorded"}
              </dd>
            </>
          )}
          {(issue.attempts ?? 0) > 0 && (
            <>
              <dt className="text-ink-faint">Attempts</dt>
              <dd className="m-0 min-w-0">{issue.attempts} released unfinished</dd>
            </>
          )}
          <dt className="text-ink-faint">Assignee</dt>
          <dd className="m-0 min-w-0">
            {issue.assigneeId ? (
              <Actor who={attribution(snapshot, issue.assigneeId)} link />
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
              <dt className="text-ink-faint">Tags</dt>
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
        <Requirements issue={issue} snapshot={snapshot} mutate={mutate} busy={busy} />
        {issue.queueFailure && (
          <section className={`${SECTION} mt-4`} aria-label="Queue failure">
            <h3 className={HEADING}>Queue failure</h3>
            <p className="mt-1 mb-3 text-body-sm text-ink-muted">
              System-recorded evidence, not editable issue fields. Admission does not mean landed or
              deployed. Inspect the run before claiming recovery.
            </p>
            <dl className={META}>
              <dt className="text-ink-faint">Kind</dt>
              <dd className="m-0 min-w-0">{issue.queueFailure.kind.replaceAll("_", " ")}</dd>
              <dt className="text-ink-faint">Stage</dt>
              <dd className="m-0 min-w-0">{issue.queueFailure.stage}</dd>
              <dt className="text-ink-faint">Reason</dt>
              <dd className="m-0 min-w-0 break-words">{issue.queueFailure.reason}</dd>
              <dt className="text-ink-faint">Repository</dt>
              <dd className="m-0 min-w-0 break-all">{issue.queueFailure.repo}</dd>
              <dt className="text-ink-faint">Commit</dt>
              <dd className="mk-mono m-0 min-w-0 break-all">{issue.queueFailure.commit}</dd>
              <dt className="text-ink-faint">Queue ID</dt>
              <dd className="mk-mono m-0 min-w-0 break-all">{issue.queueFailure.queueId}</dd>
              <dt className="text-ink-faint">CI run</dt>
              <dd className="m-0 min-w-0">
                {issue.queueFailure.runNumber === null ? (
                  "No run recorded"
                ) : (
                  <Link
                    className={`${LINK} inline-flex min-h-11 items-center`}
                    to={repoPath(
                      issue.queueFailure.repo.split("/")[0]!,
                      issue.queueFailure.repo.split("/")[1]!,
                      "ci",
                      String(issue.queueFailure.runNumber),
                    )}
                  >
                    Run #{issue.queueFailure.runNumber}
                  </Link>
                )}
              </dd>
              <dt className="text-ink-faint">Failed jobs</dt>
              <dd className="m-0 min-w-0 break-words">
                {issue.queueFailure.failedJobs.length
                  ? issue.queueFailure.failedJobs.join(", ")
                  : "None recorded"}
              </dd>
              <dt className="text-ink-faint">Conflict paths</dt>
              <dd className="m-0 min-w-0">
                {issue.queueFailure.conflictPaths.length ? (
                  <ul className={`${LIST} space-y-1`}>
                    {issue.queueFailure.conflictPaths.map((path) => (
                      <li className="mk-mono break-all" key={path}>
                        {path}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "None recorded"
                )}
              </dd>
              <dt className="text-ink-faint">Classifier</dt>
              <dd className="m-0 min-w-0 break-words">
                {issue.queueFailure.classificationModel ?? "No model recorded"}
              </dd>
              <dt className="text-ink-faint">Repair model</dt>
              <dd className="m-0 min-w-0 break-words">
                {issue.queueFailure.repairModel ?? "No model recorded"}
              </dd>
              <dt className="text-ink-faint">Occurred</dt>
              <dd className="m-0 min-w-0">
                <time dateTime={issue.queueFailure.occurredAt}>
                  {new Date(issue.queueFailure.occurredAt).toLocaleString()}
                </time>
              </dd>
            </dl>
          </section>
        )}
        {activeClaim && (
          <p
            className="mt-3 mb-0 flex gap-2 rounded-control bg-sunken px-3 py-2 text-body-sm text-ink-muted"
            data-kind="checkpoint"
            id="tracker-claim-reason"
          >
            <ClaimIcon inherited={covering !== issue} className="mt-1 size-3" />
            <span>
              <Actor
                who={claimAttribution(snapshot, covering!.claim!)}
                link
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
            {/* Owners can end a claim nobody is going to finish (a lost session, a stuck agent). */}
            {covering === issue && snapshot.canAdmin && viewer && !viewer.agent && (
              <ConfirmDialog
                trigger={
                  <button
                    type="button"
                    className="mk-btn mk-btn--danger-ghost mk-btn--sm -my-1 ml-auto shrink-0 self-start"
                  >
                    End claim
                  </button>
                }
                title={`End the claim on ${issue.key}?`}
                description={`Its holder's lease stops working at once and ${issue.key} goes back to todo. The issue notes that you ended it; it doesn't count as their failed attempt.`}
                confirmLabel="End claim"
                busy={busy}
                onConfirm={async () => {
                  setNotice("");
                  setActionError("");
                  const result = await mutate([
                    { kind: "issue.release", id: issue.id, data: { force: true } },
                  ]);
                  if (result.ok) setNotice("Claim ended; the issue is back in todo.");
                  else setActionError(result.error);
                }}
              />
            )}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2 max-sm:grid max-sm:grid-cols-2 max-sm:[&>.mk-btn]:min-w-0 max-sm:[&>.mk-btn]:px-2">
          {!editing && (
            <button
              className="mk-btn mk-btn--primary mk-btn--sm"
              aria-keyshortcuts="e"
              data-edit-field="all"
              disabled={busy}
              onClick={() => beginEdit()}
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
          {!editing &&
            issue.status !== "done_in_timeline" &&
            issue.status !== "done" &&
            issue.status !== "canceled" && (
              <button
                className="mk-btn mk-btn--sm"
                disabled={busy || activeClaim || unresolvedBlockers.length > 0}
                aria-describedby={statusReason}
                onClick={() => void updateStatus("done", "Issue completed.")}
              >
                Mark done
              </button>
            )}
          {!editing &&
            issue.status !== "done_in_timeline" &&
            issue.status !== "done" &&
            issue.status !== "canceled" && (
              <button
                ref={closeButtonRef}
                className="mk-btn mk-btn--sm"
                disabled={busy || activeClaim}
                aria-describedby={activeClaim ? "tracker-claim-reason" : undefined}
                aria-expanded={closing}
                aria-controls="tracker-close-form"
                onClick={() => {
                  if (closing) return;
                  setCloseReason(null);
                  setActionError("");
                  setNotice("");
                  setClosing(true);
                }}
              >
                Close issue
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
        {closing && !editing && issue.status !== "done" && issue.status !== "canceled" && (
          <form
            id="tracker-close-form"
            ref={closeFormRef}
            className="mt-4 space-y-3"
            aria-label="Close issue"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || activeClaim || !closeReason) return;
              void updateStatus("canceled", "Issue closed without completion.", closeReason);
            }}
          >
            <p className="m-0 text-body-sm text-ink-muted">
              Close without completing. Dependent issues will remain blocked.
            </p>
            <fieldset disabled={busy || activeClaim} className="m-0 min-w-0 border-0 p-0">
              <CloseReasonField value={closeReason} onChange={setCloseReason} />
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <button
                className="mk-btn mk-btn--primary mk-btn--sm"
                disabled={busy || activeClaim || !closeReason}
              >
                {busy ? "Closing…" : "Confirm close"}
              </button>
              <button
                type="button"
                className="mk-btn mk-btn--ghost mk-btn--sm"
                disabled={busy}
                onClick={() => {
                  setClosing(false);
                  setActionError("");
                  closeButtonRef.current?.focus();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
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
            <ClaimIcon />
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
      {editing && mode === "all" && <section className={SECTION}>{editor}</section>}
      {!editing && (localError || needsReview || navigation.state === "blocked") && (
        <section className={SECTION} aria-label="Save recovery">
          {recovery}
        </section>
      )}
      {/* Keep Markdown mounted across edits so saving reconciles existing prose
          instead of rebuilding a large description's entire DOM. */}
      {(["description", "acceptance"] as const).map((field) => (
        <section
          className={SECTION}
          key={field}
          aria-label={fieldNames[field]}
          hidden={editing && mode === "all"}
        >
          {editing && mode === field && editor}
          <div hidden={editing && mode === field}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className={HEADING}>{fieldNames[field]}</h3>
              <div className="flex shrink-0 items-center gap-2">
                {updatedField === field && updatedNotice}
                {mode === field && updatingNotice}
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost mk-btn--sm"
                  aria-label={`Edit ${field === "description" ? "description" : "acceptance criteria"}`}
                  data-edit-field={field}
                  disabled={busy || editing}
                  onClick={() => beginEdit(field)}
                >
                  Edit
                </button>
              </div>
            </div>
            {optimisticFields[field] ? (
              <div
                className={
                  !busy && !editing ? "cursor-text rounded-control hover:bg-sunken" : undefined
                }
                onPointerUp={(event) => {
                  // The Edit button is the keyboard entry point; prose also accepts a click.
                  if (
                    busy ||
                    editing ||
                    event.button !== 0 ||
                    !window.getSelection()?.isCollapsed ||
                    (event.target instanceof Element &&
                      event.target.closest("a, button, input, textarea, select, [role=button]"))
                  )
                    return;
                  beginEdit(field);
                }}
              >
                <MarkdownText text={optimisticFields[field]} />
              </div>
            ) : (
              <button
                type="button"
                className="min-h-11 w-full rounded-control text-left text-body-sm text-ink-muted hover:bg-sunken disabled:bg-transparent"
                disabled={busy || editing}
                onClick={() => beginEdit(field)}
              >
                {field === "description" ? "Add a description…" : "Add acceptance criteria…"}
              </button>
            )}
          </div>
        </section>
      ))}
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
      <section className={SECTION} aria-label="Linked work" data-issue-linked-work>
        <LinkedWorkPanel
          key={`${snapshot.owner.id}:${issue.id}`}
          owner={snapshot.owner.slug}
          issueId={issue.id}
          issueKey={issue.key}
          headingClassName={HEADING}
        />
      </section>
      <AuditHistory
        key={`${snapshot.owner.id}:${issue.id}`}
        issueId={issue.id}
        snapshot={snapshot}
      />
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
                  link
                  className="[&>span:last-child]:font-semibold [&>span:last-child]:text-ink"
                />
                <span className="inline-flex items-center gap-1.5" data-kind={comment.kind}>
                  {comment.kind === "checkpoint" ? (
                    <ClaimIcon />
                  ) : comment.kind === "evidence" ? (
                    <span className="size-1.5 rounded-full bg-online" aria-hidden />
                  ) : null}
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
