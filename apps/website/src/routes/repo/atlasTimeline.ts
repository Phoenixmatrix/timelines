// A timeline on the Knowledge tab (CORE-176), in words: what the Atlas
// timeline view (GET /atlas/timeline, AtlasTimeline.tsx) says about where
// each changed file sits, how fresh the overlay is against the map on screen,
// and how wiki pages relate to it. Every sentence says what the data says:
// placements are main's; where the timeline's regrouping (CORE-186) puts a
// file is computed over the capabilities it touches, and said to be; a new
// file's place without it is an inference; and an overlay or a page measured
// against another main says so.
//
// The view's one address key, beside the app-wide `?tl`:
//
//   tlwithin=<capability or area id>   only the timeline's changes there

import type {
  AtlasMainRelation,
  AtlasSnapshotRef,
  AtlasTimelineCaveat,
  AtlasTimelineFile,
  AtlasTimelineRepo,
} from "../../../shared/atlas.ts";

export const TIMELINE_WITHIN = "tlwithin";

const MAX_ID = 2048;

/** The capability or area the timeline view is limited to, from the address. */
export function readTimelineWithin(search: string | URLSearchParams): string | null {
  const value = new URLSearchParams(search).get(TIMELINE_WITHIN);
  return value && value.length <= MAX_ID && value.trim() === value ? value : null;
}

const short = (oid: string | null | undefined) => (oid ? oid.slice(0, 7) : "unknown");

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Where a file sits, in words, with an inferred place said to be one. */
export function placementText(file: AtlasTimelineFile): string {
  const { placement } = file;
  const capability = placement.capability?.name ?? "a capability this map doesn't name";
  const where = placement.area?.name ? `${placement.area.name} (in ${capability})` : capability;
  switch (placement.state) {
    case "projected": {
      const here = file.change === "removed" ? `Was in ${where}.` : `In ${where}.`;
      return file.regrouping?.moved ? `${here} ${regroupedText(file)}` : here;
    }
    case "computed":
      return placement.capability
        ? `New: the timeline's regrouping puts it in ${where}.`
        : `New: ${regroupedText(file)}`;
    case "provisional":
      return `Provisionally in ${capability}: ${
        placement.basis
          ? `${plural(placement.basis.files, "file")} of ${placement.basis.of} in ${placement.basis.folder || "the top folder"}/ are there`
          : "its folder's files are there"
      }. Main's next build places it.`;
    case "unclassified":
      return file.change === "added"
        ? file.regrouping
          ? "Unclassified: the timeline's regrouping finds nothing to place it by."
          : "Unclassified: nothing in the map places its folder yet."
        : file.change === "removed"
          ? "Was unclassified in this map."
          : "Unclassified in this map.";
  }
}

const RELATION: Record<AtlasMainRelation, string> = {
  same: "the same main as this map",
  older: "an older main than this map",
  newer: "a newer main than this map",
  unknown: "a main this map can't place",
};

/** Where the timeline's regrouping would put a file, in words. */
export function regroupedText(file: AtlasTimelineFile): string {
  const r = file.regrouping;
  if (!r) return "";
  if (!r.capability) return "The timeline's regrouping leaves it unclassified.";
  const name = r.capability.name ?? "a capability this map doesn't name";
  if (r.capability.proposed)
    return `The timeline's regrouping puts it in a capability main doesn't have, ${name}.`;
  return `The timeline's regrouping would move it to ${r.area?.name ? `${r.area.name} (in ${name})` : name}.`;
}

/** Where some main commit sits relative to the map, in words. */
export const relationText = (relation: AtlasMainRelation) => RELATION[relation];

const STATE: Record<AtlasTimelineRepo["state"], string> = {
  "up-to-date": "Up to date",
  building: "Updating",
  queued: "Update queued",
  failed: "Last update failed",
  waiting: "Waits for main's first graph",
  ended: "Ended",
  unavailable: "Unavailable: Knowledge isn't computing overlays here",
  none: "Not in this repository: no such bookmark, and no overlay of one kept",
};

export const stateText = (state: AtlasTimelineRepo["state"]) => STATE[state];

