import { Dialog } from "@base-ui/react/dialog";
import { useState } from "react";
import {
  actorName,
  type Issue,
  type IssueCloseReason,
  type IssuePickup,
  type IssueTimelineUse,
  type Mutation,
  type Snapshot,
} from "../../../shared/tracker.ts";
import {
  dialogMotion,
  fadeMotion,
  FormError,
  SelectField,
  TextField,
} from "../../components/ui.tsx";
import type { MutationOutcome } from "./IssueDetail.tsx";
import { LabelPicker } from "./Labels.tsx";
import type { TimelinePolicy } from "../../../shared/timelines.ts";
import {
  CloseReasonField,
  Field,
  MultiCheck,
  PickupField,
  statuses,
  TimelineFields,
  typeLabel,
  types,
} from "./ui.tsx";

/** Expanded capture stays in the tracker; the existing editor handles the next step. */
export function CreateIssue({
  snapshot,
  initialTitle,
  initialType,
  initialLabels,
  initialTeam,
  initialWorkspaces,
  busy,
  uncertain,
  onCreate,
  onRetry,
  onCancel,
}: {
  snapshot: Snapshot;
  initialTitle: string;
  initialType: Issue["type"];
  initialLabels: string[];
  initialTeam: string;
  initialWorkspaces: string[];
  busy: boolean;
  uncertain: boolean;
  onCreate: (data: Extract<Mutation, { kind: "issue.create" }>["data"]) => Promise<MutationOutcome>;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [teamId, setTeamId] = useState(initialTeam);
  const [description, setDescription] = useState("");
  const [type, setType] = useState<Issue["type"]>(initialType);
  const [labels, setLabels] = useState(initialLabels);
  const [status, setStatus] = useState<Issue["status"]>("todo");
  const [pickup, setPickup] = useState<IssuePickup>("anyone");
  const [closeReason, setCloseReason] = useState<IssueCloseReason | null>(null);
  const [priority, setPriority] = useState(2);
  const [timelineUse, setTimelineUse] = useState<IssueTimelineUse>("agent_decides");
  const [timelinePolicy, setTimelinePolicy] = useState<TimelinePolicy | null>(null);
  const [assigneeId, setAssigneeId] = useState("");
  const [workspaceIds, setWorkspaceIds] = useState(initialWorkspaces);
  const [error, setError] = useState("");
  const team = snapshot.teams.find((value) => value.id === teamId && !value.archived);
  const members = snapshot.members.filter(
    (member) => !team?.memberIds.length || team.memberIds.includes(member.id),
  );
  const assignable = [
    ...members.map((member) => ({ value: member.id, label: member.displayName })),
    ...snapshot.agents
      .filter((agent) => members.some((member) => member.id === agent.accountable.id))
      .map((agent) => ({ value: agent.id, label: actorName(snapshot, agent.id) })),
  ];
  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && !uncertain && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className={`mk-backdrop ${fadeMotion}`} />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Popup
            className={`mk-dialog w-full! max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto ${dialogMotion}`}
          >
            <Dialog.Title className="mk-dialog-title">Create an issue</Dialog.Title>
            <Dialog.Description className="mk-dialog-desc text-body-sm">
              Add context now. After creation, continue in the editor for acceptance criteria and
              relationships.
            </Dialog.Description>
            <form
              className="mt-5"
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy || uncertain || !team || !title.trim()) return;
                setError("");
                if (status === "canceled" && !closeReason) {
                  setError("Choose a reason for closing this issue.");
                  return;
                }
                const result = await onCreate({
                  title: title.trim(),
                  teamId,
                  description,
                  type,
                  status,
                  pickup,
                  closeReason: status === "canceled" ? closeReason : null,
                  priority: priority as Issue["priority"],
                  timelineUse,
                  timelinePolicy,
                  assigneeId: assigneeId || null,
                  workspaceIds,
                  labels,
                });
                if (!result.ok) setError(result.error);
              }}
            >
              <fieldset
                disabled={busy || uncertain}
                className="m-0 grid min-w-0 gap-4 border-0 p-0"
              >
                <TextField
                  label="Title"
                  value={title}
                  required
                  maxLength={500}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <Field label="Description / PRD">
                  <textarea
                    className="mk-input"
                    aria-label="Description / PRD"
                    rows={5}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Describe the outcome and context. Markdown supported."
                  />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Team">
                    <SelectField
                      ariaLabel="Issue team"
                      value={teamId}
                      options={[
                        { value: "", label: "Choose a team" },
                        ...snapshot.teams
                          .filter((value) => !value.archived)
                          .map((value) => ({
                            value: value.id,
                            label: `${value.key} · ${value.name}`,
                          })),
                      ]}
                      onChange={(value) => {
                        setTeamId(value);
                        setAssigneeId("");
                      }}
                    />
                  </Field>
                  <Field label="Type">
                    <SelectField
                      ariaLabel="Issue type"
                      value={type}
                      options={types.map((value) => ({ value, label: typeLabel(value) }))}
                      onChange={(value) => setType(value as Issue["type"])}
                    />
                  </Field>
                  <Field label="Status">
                    <SelectField
                      ariaLabel="Issue status"
                      value={status}
                      options={statuses}
                      onChange={(value) => {
                        setStatus(value as Issue["status"]);
                        if (value !== "canceled") setCloseReason(null);
                      }}
                    />
                  </Field>
                  <PickupField value={pickup} onChange={setPickup} />
                  {status === "canceled" && (
                    <CloseReasonField value={closeReason} onChange={setCloseReason} />
                  )}
                  <Field label="Priority">
                    <SelectField
                      ariaLabel="Issue priority"
                      value={String(priority)}
                      options={[0, 1, 2, 3, 4].map((value) => ({
                        value: String(value),
                        label: `P${value}${value === 0 ? " · Urgent" : value === 4 ? " · Lowest" : ""}`,
                      }))}
                      onChange={(value) => setPriority(Number(value))}
                    />
                  </Field>
                  <Field label="Assignee">
                    <SelectField
                      ariaLabel="Issue assignee"
                      value={assigneeId}
                      options={[{ value: "", label: "Unassigned" }, ...assignable]}
                      onChange={setAssigneeId}
                    />
                  </Field>
                  <TimelineFields
                    use={timelineUse}
                    policy={timelinePolicy}
                    onChange={(use, policy) => {
                      setTimelineUse(use);
                      setTimelinePolicy(policy);
                    }}
                  />
                </div>
                <LabelPicker
                  options={[...snapshot.labels, ...initialLabels]}
                  values={labels}
                  onChange={setLabels}
                />
                <MultiCheck
                  label="Workspaces"
                  options={snapshot.workspaces.filter((workspace) => !workspace.archived)}
                  values={workspaceIds}
                  onChange={setWorkspaceIds}
                />
              </fieldset>
              <div aria-live="polite" className="mt-3">
                <FormError message={error} />
                {uncertain && (
                  <div className="grid gap-2">
                    <p className="m-0 text-body-sm text-ink-muted">
                      Creation could not be confirmed. Your draft is kept. Retry the same request to
                      confirm it without creating a duplicate.
                    </p>
                    <button type="button" className="mk-btn" disabled={busy} onClick={onRetry}>
                      Retry pending change
                    </button>
                  </div>
                )}
              </div>
              <div className="mk-dialog-actions flex-wrap">
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost"
                  disabled={busy || uncertain}
                  onClick={onCancel}
                >
                  Cancel
                </button>
                <button
                  className="mk-btn mk-btn--primary"
                  disabled={
                    busy ||
                    uncertain ||
                    !team ||
                    !title.trim() ||
                    (status === "canceled" && !closeReason)
                  }
                >
                  {busy ? "Creating…" : "Create and edit"}
                </button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
