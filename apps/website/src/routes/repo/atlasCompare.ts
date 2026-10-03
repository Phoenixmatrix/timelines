// Snapshot comparisons in the Knowledge tab (CORE-175): their address, and
// change records put into words. The comparison is a panel of the Atlas
// (AtlasCompare.tsx) whose state lives in the address beside atlasUrl.ts's
// keys, which leave these alone:
//
//   compare=<snapshot id>     the older snapshot; the newer one is the view's
//                             own (`snapshot`, pinned when a comparison starts)
//   changes=<class>           source, regrouping, summary, evidence or other;
//                             absent: every class but evidence (only counted)
//   within=<entity id>        only this capability or area
//
// Every sentence here says what the records say, no more: a comparison
// separates code changes from grouping and wording changes, and a snapshot
// past retention makes it unavailable, never empty.

import {
  ATLAS_CHANGE_CLASSES,
  type AtlasChange,
  type AtlasChangeClass,
  type AtlasChangeSide,
  type AtlasComparisonCaveat,
  type AtlasError,
} from "../../../shared/atlas.ts";

export interface CompareUrlState {
  compare: string | null;
  changes: AtlasChangeClass | null;
  within: string | null;
}

const MAX_ID = 2048;
const idOrNull = (value: string | null) =>
  value && value.length <= MAX_ID && value.trim() === value ? value : null;

export function readCompareUrl(search: string | URLSearchParams): CompareUrlState {
  const params = new URLSearchParams(search);
  const changes = params.get("changes");
  return {
    compare: idOrNull(params.get("compare")),
    changes: (ATLAS_CHANGE_CLASSES as readonly string[]).includes(changes ?? "")
      ? (changes as AtlasChangeClass)
      : null,
    within: idOrNull(params.get("within")),
  };
}

