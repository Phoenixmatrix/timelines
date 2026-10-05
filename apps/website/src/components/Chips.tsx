// The tracker's one tag vocabulary in its three roles (CORE-271), told apart by
// shape and mark rather than hue: an issue's tags (filled, a hash mark), an
// agent's tags (outlined, a robot mark) and requirements (mono terms on a dashed
// recessed pill). Status words keep the plain `mk-chip--tag`. See DESIGN.md "Chips".

import { HashIcon, RobotIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Link } from "react-router";

const MARK = "size-2.5 shrink-0";

/** What an issue is about: a name from the tracker's tag catalog. Inert unless `to` is given. */
export function IssueTagChip({
  name,
  to,
  className = "",
}: {
  name: string;
  to?: string;
  className?: string;
}) {
  const body = (
    <>
      <HashIcon className={MARK} weight="bold" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
    </>
  );
  const classes = `mk-chip mk-chip--tag mk-chip--issue-tag max-w-full ${className}`;
  return to ? (
    <Link to={to} className={`${classes} mk-chip--link`} aria-label={`Issues tagged ${name}`}>
      {body}
    </Link>
  ) : (
    <span className={classes} aria-label={`Tag ${name}`}>
      {body}
    </span>
  );
}

/**
 * What work an agent suits, from the same catalog. `unknown` flags a name no
 * tracker's catalog has: kept, never refused, but no issue is tagged with it.
 */
export function AgentTagChip({
  name,
  to,
  unknown = false,
}: {
  name: string;
  to?: string;
  unknown?: boolean;
}) {
  const body = (
    <>
      <RobotIcon className={MARK} weight="bold" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
      {unknown && <WarningCircleIcon className={MARK} weight="bold" aria-hidden />}
    </>
  );
  const label = `Agent tag ${name}${unknown ? ", not in any tracker's tag catalog" : ""}`;
  const classes = `mk-chip mk-chip--tag mk-chip--agent-tag max-w-full ${unknown ? "mk-chip--unknown" : ""}`;
  return to ? (
    <Link
      to={to}
      className={`${classes} mk-chip--link`}
      aria-label={`${label}: open issues tagged ${name}`}
      title={`Open issues tagged ${name}`}
    >
      {body}
    </Link>
  ) : (
    <span
      className={classes}
      aria-label={label}
      title={
        unknown
          ? "No tracker's tag catalog has this name, so no issue is tagged with it."
          : undefined
      }
    >
      {body}
    </span>
  );
}

/** A requirement term (`tag:ux`, `memory>=16GiB`): what an agent must report to claim. */
export function RequirementChip({
  term,
  unknown = false,
  children,
}: {
  term: string;
  /** A `tag:` the tracker's catalog doesn't have: no agent may be tagged with it. */
  unknown?: boolean;
  /** Controls after the term, such as a remove button. */
  children?: ReactNode;
}) {
  return (
    <li
      className={`mk-chip mk-chip--tag mk-chip--requirement max-w-full ${unknown ? "mk-chip--unknown" : ""}`}
      title={unknown ? `${term.slice(4)} isn't in this tracker's tag catalog` : undefined}
    >
      <span className="min-w-0 truncate">{term}</span>
      {unknown && (
        <>
          <WarningCircleIcon className={MARK} weight="bold" aria-hidden />
          <span className="sr-only">, not in this tracker's tag catalog</span>
        </>
      )}
      {children}
    </li>
  );
}
