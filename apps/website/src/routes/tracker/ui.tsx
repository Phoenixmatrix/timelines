import { memo, useId, useMemo, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { FlagIcon } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import {
  actorName,
  claimAttribution,
  claimHolder,
  CLOSE_REASONS,
  hasActiveClaim,
  ISSUE_PICKUPS,
  issuePickup,
  leasedAncestor,
  readiness,
  readinessIndex,
  TIMELINE_USES,
  type Issue,
  type IssueCloseReason,
  type IssuePickup,
  type IssueTimelineUse,
  type Snapshot,
} from "../../../shared/tracker.ts";
import { TIMELINE_POLICIES, type TimelinePolicy } from "../../../shared/timelines.ts";
import { popMotion, SelectField } from "../../components/ui.tsx";
import { useRefMarkdown } from "../../refs/remark.tsx";
import type { IssueIndex } from "./query.ts";
import { Actor } from "./Actor.tsx";

/** Exclusive ownership uses a flag; an outline means the lease is inherited. */
export function ClaimIcon({
  inherited = false,
  className = "size-3",
}: {
  inherited?: boolean;
  className?: string;
}) {
  return (
    <FlagIcon
      weight={inherited ? "bold" : "fill"}
      className={`shrink-0 ${inherited ? "text-ink-faint" : "text-ink"} ${className}`}
      aria-hidden
    />
  );
}

/**
 * Done in a timeline (CORE-74): a branch whose tip is a done check, in the
 * green that marks landing in the timeline graph. Its own shape, not a dot.
 */
export function DoneInTimelineIcon({ className = "size-3" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={`shrink-0 text-online ${className}`}
      aria-hidden
    >
      <path
        d="M4 1.5v13M4 11.5c0-3.5 2.2-5.6 4.4-6.3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="11.5" cy="5" r="4.25" fill="currentColor" />
      <path
        d="M9.5 5.1l1.4 1.4 2.5-2.7"
        stroke="var(--pane)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
/** The statuses a person picks from; the tracker sets done in a timeline itself. */
export const statuses = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" },
];
/** A status in words: "Done in search" names the timeline it's done in. */
export function statusLabel(issue: Pick<Issue, "status" | "doneIn">): string {
  if (issue.status === "done_in_timeline")
    return issue.doneIn ? `Done in ${issue.doneIn.slug}` : "Done in a timeline";
  return statuses.find((status) => status.value === issue.status)?.label ?? issue.status;
}
export const types = ["task", "bug", "prd", "chore", "research", "remediation"];
/** One casing everywhere: "Task", "Bug", "PRD". */
export const typeLabel = (type: string) =>
  type === "prd" ? "PRD" : type[0]!.toUpperCase() + type.slice(1);
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="mk-field">
      <span id={id} className="mk-label">
        {label}
      </span>
      <div role="group" aria-labelledby={id}>
        {children}
      </div>
    </div>
  );
}

