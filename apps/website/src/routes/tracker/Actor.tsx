// Who did or holds something, with the accountable person always in view.

import { RobotIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import type { Attribution } from "../../../shared/tracker.ts";
import { Monogram } from "../../components/Monogram.tsx";

function described(who: Attribution): string {
  if (who.kind === "unknown") return `${who.name} · Unknown identity`;
  if (who.kind === "agent") {
    return `${who.name} · Agent · Accountable: ${who.person?.displayName ?? "Unknown"}`;
  }
  if (!who.person || who.kind === "person") return who.name;
  return `${who.person.displayName} · Session ${who.name}`;
}

/**
 * The person's monogram, an agent robot badge, and one primary name. Ownership
 * stays in the monogram, tooltip and accessible text instead of repeated prose.
 * `compact` hides session names; `face` keeps only the identity icons.
 * `link` makes a person (or their own session) a link to their profile; an
 * agent never is. Only pass it where the actor isn't inside another link or
 * button.
 */
export function Actor({
  who,
  compact = false,
  face = false,
  link = false,
  className = "",
}: {
  who: Attribution;
  compact?: boolean;
  face?: boolean;
  link?: boolean;
  className?: string;
}) {
  const person = who.person?.displayName ?? who.name;
  const primary = who.kind === "session" ? person : who.name;
  const secondary = who.kind === "session" ? who.name : null;
  const profile =
    link && (who.kind === "person" || who.kind === "session") && who.person
      ? `/accounts/${encodeURIComponent(who.person.slug)}`
      : null;
  const body = (
    <>
      <Monogram name={person} size="xs" src={who.person?.avatarUrl} />
      {who.kind === "agent" && (
        <RobotIcon weight="bold" className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
      )}
      <span className="sr-only">{described(who)}</span>
      {!face && (
        <span aria-hidden className="ml-0.5 min-w-0 truncate">
          {primary}
          {!compact && secondary && (
            <span
              className={`text-ink-faint ${who.kind === "session" ? "font-mono text-mono" : ""}`}
            >
              {" "}
              {secondary}
            </span>
          )}
        </span>
      )}
    </>
  );
  const classes = `inline-flex max-w-full min-w-0 items-center gap-1 align-middle ${className}`;
  return profile ? (
    <Link to={profile} className={`${classes} no-underline hover:text-ink`} title={described(who)}>
      {body}
    </Link>
  ) : (
    <span className={classes} title={described(who)}>
      {body}
    </span>
  );
}
