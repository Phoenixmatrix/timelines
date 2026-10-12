// A request to a person, and the form that answers it: on an issue, and on the
// Needs you page. A credential is stored as its repository secret first; the
// tracker only ever hears where it went.

import { useState } from "react";
import type { CheckpointView } from "../../../shared/timelines.ts";
import type { HumanRequest, RequestNote, RequestWork } from "../../../shared/tracker.ts";
import { FormError } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { fullDate, timeAgo } from "../../lib/format.ts";
import { CheckpointPanel, CheckpointRef } from "./Checkpoint.tsx";
import { MarkdownText, statusLabel } from "./ui.tsx";

export type Answer = { answer?: string; choice?: string; approved?: boolean; stored?: boolean };
type Outcome = { ok: boolean; error?: string };

const KIND_LABEL: Record<HumanRequest["kind"], string> = {
  question: "Question",
  approval: "Approval",
  decision: "Decision",
  credential: "Credential",
};

/** "your", or "Ann Lee’s". */
const possessive = (who: string) => (who === "you" ? "your" : `${who}\u2019s`);

export function RequestCard({
  request,
  name,
  onAnswer,
  onCancel,
  heading,
  checkpoint,
  work,
  approvesWhenGreen = false,
}: {
  request: HumanRequest;
  /** How to name an actor id: a person, or "builder for Ann Lee". */
  name: (id: string) => string;
  onAnswer: (answer: Answer) => Promise<Outcome>;
  /** Shown to whoever asked. */
  onCancel?: () => Promise<Outcome>;
  /** Extra context above the prompt, e.g. the issue it's about. */
  heading?: React.ReactNode;
  /** For an approval of a timeline checkpoint: its details, and the tracker it's in. */
  checkpoint?: { view: CheckpointView; tracker: string };
  /** What the work behind it is doing (CORE-386), on pages away from the issue. */
  work?: RequestWork;
  /** The routed person has approve-when-green on in this tracker (CORE-378). */
  approvesWhenGreen?: boolean;
}) {
  const open = request.status === "open";
  const automatic =
    open && approvesWhenGreen && request.kind === "approval" && !!request.checkpoint;
  // Approve-when-green left this checkpoint to its person (CORE-378): say why.
  const skipped =
    automatic && request.autoApproveSkipped?.checkpointId === request.checkpoint?.id
      ? request.autoApproveSkipped!.reason
      : null;
  return (
    <article
      className={`flex flex-col gap-2 rounded-pane p-4 ${open ? "bg-signal-wash" : "bg-pane"}`}
      aria-label={`${KIND_LABEL[request.kind]} for ${name(request.routeTo)}`}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink-muted">
        <span className="mk-chip mk-chip--tag">{KIND_LABEL[request.kind]}</span>
        <span>
          From {name(request.askedBy)} · for{" "}
          <strong className="text-ink">{name(request.routeTo)}</strong>
        </span>
        <time
          className="text-ink-faint"
          dateTime={request.createdAt}
          title={fullDate(request.createdAt)}
        >
          {timeAgo(request.createdAt)}
        </time>
        {skipped && (
          <span className="mk-chip mk-chip--tag" title={skipped}>
            Approve it yourself
          </span>
        )}
        {automatic && !skipped && (
          <span
            className="mk-chip mk-chip--tag"
            title={
              name(request.routeTo) === "you"
                ? "You turned on approve-when-green in this tracker: it's approved for you once the checkpoint's CI is green."
                : `${name(request.routeTo)} turned on approve-when-green in this tracker: it's approved for them once the checkpoint's CI is green.`
            }
          >
            Approves when green
          </span>
        )}
      </header>
      {heading}
      {work && <WorkContext work={work} name={name} />}
      {skipped && <p className="m-0 text-body-sm text-ink-muted">{skipped}</p>}
      {/* In the history: approve-when-green left it to its person, and why (CORE-378). */}
      {!open && request.autoApproveSkipped && request.via !== "auto-approve" && (
        <p className="m-0 text-body-sm text-ink-muted">
          Left to {name(request.routeTo)} by approve-when-green: {request.autoApproveSkipped.reason}
        </p>
      )}
      <div className="max-w-[72ch] text-body">
        <MarkdownText text={request.prompt} />
      </div>
      {checkpoint ? (
        <CheckpointPanel view={checkpoint.view} tracker={checkpoint.tracker} name={name} />
      ) : (
        request.checkpoint && <CheckpointRef pinned={request.checkpoint} />
      )}
      {open ? (
        <AnswerForm
          request={request}
          onAnswer={onAnswer}
          onCancel={onCancel}
          // A superseded checkpoint can only be rejected.
          approvable={!checkpoint || checkpoint.view.current}
        />
      ) : (
        <p className="m-0 text-body-sm text-ink-muted">
          {request.status === "canceled" ? (
            // The tracker says why when it withdrew one (a superseded checkpoint).
            request.answer ? (
              `Withdrawn: ${request.answer}`
            ) : (
              "Canceled."
            )
          ) : (
            <>
              <strong className="text-ink">{request.answer}</strong>
              {" · "}
              {request.via === "auto-approve"
                ? `automatically, by ${possessive(name(request.answeredBy ?? ""))} approve-when-green setting`
                : name(request.answeredBy ?? "")}{" "}
              <time dateTime={request.answeredAt ?? ""} title={fullDate(request.answeredAt ?? "")}>
                {timeAgo(request.answeredAt ?? "")}
              </time>
            </>
          )}
        </p>
      )}
      {work?.next !== undefined && (
        <Note
          label="Next on the issue"
          note={work.next}
          name={name}
          empty="Nothing has been said on the issue since."
        />
      )}
    </article>
  );
}