export function CloseReasonField({
  value,
  onChange,
  required = true,
}: {
  value: IssueCloseReason | null | undefined;
  onChange: (value: IssueCloseReason) => void;
  required?: boolean;
}) {
  return (
    <Field label="Close reason">
      <select
        className="mk-input"
        aria-label="Close reason"
        value={value ?? ""}
        required={required}
        onChange={(event) => onChange(event.target.value as IssueCloseReason)}
      >
        <option value="" disabled>
          {required ? "Choose a reason" : "No reason recorded"}
        </option>
        {Object.entries(CLOSE_REASONS).map(([reason, label]) => (
          <option key={reason} value={reason}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function PickupField({
  value,
  onChange,
}: {
  value: IssuePickup | undefined;
  onChange: (value: IssuePickup) => void;
}) {
  const hint = useId();
  const current = value ?? "anyone";
  return (
    <Field label="Pickup">
      <SelectField
        ariaLabel="Issue pickup"
        ariaDescribedBy={hint}
        value={current}
        options={Object.entries(ISSUE_PICKUPS).map(([value, label]) => ({ value, label }))}
        onChange={(value) => onChange(value as IssuePickup)}
      />
      <p id={hint} className="mk-hint m-0 mt-1">
        {current === "not_ready"
          ? "No one can claim or start this issue until a person changes pickup."
          : current === "human_only"
            ? "People can pick this up. Agents cannot, even when assigned."
            : "Agents and people can pick this up when it is ready."}
      </p>
    </Field>
  );
}
/**
 * Whether an agent works the issue in a timeline and, when required, the policy
 * that timeline must use. Agents also read the description or PRD.
 */
export function TimelineFields({
  use,
  policy,
  onChange,
}: {
  use: IssueTimelineUse | undefined;
  policy: TimelinePolicy | null | undefined;
  onChange: (use: IssueTimelineUse, policy: TimelinePolicy | null) => void;
}) {
  const current = use ?? "agent_decides";
  return (
    <>
      <Field label="Timeline">
        <SelectField
          ariaLabel="Issue timeline"
          value={current}
          options={Object.entries(TIMELINE_USES).map(([value, label]) => ({ value, label }))}
          onChange={(value) =>
            onChange(value as IssueTimelineUse, value === "required" ? (policy ?? null) : null)
          }
        />
      </Field>
      {current === "required" && (
        <Field label="Timeline policy">
          <SelectField
            ariaLabel="Timeline policy"
            value={policy ?? ""}
            options={[
              { value: "", label: "Either policy" },
              ...TIMELINE_POLICIES.map((value) => ({
                value,
                label: value === "auto" ? "Auto: lands when green" : "Approval: a person approves",
              })),
            ]}
            onChange={(value) => onChange("required", (value || null) as TimelinePolicy | null)}
          />
        </Field>
      )}
    </>
  );
}
// Markdown inside the tracker: headings stay at body size so a PRD's "# Title"
// doesn't outshout the issue, and GFM task lists drop their bullets. `!` beats
// gm-prose, which sits outside the utility layer.
const MARKDOWN =
  "gm-prose [&_:is(h1,h2,h3,h4,h5,h6)]:text-body! [&_:is(h1,h2,h3,h4,h5,h6)]:leading-normal! " +
  "[&_.contains-task-list]:list-none! [&_.contains-task-list]:ps-0! [&_.task-list-item]:list-none " +
  "[&_.task-list-item_input]:me-2 [&_.task-list-item_input]:accent-signal";
/** A bare URL as tracker Markdown links it: Link handles same-origin absolute URLs. */
function trackerUrl(href: string, children: ReactNode) {
  return <Link to={href}>{children}</Link>;
}
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  // Issue keys, tracker URLs, owner/repo and pkg@version link when they resolve (CORE-22).
  const refs = useRefMarkdown(trackerUrl);
  return (
    <div className={MARKDOWN}>
      <ReactMarkdown
        remarkPlugins={refs.remarkPlugins}
        components={{
          ...refs.components,
          a({ node: _node, href, ...props }) {
            // Link handles same-origin absolute URLs and leaves external URLs
            // and modified clicks to the browser. Keep relative/hash links native.
            return href && /^(?:https?:)?\/\//i.test(href) ? (
              <Link to={href} {...props} />
            ) : (
              <a href={href} {...props} />
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

const byKey = new Intl.Collator(undefined, { numeric: true });

export function IssuePicker({
  label,
  value,
  onChange,
  issues,
  placeholder = "Search by key or title…",
  allowNone = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  issues: Issue[];
  placeholder?: string;
  allowNone?: boolean;
}) {
  const id = useId();
  const items = useMemo(() => {
    const sorted = [...issues]
      .sort(
        (a, b) =>
          Number(a.status === "done" || a.status === "canceled") -
            Number(b.status === "done" || b.status === "canceled") || byKey.compare(a.key, b.key),
      )
      .map((issue) => ({ value: issue.id, label: `${issue.key} · ${issue.title}` }));
    return allowNone ? [{ value: "", label: "None" }, ...sorted] : sorted;
  }, [issues, allowNone]);
  return (
    <div className="mk-field">
      <label className="mk-label" htmlFor={id}>
        {label}
      </label>
      <Combobox.Root
        items={items}
        value={items.find((item) => item.value === value) ?? null}
        isItemEqualToValue={(a, b) => a.value === b.value}
        onValueChange={(item) => onChange(item?.value ?? "")}
        limit={60}
      >
        <Combobox.Input id={id} className="mk-input" placeholder={placeholder} />
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={6} className="z-50">
            <Combobox.Popup
              className={`mk-popup ${popMotion} max-h-[min(360px,var(--available-height))] w-(--anchor-width) max-w-[calc(100vw-32px)] overflow-y-auto`}
            >
              <Combobox.Empty className="mk-hint p-3">No matching issues.</Combobox.Empty>
              <Combobox.List>
                {(item: { value: string; label: string }) => (
                  <Combobox.Item
                    key={item.value}
                    value={item}
                    className="mk-option py-1.5 text-body-sm whitespace-normal [overflow-wrap:anywhere]"
                    title={item.label}
                  >
                    {item.label}
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}
/** Open blockers of an issue; pass the workbench index to skip scanning every issue. */
export function blockers(issue: Issue, snapshot: Snapshot, index?: IssueIndex) {
  if (index) return index.openBlockers.get(issue.id) ?? [];
  return snapshot.links
    .filter((link) => link.kind === "blocks" && link.toId === issue.id)
    .map((link) => snapshot.issues.find((item) => item.id === link.fromId))
    .filter((item): item is Issue => !!item && item.status !== "done");
}
const STATE_DOT: Record<string, string> = {
  waiting: "bg-signal",
  ready: "bg-online",
  blocked: "bg-danger-text",
  human_only: "bg-ink-muted",
  not_ready: "bg-ink-faint",
};
function StateBadge({
  state,
  title,
  children,
}: {
  state?:
    | "waiting"
    | "ready"
    | "claimed"
    | "leased"
    | "blocked"
    | "done_in_timeline"
    | "human_only"
    | "not_ready";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 text-micro whitespace-nowrap text-ink-muted"
      data-state={state}
      title={title}
    >
      {state === "done_in_timeline" ? (
        <DoneInTimelineIcon />
      ) : state === "claimed" || state === "leased" ? (
        <ClaimIcon inherited={state === "leased"} />
      ) : (
        <span
          className={`size-2 shrink-0 rounded-full ${(state && STATE_DOT[state]) ?? "bg-ink-faint"}`}
          aria-hidden
        />
      )}
      {children}
    </span>
  );
}
export function IssueState({
  issue,
  snapshot,
  index,
}: {
  issue: Issue;
  snapshot: Snapshot;
  /** Lookups by id instead of scans, for issues rendered in a list. */
  index?: IssueIndex;
}) {
  const blocked = blockers(issue, snapshot, index);
  if (issue.waiting) {
    const asks = snapshot.requests.filter((r) => r.issueId === issue.id && r.status === "open");
    const who = [...new Set(asks.map((r) => actorName(snapshot, r.routeTo)))];
    return (
      <StateBadge state="waiting" title={asks.map((r) => r.prompt.split("\n")[0]).join("\n")}>
        Waiting on {who.join(", ") || "a person"}
      </StateBadge>
    );
  }
  if (issue.status === "done_in_timeline")
    return (
      <StateBadge
        state="done_in_timeline"
        title="Done in a timeline: done on main when it lands. Its status is locked here."
      >
        {statusLabel(issue)}
      </StateBadge>
    );
  // A lease retained by a timeline (CORE-75) holds finished work: it shows as done.
  if (issue.claim && !issue.claim.retainedIn && hasActiveClaim(issue, snapshot.serverTime))
    return (
      <StateBadge
        state="claimed"
        title={`Claim expires ${new Date(issue.claim.expiresAt).toLocaleString()}`}
      >
        Claimed · <Actor who={claimAttribution(snapshot, issue.claim)} compact />
      </StateBadge>
    );
  if (issue.status === "done" || issue.status === "canceled")
    return <StateBadge>{statusLabel(issue)}</StateBadge>;
  const pickup = issuePickup(issue);
  if (pickup !== "anyone")
    return (
      <StateBadge
        state={pickup}
        title={
          pickup === "not_ready"
            ? "Pickup is paused until a person enables it."
            : "Only people can pick up this issue."
        }
      >
        {ISSUE_PICKUPS[pickup]}
      </StateBadge>
    );
  if (blocked.length)
    return (
      <StateBadge state="blocked" title={blocked.map((item) => item.key).join(", ")}>
        Blocked · {blocked.length}
      </StateBadge>
    );
  const why = index ? index.state.get(issue.id) : stateOf(issue, snapshot);
  if (why === "leased") {
    const above =
      index?.leasedBy.get(issue.id) ??
      leasedAncestor(issue, readinessIndex(snapshot.issues, snapshot.links), snapshot.serverTime);
    return (
      <StateBadge
        state="leased"
        title={`${above?.key}'s lease covers this issue: only ${above?.claim ? claimHolder(snapshot, above.claim) : "its holder"} can change its status`}
      >
        Leased via {above?.key}
      </StateBadge>
    );
  }
  if (why === "ready")
    return <StateBadge state="ready">Ready{issue.claim ? " to reclaim" : ""}</StateBadge>;
  return <StateBadge>{statusLabel(issue)}</StateBadge>;
}
/** Readiness shared with the server and gm, for a page without a list index. */
function stateOf(issue: Issue, snapshot: Snapshot): "ready" | "leased" | null {
  const why = readiness(
    issue,
    readinessIndex(snapshot.issues, snapshot.links),
    snapshot.serverTime,
  );
  return why === "ready" ? "ready" : why === "leased_above" ? "leased" : null;
}
export function MultiCheck({
  label,
  options,
  values,
  onChange,
}: {
  label: string;
  options: { id: string; name: string }[];
  values: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap gap-x-4 gap-y-1 border-0 p-0">
      <legend className="mk-label mb-1.5 p-0">{label}</legend>
      {options.length ? (
        options.map((option) => (
          <label
            key={option.id}
            className="flex min-h-8 cursor-pointer items-center gap-2 text-body-sm max-md:min-h-11"
          >
            <input
              type="checkbox"
              className="m-0 size-4 cursor-pointer accent-signal"
              checked={values.includes(option.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...values, option.id]
                    : values.filter((id) => id !== option.id),
                )
              }
            />
            {option.name}
          </label>
        ))
      ) : (
        <span className="mk-hint">None available.</span>
      )}
    </fieldset>
  );
}
