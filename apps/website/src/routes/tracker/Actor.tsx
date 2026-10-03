// Who did or holds something, with the accountable person always in view.

import { RobotIcon } from "@phosphor-icons/react";
import type { Attribution } from "../../../shared/tracker.ts";
import { Monogram } from "../../components/Monogram.tsx";

function described(who: Attribution): string {
  if (who.kind === "agent") {
    return `${who.name} · Agent${who.person ? ` · Accountable: ${who.person.displayName}` : ""}`;
  }
  if (!who.person || who.kind === "person") return who.name;
  return `${who.person.displayName} · ${who.name}`;
}

/**
 * The person's monogram, an agent robot badge, and one primary name. Ownership
 * stays in the monogram, tooltip and accessible text instead of repeated prose.
 * `compact` hides session labels; `face` keeps only the identity icons.
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
  const secondary = who.kind === "session" ? who.name : null;
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center gap-1 align-middle ${className}`}
      title={described(who)}
    >
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
    </span>
  );
}