/**
 * Why it was asked (CORE-386): who holds the issue and in which session, where
 * the issue stands, and its newest checkpoint, which says what the work is doing.
 */
function WorkContext({ work, name }: { work: RequestWork; name: (id: string) => string }) {
  return (
    <section
      aria-label="The work behind it"
      className="flex max-w-[72ch] flex-col gap-1 border-l-2 border-line-soft pl-3 text-body-sm text-ink-muted"
    >
      <p className="m-0">
        {work.holder ? (
          <>
            <strong className="text-ink">{name(work.holder.actorId)}</strong> is on it
            {work.holder.agent && (
              <>
                {" "}
                in session <span className="font-mono">{work.holder.agent}</span>
              </>
            )}
          </>
        ) : (
          "Nobody holds the issue now"
        )}
        {" · "}
        {statusLabel({ status: work.status, doneIn: null })}
      </p>
      <Note
        label="Latest checkpoint"
        note={work.latest}
        name={name}
        // Named just above when it's the holder's own.
        author={work.latest?.actorId !== work.holder?.actorId}
        empty="No checkpoint yet: the issue's description says what it's for."
      />
    </section>
  );
}

/** A note quoted from the issue: its first line, and the rest on request. */
function Note({
  label,
  note,
  name,
  empty,
  author = true,
}: {
  label: string;
  note: RequestNote | null;
  name: (id: string) => string;
  empty: string;
  /** Whether to say who wrote it. */
  author?: boolean;
}) {
  if (!note) return <p className="m-0 text-body-sm text-ink-faint">{empty}</p>;
  const [first = "", ...lines] = note.body.trim().split("\n");
  const rest = lines.join("\n").trim();
  const heading = (
    <>
      {label}
      {author && ` from ${name(note.actorId)}`},{" "}
      <time dateTime={note.createdAt} title={fullDate(note.createdAt)}>
        {timeAgo(note.createdAt)}
      </time>
      :{" "}
    </>
  );
  if (!rest)
    return (
      <p className="m-0 text-body-sm text-ink-muted">
        {heading}
        <span className="text-ink">{first}</span>
      </p>
    );
  return (
    <details className="text-body-sm text-ink-muted">
      <summary className="cursor-pointer">
        {heading}
        <span className="text-ink">{first}</span>
      </summary>
      <div className="mt-1 text-ink">
        <MarkdownText text={rest} />
      </div>
    </details>
  );
}

function AnswerForm({
  request,
  onAnswer,
  onCancel,
  approvable = true,
}: {
  request: HumanRequest;
  approvable?: boolean;
  onAnswer: (answer: Answer) => Promise<Outcome>;
  onCancel?: () => Promise<Outcome>;
}) {
  const [text, setText] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async (work: () => Promise<Outcome>) => {
    setBusy(true);
    setError("");
    try {
      const outcome = await work();
      if (!outcome.ok) setError(outcome.error ?? "That didn't go through.");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "That didn't go through.");
    } finally {
      setBusy(false);
    }
  };
  const cancel = onCancel && (
    <button
      type="button"
      className="mk-btn mk-btn--ghost mk-btn--sm"
      disabled={busy}
      onClick={() => void send(onCancel)}
    >
      Withdraw
    </button>
  );

  if (request.kind === "decision")
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Choices">
          {request.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className="mk-btn mk-btn--sm"
              disabled={busy}
              onClick={() => void send(() => onAnswer({ choice }))}
            >
              {choice}
            </button>
          ))}
          {cancel}
        </div>
        <FormError message={error} />
      </div>
    );

  if (request.kind === "credential") {
    const target = request.secret!;
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(async () => {
            // The value goes to the repository's secrets; the tracker never sees it.
            await api(`/repos/${target.repo}/ci/secrets/${encodeURIComponent(target.name)}`, {
              method: "PUT",
              json: { value: secret },
            });
            setSecret("");
            return onAnswer({ stored: true });
          });
        }}
      >
        <label className="mk-field">
          <span className="mk-label">
            Stored as <code className="mk-mono">{target.name}</code> on {target.repo}
          </span>
          <input
            className="mk-input"
            type="password"
            autoComplete="off"
            required
            value={secret}
            onChange={(e) => setSecret(e.currentTarget.value)}
          />
          <span className="mk-hint">The agent gets the secret's name, never its value.</span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button className="mk-btn mk-btn--primary mk-btn--sm" disabled={busy || !secret}>
            Store secret
          </button>
          {cancel}
        </div>
        <FormError message={error} />
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (request.kind === "question") void send(() => onAnswer({ answer: text }));
      }}
    >
      <textarea
        className="mk-input min-h-20"
        aria-label={request.kind === "question" ? "Answer" : "Note (optional)"}
        placeholder={request.kind === "question" ? "Your answer" : "Add a note (optional)"}
        required={request.kind === "question"}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {request.kind === "question" ? (
          <button className="mk-btn mk-btn--primary mk-btn--sm" disabled={busy || !text.trim()}>
            Answer
          </button>
        ) : (
          <>
            <button
              type="button"
              className="mk-btn mk-btn--primary mk-btn--sm"
              disabled={busy || !approvable}
              title={approvable ? undefined : "New commits since this checkpoint"}
              onClick={() =>
                void send(() =>
                  onAnswer({ approved: true, ...(text.trim() ? { answer: text } : {}) }),
                )
              }
            >
              Approve
            </button>
            <button
              type="button"
              className="mk-btn mk-btn--danger-ghost mk-btn--sm"
              disabled={busy}
              onClick={() =>
                void send(() =>
                  onAnswer({ approved: false, ...(text.trim() ? { answer: text } : {}) }),
                )
              }
            >
              Reject
            </button>
          </>
        )}
        {cancel}
      </div>
      <FormError message={error} />
    </form>
  );
}
