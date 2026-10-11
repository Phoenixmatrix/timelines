/*
 * DIRECTION (impeccable, locked: console-ledger, seed key 270eceb2)
 *
 * THESIS       Signing in reads as a short, honest ledger of steps, the way gm
 *              reports its own work: email, code, signed in. Each finished step
 *              settles into one quiet row as the next opens, so you always see
 *              where you are. /device is the same ledger from gm's side.
 * OWN-WORLD    MatrixKit Neo on its darkest stage: no rail, no cards. Amber
 *              marks only the step in progress and the one primary action;
 *              green confirms a settled step; mono only for data (the host, the
 *              time a code was sent, the code itself).
 * STORY        Arrive, type your email, see it settle, type the code from the
 *              mail (or paste it), and you're in. From gm, check the code your
 *              terminal shows and approve it.
 * FIRST VIEW   Wordmark and host across the top; a 30rem column with the
 *              heading, the three-step ledger with the active step open, the
 *              invite-only line; dev personas as a quiet appendix below.
 * FORM         console-ledger, seed key 270eceb2. Signature: steps that settle
 *              into ledger rows with their timestamp; six code cells that
 *              take a paste and submit on the last digit.
 * FINISH       unreviewed and undocumented is unfinished; this build ends with
 *              the finish review, the verdict, DESIGN.md, and every shipping
 *              raster carrying its provenance
 */

import { CheckIcon } from "@phosphor-icons/react";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { GitmatrixLogo } from "./GitmatrixLogo.tsx";

/** A focused page outside the app shell: mark and host on top, one column, a footer. */
export function AuthFrame({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const host = typeof window === "undefined" ? "" : window.location.host;
  return (
    <div className="flex min-h-dvh flex-col bg-stage">
      <header className="flex items-center justify-between gap-4 px-5 py-4 sm:px-8 sm:py-5">
        <Link to="/" aria-label="Timelines" className="shrink-0 rounded-control">
          <GitmatrixLogo className="h-8 w-auto" />
        </Link>
        <span className="truncate font-mono text-micro text-ink-faint">{host}</span>
      </header>
      <main className="flex flex-1 justify-center px-5 pt-[8vh] pb-16 sm:px-8 sm:pt-[12vh]">
        <div className="w-full max-w-[30rem]">{children}</div>
      </main>
      {footer && (
        <footer className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-line-soft px-5 py-4 text-body-sm text-ink-faint">
          {footer}
        </footer>
      )}
    </div>
  );
}

export type StepState = "done" | "active" | "waiting";

/** The ledger: steps joined by a thread, the active one open. */
export function Ledger({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ol aria-label={label} className="m-0 mt-8 flex list-none flex-col p-0">
      {children}
    </ol>
  );
}

function Marker({ state }: { state: StepState }) {
  if (state === "done")
    return (
      <span className="flex size-6 items-center justify-center rounded-full bg-online/15 text-online">
        <CheckIcon weight="bold" className="size-3.5" aria-hidden />
      </span>
    );
  if (state === "active")
    return (
      <span className="flex size-6 items-center justify-center rounded-full ring-2 ring-signal-line ring-inset">
        <span className="size-2 rounded-full bg-signal" />
      </span>
    );
  // Waiting steps stay legible (≥3:1 against the stage), so the path reads up front.
  return <span className="size-6 rounded-full ring-1 ring-ink-faint/70 ring-inset" />;
}

/**
 * One step. Done: a settled row (title, value, time, an action). Active: the
 * step opens to its content. Waiting: its title alone, faint.
 */
export function Step({
  state,
  title,
  value,
  time,
  action,
  last = false,
  children,
}: {
  state: StepState;
  title: string;
  /** Done steps: what was settled (an email address, an account). */
  value?: ReactNode;
  /** Done steps: when it settled, as an ISO time. */
  time?: string;
  /** Done steps: a quiet way to redo it. */
  action?: ReactNode;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <li
      className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-4"
      aria-current={state === "active" ? "step" : undefined}
    >
      <div className="flex flex-col items-center">
        <Marker state={state} />
        {!last && (
          <span
            aria-hidden
            className={`my-1.5 w-px flex-1 ${state === "done" ? "bg-online/40" : "bg-line-soft"}`}
          />
        )}
      </div>
      <div className={last ? "" : "pb-6"}>
        <div className="flex min-h-6 items-baseline gap-3">
          <span
            className={`text-body-sm font-semibold ${state === "waiting" ? "text-ink-faint" : "text-ink"}`}
          >
            {title}
            {state === "done" && <span className="sr-only">, done</span>}
          </span>
          {state === "done" && value && (
            <span className="min-w-0 flex-1 truncate text-body-sm text-ink-muted">{value}</span>
          )}
          {state === "done" && time && (
            <time
              dateTime={time}
              className="ml-auto shrink-0 font-mono text-micro text-ink-faint tabular-nums"
            >
              {new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </time>
          )}
          {state === "done" && action && <span className="shrink-0">{action}</span>}
        </div>
        {state === "active" && children && <div className="mk-enter-up mt-3">{children}</div>}
      </div>
    </li>
  );
}

/**
 * A one-time code as six cells over one real input, so paste and the mail
 * client's autofill work; the form submits itself on the sixth digit.
 */
export function CodeCells({
  name,
  invalid,
  describedBy,
}: {
  name: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(true);
  const at = Math.min(value.length, 5);
  return (
    <div className="relative" onClick={() => input.current?.focus()}>
      <input
        ref={input}
        name={name}
        value={value}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        autoFocus
        aria-label="6-digit code"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
        className="absolute inset-0 z-[1] h-full w-full cursor-text opacity-0"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
          setValue(digits);
          if (digits.length === 6) event.target.form?.requestSubmit();
        }}
      />
      <div aria-hidden className="grid grid-cols-6 gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            className={`flex h-14 items-center justify-center rounded-control bg-sunken font-mono text-display font-normal text-ink tabular-nums transition-shadow duration-150 ${
              focused && i === at
                ? "ring-2 ring-signal-line"
                : invalid
                  ? "ring-1 ring-danger-text/60"
                  : "ring-1 ring-line-soft"
            }`}
          >
            {value[i] ?? ""}
          </span>
        ))}
      </div>
    </div>
  );
}
