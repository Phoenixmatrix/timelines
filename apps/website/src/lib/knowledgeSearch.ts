import type { KnowledgeSearchResults } from "../../shared/api.ts";

/**
 * What a knowledge search's results can't show on their own: an index that
 * isn't built yet, one that's building, a lookup that failed, or (only when
 * everything answered) that nothing matched. Shared by the Knowledge page and
 * the palette so both say the same thing.
 */
export function knowledgeSearchNotes(search: KnowledgeSearchResults): string[] {
  const notes: string[] = [];
  const empty = !search.entities.length && !search.passages.length;
  if (search.index.state === "none")
    return [
      "This repository isn't indexed yet, so there's nothing to search. Indexing starts after a push.",
    ];
  if (search.index.state === "building")
    notes.push("Indexing is running: results may be from the previous build, or missing.");
  const failed = [
    search.providers.entities === "failed" ? "names and symbols" : "",
    search.providers.passages === "failed" ? "code and wiki passages" : "",
  ].filter(Boolean);
  if (failed.length) notes.push(`Couldn't search ${failed.join(" or ")} right now.`);
  else if (empty) notes.push("Nothing matches. Try a name, or describe the behavior.");
  return notes;
}
