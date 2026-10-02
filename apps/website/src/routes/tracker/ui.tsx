import { memo, useId, useMemo, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type Issue, type Snapshot } from "../../../shared/tracker.ts";
import { popMotion } from "../../components/ui.tsx";
import type { IssueIndex } from "./query.ts";

export const statuses = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" },
];
export const types = ["task", "bug", "prd", "chore", "research"];
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
// Markdown inside the tracker: headings stay at body size so a PRD's "# Title"
// doesn't outshout the issue, and GFM task lists drop their bullets. `!` beats
// gm-prose, which sits outside the utility layer.
const MARKDOWN =
  "gm-prose [&_:is(h1,h2,h3,h4,h5,h6)]:text-body! [&_:is(h1,h2,h3,h4,h5,h6)]:leading-normal! " +
  "[&_.contains-task-list]:list-none! [&_.contains-task-list]:ps-0! [&_.task-list-item]:list-none " +
  "[&_.task-list-item_input]:me-2 [&_.task-list-item_input]:accent-signal";
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className={MARKDOWN}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
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
  ready: "bg-online",
  claimed: "bg-transparent ring-[1.5px] ring-inset ring-ink",
  blocked: "bg-danger-text",
};
function StateBadge({
  state,
  title,
  children,
}: {
  state?: "ready" | "claimed" | "blocked";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 text-micro whitespace-nowrap text-ink-muted"
      data-state={state}
      title={title}
    >
      <span
        className={`size-2 shrink-0 rounded-full ${(state && STATE_DOT[state]) ?? "bg-ink-faint"}`}
        aria-hidden
      />
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
  if (issue.claim && issue.claim.expiresAt > snapshot.serverTime)
    return (
      <StateBadge
        state="claimed"
        title={`Claim expires ${new Date(issue.claim.expiresAt).toLocaleString()}`}
      >
        Claimed · {issue.claim.agent}
      </StateBadge>
    );
  if (issue.status === "done" || issue.status === "canceled")
    return (
      <StateBadge>{statuses.find((status) => status.value === issue.status)?.label}</StateBadge>
    );
  if (blocked.length)
    return (
      <StateBadge state="blocked" title={blocked.map((item) => item.key).join(", ")}>
        Blocked · {blocked.length}
      </StateBadge>
    );
  if (isReady(issue, snapshot, index))
    return <StateBadge state="ready">Ready{issue.claim ? " to reclaim" : ""}</StateBadge>;
  return <StateBadge>{statuses.find((status) => status.value === issue.status)?.label}</StateBadge>;
}
// isIssueReady from shared/tracker.ts, with the blocker lookup going through the
// index when there is one. A blocks link to a missing issue still blocks.
function isReady(issue: Issue, snapshot: Snapshot, index?: IssueIndex) {
  const active = issue.claim !== null && issue.claim.expiresAt > snapshot.serverTime;
  const find = (id: string) =>
    index ? index.byId.get(id) : snapshot.issues.find((item) => item.id === id);
  return (
    !active &&
    (issue.status === "todo" || (issue.status === "in_progress" && issue.claim !== null)) &&
    !snapshot.links.some(
      (link) =>
        link.kind === "blocks" && link.toId === issue.id && find(link.fromId)?.status !== "done",
    )
  );
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
