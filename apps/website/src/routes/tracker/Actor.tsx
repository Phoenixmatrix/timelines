// Who did or holds something, with the accountable person always in view.

import { RobotIcon } from "@phosphor-icons/react";
import { attributionText, type Attribution } from "../../../shared/tracker.ts";
import { Monogram } from "../../components/Monogram.tsx";

function described(who: Attribution): string {
  if (!who.person || who.kind === "person") return who.name;
  return who.kind === "agent"
    ? `${who.name}, an agent ${who.person.displayName} is accountable for`
    : `${who.person.displayName}, working as “${who.name}”`;
}

/**
 * The person's monogram, a robot for an agent, then the name. An agent reads
 * "builder for Ann Lee"; a person's labeled session "Ann Lee laptop". `compact`
 * keeps one name for tight cells and `face` shows the monogram alone: either
 * way it shows whose it is, and the tooltip and screen readers get the rest.
 */
export function Actor({
  who,
  compact = false,
  face = false,
  className = "",
}: {
  who: Attribution;
  compact?: boolean;
  face?: boolean;
  className?: string;
}) {
  const person = who.person?.displayName ?? who.name;
  const primary = who.kind === "session" ? person : who.name;
  const secondary =
    who.kind === "agent" && who.person
      ? `for ${who.person.displayName}`
      : who.kind === "session"
        ? who.name
        : null;
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center gap-1 align-middle ${className}`}
      title={described(who)}
    >
      <Monogram name={person} size="xs" />
      {who.kind === "agent" && (
        <RobotIcon weight="bold" className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
      )}
      <span className="sr-only">{attributionText(who)}</span>
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
    </span>
  );
}
