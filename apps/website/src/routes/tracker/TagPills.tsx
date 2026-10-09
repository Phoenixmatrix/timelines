// One-click tag filters under the query bar (CORE-253): every tag the query
// filters on, pressed (click to remove it), then the tags most used in what the
// query shows, to add with one click. The query stays the source of truth:
// a pill only adds or removes its `tag:` term.

import { HashIcon, XIcon } from "@phosphor-icons/react";
import { parseQuery, toggleToken, type FacetValue } from "./query.ts";

/** How many pills in all: the active filters first, then common tags to fill. */
const PILLS = 6;

export function TagPills({
  query,
  common,
  onQuery,
}: {
  query: string;
  /** The tag facet: tags in what the query shows (ignoring its own tag terms), most used first. */
  common: FacetValue[];
  onQuery: (query: string) => void;
}) {
  const active: { value: string; negated: boolean }[] = [];
  for (const f of parseQuery(query).filters)
    if (f.key === "tag" && !active.some((a) => a.value === f.value && a.negated === f.negated))
      active.push({ value: f.value, negated: f.negated });
  const offered = common
    .filter((v) => !active.some((a) => a.value === v.token.value))
    .slice(0, Math.max(0, PILLS - active.length));
  if (!active.length && !offered.length) return null;
  const label = (value: string) => common.find((v) => v.token.value === value)?.label ?? value;
  return (
    <div role="group" aria-label="Filter by tag" className="flex flex-wrap items-center gap-1.5">
      <span className="text-micro text-ink-muted" aria-hidden>
        Tags
      </span>
      {active.map(({ value, negated }) => (
        <button
          key={`${negated ? "-" : ""}${value}`}
          type="button"
          className="mk-chip max-w-full gap-1"
          aria-pressed="true"
          aria-label={`${negated ? "Hiding" : "Showing"} issues tagged ${label(value)}. Remove this filter`}
          onClick={() => onQuery(toggleToken(query, "tag", value, negated))}
        >
          <HashIcon weight="bold" className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {negated && "not "}
            {label(value)}
          </span>
          <XIcon weight="bold" className="size-3 shrink-0" aria-hidden />
        </button>
      ))}
      {offered.map((v) => (
        <button
          key={v.token.value}
          type="button"
          className="mk-chip max-w-full gap-1"
          aria-pressed="false"
          aria-label={`Show issues tagged ${v.label} (${v.count})`}
          onClick={() => onQuery(toggleToken(query, "tag", v.token.value))}
        >
          <HashIcon weight="bold" className="size-3 shrink-0 text-ink-faint" aria-hidden />
          <span className="min-w-0 truncate">{v.label}</span>
          <span className="font-mono text-micro tabular-nums opacity-70" aria-hidden>
            {v.count.toLocaleString()}
          </span>
        </button>
      ))}
    </div>
  );
}