/** `search` with `patch` applied (null removes a key); everything else stays. */
export function writeCompareUrl(
  search: string | URLSearchParams,
  patch: Partial<CompareUrlState>,
): URLSearchParams {
  const params = new URLSearchParams(search);
  for (const key of ["compare", "changes", "within"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  return params;
}

export const CLASS_LABEL: Record<AtlasChangeClass, string> = {
  source: "Source",
  regrouping: "Regrouping",
  summary: "Summary only",
  evidence: "Evidence recalculated",
  other: "Other",
};

/** What each class means, for the filter's description and the legend. */
export const CLASS_MEANING: Record<AtlasChangeClass, string> = {
  source: "the code changed: files added, removed or edited",
  regrouping: "the grouping placed files or capabilities differently",
  summary: "only names or descriptions changed, with the same source and members",
  evidence:
    "only derived grouping evidence was recomputed (rationale weights, cross-cutting support, counts, concepts, layout): the same source, placement and words",
  other: "recorded differently in a way the other kinds don't explain (analysis details, lineage)",
};

/** The classes the comparison offers as filters; evidence is offered apart, collapsed. */
export const LISTED_CLASSES = ATLAS_CHANGE_CLASSES.filter((c) => c !== "evidence");

const KIND_LABEL: Record<AtlasChange["kind"], string> = {
  capability: "Capability",
  area: "Area",
  file: "File",
};

export const changeKind = (change: AtlasChange) => KIND_LABEL[change.kind];

const short = (oid: string | null | undefined) => (oid ? oid.slice(0, 7) : "unknown");

const UNCLASSIFIED = "group:unclassified";

function nameOf(change: AtlasChange, id: string | null): string | null {
  if (!id) return null;
  return change.names[id] ?? (id === UNCLASSIFIED ? "Unclassified" : null);
}

/** Where a file sat on one side: its area in its capability, or its group. */
export function placeOf(change: AtlasChange, side: AtlasChangeSide | null): string {
  if (!side) return "nowhere";
  const capability = nameOf(change, side.capability);
  const area = nameOf(change, side.area);
  if (area && capability) return `${area} (in ${capability})`;
  return (
    area ??
    capability ??
    nameOf(change, side.parentId) ??
    (side.parentId ? "a place this snapshot doesn't name" : "nowhere")
  );
}

const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const refNames = (refs: { id: string; name: string | null; share?: number }[]) =>
  refs.map(
    (r) =>
      `${r.name ? `“${r.name}”` : "a capability since replaced"}${
        r.share === undefined
          ? ""
          : r.share >= 1
            ? " (all of its files)"
            : ` (${Math.round(r.share * 100)}% of its files)`
      }`,
  );

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const STATE: Record<string, string> = {
  current: "current",
  stale: "stale",
  unavailable: "unavailable",
};
const REASON: Record<string, string> = {
  budget_exhausted: "budget used up",
  disabled: "paid synthesis off",
  provider_error: "the model failed",
  invalid_reply: "the model's reply was unusable",
  error: "naming failed",
};

/** A side's description state in words: "current", "unavailable (budget used up)". */
export function stateOf(side: AtlasChangeSide | null): string | null {
  const state = side?.summaryState;
  if (!state) return null;
  const words = STATE[state.status] ?? state.status;
  return state.reason ? `${words} (${REASON[state.reason] ?? state.reason})` : words;
}

const OTHER_FIELDS: Partial<Record<AtlasChange["fields"][number], string>> = {
  counts: "counts",
  membership: "membership rationale and cross-cutting support",
  analysis: "analysis (lines, language, role, topics or whether it's analyzed)",
  concepts: "concepts",
  layout: "map placement",
  lineage: "recorded lineage",
  provenance: "provenance",
  anchor: "identity anchor",
  grouping: "grouping record",
  detail: "other recorded details",
};

/** A change record in sentences, most important first. */
export function describeChange(change: AtlasChange): string[] {
  const out: string[] = [];
  const { from, to } = change;
  if (change.kind === "file") {
    if (change.presence === "added") out.push(`Added to the source, in ${placeOf(change, to)}.`);
    else if (change.presence === "removed")
      out.push(`Removed from the source; it was in ${placeOf(change, from)}.`);
    else {
      if (change.fields.includes("source"))
        out.push(`Its source changed (blob ${short(from?.blob)} → ${short(to?.blob)}).`);
      if (change.fields.includes("placement"))
        out.push(`Moved from ${placeOf(change, from)} to ${placeOf(change, to)}.`);
      if (change.classes.includes("summary")) out.push("Its summary changed; its source didn't.");
    }
  } else {
    const noun = change.kind === "area" ? "area" : "capability";
    if (change.presence === "added") {
      const origin = change.origin;
      const since = origin?.since ? `, in build #${origin.since}` : "";
      if (origin?.change === "split" && origin.predecessors.length)
        out.push(`New: split from ${list(refNames(origin.predecessors))}${since}.`);
      else if (origin?.change === "merge" && origin.predecessors.length)
        out.push(`New: merged from ${list(refNames(origin.predecessors))}${since}.`);
      else out.push(`New: no earlier ${noun} held most of its files.`);
    } else if (change.presence === "removed") {
      const retired = change.retired;
      if (!retired) out.push(`Not in the newer snapshot.`);
      else if (retired.change === "merged")
        out.push(
          `Merged into ${list(refNames(retired.successors))}, in build #${retired.seq.toLocaleString()}.`,
        );
      else if (retired.change === "split")
        out.push(
          `Split into ${list(refNames(retired.successors))}, in build #${retired.seq.toLocaleString()}.`,
        );
      else out.push(`Removed: none of its files went to another ${noun}.`);
    } else {
      if (change.fields.includes("name") && from && to)
        out.push(`Renamed from “${from.name}” to “${to.name}”.`);
      if (change.kind === "area" && from?.parentId !== to?.parentId)
        out.push(
          `Moved from ${nameOf(change, from?.parentId ?? null) ?? "another capability"} to ${
            nameOf(change, to?.parentId ?? null) ?? "another capability"
          }.`,
        );
    }
    const m = change.members;
    if (m && (m.movedIn || m.movedOut || m.added || m.removed)) {
      const parts = [
        m.movedIn && `${plural(m.movedIn, "file")} moved in`,
        m.movedOut && `${plural(m.movedOut, "file")} moved out`,
        m.added && `${plural(m.added, "file")} added to the source`,
        m.removed && `${plural(m.removed, "file")} removed from the source`,
      ].filter((p): p is string => Boolean(p));
      out.push(`Members: ${list(parts)}.`);
    }
    if (change.presence === "changed") {
      const described = change.fields.some((f) => f === "summary" || f === "description");
      if (change.classes.includes("summary"))
        out.push(`Only its description changed: the same members, from the same source.`);
      else if (described) out.push("Its description changed too.");
      const before = stateOf(from);
      const after = stateOf(to);
      if (described && before && after && before !== after)
        out.push(`Description: ${before} → ${after}.`);
    }
  }
  const rest = change.fields
    .filter(
      (f) => !(change.kind === "file" && f === "analysis" && change.fields.includes("source")),
    )
    .map((f) => OTHER_FIELDS[f])
    .filter((f): f is string => Boolean(f));
  if (change.classes.includes("evidence"))
    out.push(`Only its grouping evidence was recalculated: ${list(rest) || "details"}.`);
  else if (change.classes.includes("other") || (rest.length && !out.length))
    out.push(`Recorded differently: ${list(rest) || "details"}.`);
  return out;
}

/** A comparison caveat in words. */
export function caveatText(caveat: AtlasComparisonCaveat): string {
  switch (caveat.code) {
    case "versions":
      return `The two snapshots were built by different versions of the projection (${caveat.from.projection} → ${caveat.to.projection}) or grouping (${caveat.from.grouping ?? "none"} → ${caveat.to.grouping ?? "none"}): some regrouping may come from the algorithm, not the code.`;
    case "partial":
      return `The ${caveat.side === "from" ? "older" : "newer"} snapshot was built before every file was analyzed: some changes may not show.`;
    case "between":
      return `${plural(caveat.builds, "build")} published between these two. Lineage is recorded build to build, so a predecessor or successor may itself have come and gone in between.`;
    case "same-commit":
      return "Both snapshots were built from the same commit: nothing in the code changed, so any difference comes from analysis, grouping or wording.";
    case "relations":
      return "Relations between capabilities aren't compared: open the lens on either snapshot.";
  }
}

const RETENTION: Record<NonNullable<AtlasError["expired"]>["reason"], string> = {
  age: "it was older than the 7 days prior snapshots are kept",
  count: "newer builds pushed it past the 20 prior snapshots kept",
  storage: "the repository's Atlas storage limit needed the room",
};

/** Why a comparison can't be shown, in words; never "no changes". */
export function unavailableText(error: AtlasError): string {
  const which =
    error.side === "from"
      ? "The older snapshot"
      : error.side === "to"
        ? "The newer snapshot"
        : null;
  if (error.code === "snapshot_expired" && which)
    return `Comparison unavailable. ${which} has expired${
      error.expired ? ` because ${RETENTION[error.expired.reason]}` : ""
    }, and a comparison needs both. That doesn't mean nothing changed.`;
  if (error.code === "snapshot_unknown" && which)
    return `Comparison unavailable. ${which} isn't one this repository keeps, so there's nothing to compare. That doesn't mean nothing changed.`;
  if (error.code === "cursor_expired" || error.code === "cursor_invalid")
    return "This list's page link has expired. Start the comparison again to continue.";
  return `Comparison unavailable: ${error.error}`;
}
