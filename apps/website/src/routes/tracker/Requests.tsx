// A request to a person, and the form that answers it: on an issue, and on the
// Needs you page. A credential is stored as its repository secret first; the
// tracker only ever hears where it went.

import { useState } from "react";
import type { CheckpointView } from "../../../shared/timelines.ts";
import type { HumanRequest } from "../../../shared/tracker.ts";
import { FormError } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { fullDate, timeAgo } from "../../lib/format.ts";
import { CheckpointPanel, CheckpointRef } from "./Checkpoint.tsx";
import { MarkdownText } from "./ui.tsx";

export type Answer = { answer?: string; choice?: string; approved?: boolean; stored?: boolean };
type Outcome = { ok: boolean; error?: string };

const KIND_LABEL: Record<HumanRequest["kind"], string> = {
  question: "Question",
  approval: "Approval",
  decision: "Decision",
  credential: "Credential",
};

export function RequestCard({
  request,
  name,
  onAnswer,
  onCancel,
  heading,
  checkpoint,
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
}) {
  const open = request.status === "open";
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
      </header>
      {heading}
      <div className="max-w-[72ch] text-body">
        <MarkdownText text={request.prompt} />
      </div>
      {checkpoint ? (
        <CheckpointPanel view={checkpoint.view} tracker={checkpoint.tracker} />
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
              {name(request.answeredBy ?? "")}{" "}
              <time dateTime={request.answeredAt ?? ""} title={fullDate(request.answeredAt ?? "")}>
                {timeAgo(request.answeredAt ?? "")}
              </time>
            </>
          )}
        </p>
      )}
    </article>
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
