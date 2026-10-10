// Honest degraded and failure states for the Atlas (CORE-173): what the map
// shows, and what it can't, in words. Missing evidence never reads as zero
// dependencies, a verified empty capability or fresh prose; every state keeps
// structure and source access working, and says so where it matters.

import type { KnowledgeStatus } from "../../../shared/api.ts";
import type {
  AtlasDescriptionStatus,
  AtlasEntitySummary,
  AtlasOverview,
  AtlasUnavailableReason,
} from "../../../shared/atlas.ts";

export interface AtlasNotice {
  id: string;
  tone: "info" | "warn" | "error";
  text: string;
  /** Offer the current snapshot: this view shows an older one. */
  current?: boolean;
}

const short = (commit: string | null | undefined) =>
  commit ? commit.slice(0, 7) : "an earlier commit";

/** What's true of the whole map: build state, freshness, coverage and summaries. */
export function scopeNotices(
  status: KnowledgeStatus | null,
  overview: Pick<AtlasOverview, "snapshot" | "capacityFailure" | "regions">,
): AtlasNotice[] {
  const notices: AtlasNotice[] = [];
  const mapCommit = overview.snapshot.vector[0]?.commit ?? null;

  if (status) {
    if (status.state === "failed")
      notices.push({
        id: "failed",
        tone: "error",
        text: `The latest Knowledge build failed, so this map is from ${short(mapCommit)}, not the newest code.`,
      });
    // A pending or running update is the status chip's to say (CORE-212):
    // repeating it here said the same thing twice.
    else if (status.state === "queued" || status.state === "building") {
      // Nothing more to say until it lands.
    } else if (status.indexedCommit && mapCommit && status.indexedCommit !== mapCommit)
      notices.push({
        id: "newer",
        tone: "info",
        text: `A newer map, from ${short(status.indexedCommit)}, is ready. This view keeps ${short(mapCommit)}.`,
        current: true,
      });
    else if (status.head && mapCommit && status.head !== mapCommit && status.state === "up-to-date")
      notices.push({
        id: "behind",
        tone: "warn",
        text: `This map shows ${short(mapCommit)}, behind the branch at ${short(status.head)}.`,
      });
  }
  if (overview.capacityFailure)
    notices.push({
      id: "capacity",
      tone: "warn",
      text: "The newest build didn't fit the Atlas storage limit; this is the previous map.",
    });
  if (overview.snapshot.partial)
    notices.push({
      id: "partial",
      tone: "info",
      text: "Some files aren't analyzed yet: counts are a floor, and those files sit in Unclassified until they are.",
    });

  const reasons = new Map<AtlasUnavailableReason, number>();
  const described = overview.regions.filter((r) => r.summaryState);
  for (const r of described)
    if (r.summaryState?.reason)
      reasons.set(r.summaryState.reason, (reasons.get(r.summaryState.reason) ?? 0) + 1);
  if (described.length && reasons.get("disabled") === described.length)
    notices.push({
      id: "summaries-off",
      tone: "info",
      text: "Summaries are off (no priced model is configured). Structure, links and sources are complete.",
    });
  else if (reasons.get("budget_exhausted"))
    notices.push({
      id: "summaries-paused",
      tone: "warn",
      text: "Some summaries are paused: the Atlas AI budget is used up. They resume on a later build; structure and sources are unaffected.",
    });
  if (reasons.get("provider_error") || reasons.get("invalid_reply") || reasons.get("error"))
    notices.push({
      id: "summaries-failed",
      tone: "warn",
      text: "Some summaries couldn't be written this build and aren't retried automatically.",
    });
  return notices;
}

/**
 * A missing or stale summary, in words; null when the summary is current or
 * not applicable. `basis` is the commit a stale summary was written from.
 */
export function summaryNote(
  state: AtlasEntitySummary["summaryState"],
  basis?: string | null,
): string | null {
  if (!state || state.status === "current") return null;
  const why: Record<AtlasUnavailableReason, string> = {
    budget_exhausted: "the Atlas AI budget was used up",
    disabled: "summaries are off",
    provider_error: "the model call failed",
    invalid_reply: "the model's reply wasn't usable",
    error: "the summary step failed",
  };
  const reason = state.reason ? ` (${why[state.reason]})` : "";
  return (state.status as AtlasDescriptionStatus) === "stale"
    ? `Summary out of date${reason}: it describes ${basis ? basis.slice(0, 7) : "an earlier build"}.`
    : `No summary for this build${reason}. The structure and sources below are complete.`;
}

/** Languages whose imports are extracted (worker/knowledge/extract.ts RULES). */
const LINKED = new Set(["typescript", "javascript", "rust", "python", "go", "sql", "css"]);

const SKIPPED: Record<string, string> = {
  binary: "a binary file",
  lockfile: "a lockfile",
  generated: "generated code",
  asset: "an asset",
  "too large": "too large to analyze",
  empty: "empty",
};

/**
 * Why a file has no summary or links, or sits in Unclassified; null when
 * it's analyzed and placed.
 */
export function fileNote(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  if (data.pending)
    return "Not analyzed yet: its summary, links and capability come with the next analysis. The source is here now.";
  if (typeof data.skipped === "string")
    return `Skipped as ${SKIPPED[data.skipped] ?? data.skipped}: no summary or links are extracted from it, but the source is still here.`;
  const membership = data.membership as { unclassified?: string } | undefined;
  const language = typeof data.language === "string" ? data.language : null;
  if (language && !LINKED.has(language) && membership?.unclassified)
    return `Unclassified: links aren't extracted from ${language} files yet, so nothing places it. That's unsupported, not unused.`;
  switch (membership?.unclassified) {
    case "no-evidence":
      return "Unclassified: nothing ties it to other files (no imports, no shared concepts). That's a lack of evidence, not proof it's unused.";
    case "isolated":
      return "Unclassified: its links don't single out a group.";
    case "weak-evidence":
      return "Unclassified: it links only to a group too small to be a capability.";
    default:
      return null;
  }
}
