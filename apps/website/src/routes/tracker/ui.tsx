import { memo, useId, useMemo, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import "./IssueDetail.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isIssueReady, type Issue, type Snapshot } from "../../../shared/tracker.ts";

export const statuses = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" },
];
export const types = ["task", "bug", "prd", "chore", "research"];
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
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="gm-prose tracker-markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

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
            Number(b.status === "done" || b.status === "canceled") ||
          a.key.localeCompare(b.key, undefined, { numeric: true }),
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
      >
        <Combobox.Input id={id} className="mk-input" placeholder={placeholder} />
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={6} className="z-50">
            <Combobox.Popup className="mk-popup gm-pop tracker-issue-picker">
              <Combobox.Empty className="mk-hint p-3">No matching issues.</Combobox.Empty>
              <Combobox.List>
                {(item: { value: string; label: string }) => (
                  <Combobox.Item
                    key={item.value}
                    value={item}
                    className="mk-option"
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
export function blockers(issue: Issue, snapshot: Snapshot) {
  return snapshot.links
    .filter((link) => link.kind === "blocks" && link.toId === issue.id)
    .map((link) => snapshot.issues.find((item) => item.id === link.fromId))
    .filter((item): item is Issue => !!item && item.status !== "done");
}
export function IssueState({ issue, snapshot }: { issue: Issue; snapshot: Snapshot }) {
  const blocked = blockers(issue, snapshot);
  if (issue.claim && issue.claim.expiresAt > snapshot.serverTime)
    return (
      <span
        className="tracker-state"
        data-state="claimed"
        title={`Claim expires ${new Date(issue.claim.expiresAt).toLocaleString()}`}
      >
        Claimed · {issue.claim.agent}
      </span>
    );
  if (issue.status === "done" || issue.status === "canceled")
    return (
      <span className="tracker-state">
        {statuses.find((status) => status.value === issue.status)?.label}
      </span>
    );
  if (blocked.length)
    return (
      <span
        className="tracker-state"
        data-state="blocked"
        title={blocked.map((item) => item.key).join(", ")}
      >
        Blocked · {blocked.length}
      </span>
    );
  if (isIssueReady(issue, snapshot.issues, snapshot.links, snapshot.serverTime))
    return (
      <span className="tracker-state" data-state="ready">
        Ready{issue.claim ? " to reclaim" : ""}
      </span>
    );
  return (
    <span className="tracker-state">
      {statuses.find((status) => status.value === issue.status)?.label}
    </span>
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
    <fieldset className="tracker-checks">
      <legend className="mk-label">{label}</legend>
      {options.length ? (
        options.map((option) => (
          <label key={option.id}>
            <input
              type="checkbox"
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
