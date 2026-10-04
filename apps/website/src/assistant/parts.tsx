// The pieces of a transcript: prose, receipts for what the assistant did, and
// the approval card every write waits on.

import {
  ArrowSquareOutIcon,
  CheckIcon,
  CircleNotchIcon,
  HandIcon,
  ProhibitIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import { describeWrite, toolLabel, WRITE_TOOLS } from "../../shared/assistant.ts";
import { useRefMarkdown } from "../refs/remark.tsx";

/** Following a linked ref in an answer navigates like any app link (it may collapse the dock). */
function refClick(onNavigate: () => void) {
  return (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("a[data-ref-kind]")) onNavigate();
  };
}

/** A bare URL in an answer: a new tab, like any other outside link. */
function answerUrl(href: string, children: ReactNode) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Assistant prose: app paths open in place, everything else in a new tab. */
export function ChatMarkdown({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  // Refs link when they resolve for the page the dock sits on (CORE-22).
  const refs = useRefMarkdown(answerUrl);
  return (
    <div
      className="gm-prose gm-prose--chat"
      dir="auto"
      onClickCapture={onNavigate && refClick(onNavigate)}
    >
      <ReactMarkdown
        remarkPlugins={refs.remarkPlugins}
        components={{
          ...refs.components,
          a({ href, children }) {
            if (href?.startsWith("/"))
              return (
                <Link to={href} onClick={onNavigate}>
                  {children}
                </Link>
              );
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export interface ToolPart {
  type: string;
  toolCallId: string;
  state:
    | "input-streaming"
    | "input-available"
    | "approval-requested"
    | "approval-responded"
    | "output-available"
    | "output-error"
    | "output-denied";
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
}

export const toolName = (part: ToolPart) => part.type.replace(/^tool-/, "");
const inputOf = (part: ToolPart) => (part.input ?? {}) as Record<string, unknown>;
/** A value as text, or "" when it isn't one. */
const say = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
/** The app page a tool result points at, when it has one. */
const urlOf = (part: ToolPart) => {
  const url = (part.output as { url?: unknown } | undefined)?.url;
  return typeof url === "string" && url.startsWith("/") ? url : null;
};
const failed = (part: ToolPart) =>
  part.state === "output-error" ||
  (part.state === "output-available" &&
    typeof (part.output as { error?: unknown } | undefined)?.error === "string");

function Glyph({ part }: { part: ToolPart }) {
  const icon = "size-4 shrink-0";
  if (part.state === "output-denied")
    return <ProhibitIcon className={`${icon} text-ink-faint`} aria-hidden />;
  if (failed(part)) return <WarningCircleIcon className={`${icon} text-danger-text`} aria-hidden />;
  if (part.state === "output-available")
    return <CheckIcon weight="bold" className={`${icon} text-ink-faint`} aria-hidden />;
  if (part.state === "approval-requested")
    return <HandIcon className={`${icon} text-ink-muted`} aria-hidden />;
  return (
    <CircleNotchIcon
      className={`${icon} animate-spin text-ink-faint motion-reduce:animate-none`}
      aria-hidden
    />
  );
}

/** What a finished write did, in the past tense. */
function done(part: ToolPart): string {
  const output = (part.output ?? {}) as Record<string, unknown>;
  const name = toolName(part);
  if (part.state === "output-denied")
    return `Declined: ${describeWrite(name, inputOf(part)).title}`;
  if (failed(part))
    return `${toolLabel(name, inputOf(part))} — ${say(output.error) || part.errorText || "failed"}`;
  if (name === "create_issue" && typeof output.created === "string")
    return `Created ${output.created}`;
  if (name === "update_issue") return `Updated ${say(output.updated) || say(inputOf(part).key)}`;
  if (name === "comment_on_issue")
    return `Commented on ${say(output.commented) || say(inputOf(part).key)}`;
  if (name === "link_issues") return `Linked ${say(output.linked)}`;
  if (name === "rerun_ci") return `Started run #${say(output.rerun)}`;
  if (name === "cancel_ci") return `Cancelled run #${say(output.cancelled)}`;
  return toolLabel(name, inputOf(part));
}

/** One line for one tool call; a link when it produced a page. */
export function Receipt({ part, onNavigate }: { part: ToolPart; onNavigate?: () => void }) {
  const name = toolName(part);
  const finished =
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied";
  const label =
    (WRITE_TOOLS as readonly string[]).includes(name) && finished
      ? done(part)
      : toolLabel(name, inputOf(part));
  const url = name === "navigate" ? say(inputOf(part).path) : urlOf(part);
  return (
    <li className="flex min-h-7 items-center gap-2 text-body-sm text-ink-muted">
      <Glyph part={part} />
      {url && !failed(part) ? (
        <Link
          to={url}
          onClick={onNavigate}
          className="group inline-flex min-w-0 items-center gap-1 text-ink-muted no-underline hover:text-ink"
        >
          <span className="truncate">{label}</span>
          <ArrowSquareOutIcon
            className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
        </Link>
      ) : (
        <span className={`min-w-0 truncate ${failed(part) ? "text-danger-text" : ""}`}>
          {label}
        </span>
      )}
    </li>
  );
}

/**
 * A run of tool calls. While running, each shows; once a run of three or more
 * reads has finished, it folds into one line that opens to the list.
 */
export function Receipts({ parts, onNavigate }: { parts: ToolPart[]; onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const settled = parts.every((p) => p.state === "output-available" && !failed(p));
  const reads = parts.every(
    (p) => !(WRITE_TOOLS as readonly string[]).includes(toolName(p)) && toolName(p) !== "navigate",
  );
  if (settled && reads && parts.length >= 3 && !open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-7 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-body-sm text-ink-muted hover:text-ink"
        aria-expanded={false}
      >
        <CheckIcon weight="bold" className="size-4 shrink-0 text-ink-faint" aria-hidden />
        <span>
          {toolLabel(toolName(parts[0]!), inputOf(parts[0]!))} and {parts.length - 1} more
        </span>
      </button>
    );
  return (
    <ul className="m-0 flex list-none flex-col p-0" aria-label="What the assistant did">
      {parts.map((part) => (
        <Receipt key={part.toolCallId} part={part} onNavigate={onNavigate} />
      ))}
    </ul>
  );
}

/**
 * A write waiting on the person. Its wording comes from the request itself
 * (describeWrite), so it shows what will happen, not what the model said.
 */
export function ApprovalCard({
  part,
  onDecide,
}: {
  part: ToolPart;
  onDecide: (approved: boolean) => void;
}) {
  const { title, fields, body } = describeWrite(toolName(part), inputOf(part));
  const [more, setMore] = useState(false);
  const long = (body?.length ?? 0) > 400;
  return (
    <section
      className="mk-enter-up flex min-w-0 shrink-0 flex-col gap-3 rounded-pane bg-raised p-3 [overflow-wrap:anywhere]"
      aria-label={`Approve: ${title}`}
    >
      <div className="flex items-start gap-2">
        <HandIcon className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
        <h3 className="m-0 min-w-0 text-body font-semibold">{title}</h3>
      </div>
      {fields.length > 0 && (
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-body-sm">
          {fields.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-faint">{label}</dt>
              <dd className="m-0 min-w-0 break-words text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {body && (
        <div
          className={`min-w-0 shrink-0 rounded-control bg-sunken px-3 py-2 ${long && !more ? "max-h-40 overflow-hidden" : "overflow-x-auto"}`}
        >
          <ChatMarkdown text={body} />
        </div>
      )}
      {long && (
        <button
          type="button"
          className="-mt-1 w-fit cursor-pointer border-0 bg-transparent p-0 text-body-sm font-semibold text-ink-muted hover:text-ink"
          onClick={() => setMore(!more)}
          aria-expanded={more}
        >
          {more ? "Show less" : "Show all"}
        </button>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm max-sm:h-11"
          onClick={() => onDecide(false)}
        >
          Decline
        </button>
        <button
          type="button"
          className="mk-btn mk-btn--primary mk-btn--sm max-sm:h-11"
          onClick={() => onDecide(true)}
        >
          Approve
        </button>
      </div>
    </section>
  );
}

/** What the assistant is doing while nothing else shows it: before its first words, and between steps. */
export function StatusLine({ text }: { text: string }) {
  return (
    <p className="m-0 flex items-center gap-2 text-body-sm text-ink-muted" role="status">
      <span className="gm-thinking" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {text}…
    </p>
  );
}