/** The merge base, in words, including when there isn't one. */
export function mergeBaseText(repo: AtlasTimelineRepo): string {
  switch (repo.mergeBaseState) {
    case "found":
      return short(repo.mergeBase);
    case "none":
      return "none found: compared with main's tree directly";
    case "truncated":
      return "not found within the history read: compared with main's tree directly";
    case "unknown":
      return "unknown until the overlay is computed";
  }
}

/** The bookmark's tip, in words, including when it's gone or couldn't be read. */
export function headText(repo: AtlasTimelineRepo): string {
  if (!repo.headKnown) return "unknown: the bookmarks couldn't be read";
  if (!repo.head) return repo.ended ? "gone (the timeline ended)" : "gone";
  return short(repo.head);
}

/** The syntax-change feed's coverage of the timeline's files, in words. */
export function coverageText(repo: AtlasTimelineRepo): string {
  const { files, syntax } = repo.coverage;
  if (files === 0) return "No files changed.";
  if (syntax === files)
    return `Syntax changes cover all ${plural(files, "changed file")} (by language).`;
  return `Syntax changes cover ${syntax.toLocaleString()} of ${plural(files, "changed file")}; the rest are in languages the syntax feed doesn't read.`;
}

/** A timeline caveat in words. */
export function timelineCaveatText(caveat: AtlasTimelineCaveat): string {
  switch (caveat.code) {
    case "regrouping":
      switch (caveat.state) {
        case "computed":
          return `Regrouping was computed for this timeline over the ${plural(caveat.capabilities, "capability", "capabilities")} it touches (${plural(caveat.files, "file")}), not the whole repository, against main's build #${caveat.seq}${
            caveat.basis === "same"
              ? ", this map"
              : `, ${caveat.basis === "older" ? "older" : "newer"} than this map`
          }. Main's own next build may still group differently.`;
        case "pending":
          return "Regrouping isn't computed for this overlay yet: files sit where main's map put them, and new ones are placed provisionally.";
        case "skipped":
          return caveat.reason === "too-large"
            ? "Regrouping wasn't computed: the timeline touches too many capabilities. Files sit where main's map put them, and new ones are placed provisionally."
            : caveat.reason === "no-snapshot"
              ? "Regrouping wasn't computed: there was no map of main when the overlay was. Files sit where main's map put them, and new ones are placed provisionally."
              : "Regrouping couldn't be computed for this overlay: files sit where main's map put them, and new ones are placed provisionally.";
      }
      break;
    case "base":
      return `The overlay was computed against main at ${short(caveat.baseCommit)}, ${relationText(caveat.relation)} (${short(caveat.projectionCommit)}): main's own changes in between can show here.`;
    case "truncated":
      return `The overlay kept the first ${caveat.stored.toLocaleString()} of ${caveat.total.toLocaleString()} changes: the rest aren't listed or counted here.`;
    case "merge-base":
      return caveat.state === "truncated"
        ? "The history was too long to find where the timeline left main, so it was compared with main's tree: main's newer work can read as the timeline undoing it."
        : "The timeline shares no history with main, so it was compared with main's tree directly.";
    case "behind":
      return `Showing the overlay of ${short(caveat.commit)}; the bookmark has since moved to ${short(caveat.head)}.`;
    case "imports-partial":
      return "Only the first imports and new folders were resolved to capabilities: some may be missing.";
    case "no-map":
      return "This repository has no Atlas yet, so its files aren't placed or listed here.";
  }
}

/**
 * A wiki page's place against the map on screen: written from the same
 * commit, or before or after the map's build (by when it was written).
 */
export function wikiNote(
  page: { generatedIn?: string; updatedAt: string },
  snapshot: Pick<AtlasSnapshotRef, "vector" | "publishedAt">,
): string | null {
  if (!page.generatedIn) return null;
  const commit = snapshot.vector[0]?.commit ?? null;
  if (page.generatedIn === commit) return `Written from this map's commit, ${short(commit)}.`;
  const written = Date.parse(page.updatedAt);
  const built = snapshot.publishedAt ? Date.parse(snapshot.publishedAt) : Number.NaN;
  if (Number.isNaN(written) || Number.isNaN(built))
    return `Written from ${short(page.generatedIn)}; this map is from ${short(commit)}.`;
  return `Written from ${short(page.generatedIn)}, ${written < built ? "before" : "after"} this map (${short(commit)}) was built: it may describe ${written < built ? "older" : "newer"} code.`;
}
