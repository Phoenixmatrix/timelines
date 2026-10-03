// What the repository Atlas keeps in its address (CORE-171), so Back/Forward,
// reloads and copied links come back to the same place:
//
//   select=<entity id>       what's selected (and so the path opened to it)
//   snapshot=<snapshot id>   the snapshot it was read from; absent, the current one
//   lens=out:imports         the relationship lens: direction, then kind
//   q=<text>&kind=<kind>     the catalogue lookup and its kind filter
//
// Everything else in the search string (the app-wide `tl` timeline scope
// among it) is left exactly as it was.

import type { AtlasDirection } from "../../../shared/atlas.ts";

export interface AtlasLens {
  direction: AtlasDirection;
  /** A relation kind; null: the most common one the selection has. */
  kind: string | null;
}

export interface AtlasUrlState {
  select: string | null;
  snapshot: string | null;
  lens: AtlasLens;
  q: string;
  /** The lookup's kind filter; null: every kind. */
  kind: string | null;
}

export const DEFAULT_LENS: AtlasLens = { direction: "out", kind: null };

/** Kinds the lookup can be narrowed to, in the order the filter offers them. */
export const LOOKUP_KINDS = ["capability", "area", "file", "symbol"] as const;

const KIND = /^[a-z_]{1,32}$/;
/** Entity and snapshot ids are opaque, but never this long. */
const MAX_ID = 2048;

const idOrNull = (value: string | null) =>
  value && value.length <= MAX_ID && value.trim() === value ? value : null;

export function parseLens(raw: string | null): AtlasLens {
  if (!raw) return DEFAULT_LENS;
  const [direction, kind] = raw.split(":", 2);
  if (direction !== "in" && direction !== "out") return DEFAULT_LENS;
  return { direction, kind: kind && KIND.test(kind) ? kind : null };
}

export function formatLens(lens: AtlasLens): string | null {
  if (lens.direction === "out" && !lens.kind) return null;
  return lens.kind ? `${lens.direction}:${lens.kind}` : lens.direction;
}

export function readAtlasUrl(search: string | URLSearchParams): AtlasUrlState {
  const params = new URLSearchParams(search);
  const kind = params.get("kind");
  return {
    select: idOrNull(params.get("select")),
    snapshot: idOrNull(params.get("snapshot")),
    lens: parseLens(params.get("lens")),
    q: (params.get("q") ?? "").slice(0, 200),
    kind: kind && (LOOKUP_KINDS as readonly string[]).includes(kind) ? kind : null,
  };
}

/**
 * `search` with `patch` applied: a key set to null (or "", or the default
 * lens) is removed; keys not in the patch, and every parameter the Atlas
 * doesn't own, stay as they were.
 */
export function writeAtlasUrl(
  search: string | URLSearchParams,
  patch: Partial<AtlasUrlState>,
): URLSearchParams {
  const params = new URLSearchParams(search);
  const set = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  };
  set("select", patch.select);
  set("snapshot", patch.snapshot);
  if (patch.lens !== undefined) set("lens", formatLens(patch.lens));
  set("q", patch.q === undefined ? undefined : patch.q.trim() ? patch.q : null);
  set("kind", patch.kind);
  return params;
}

/** A link to an entity in a repository's Atlas, keeping the rest of `search` (e.g. `tl`). */
export function atlasHref(
  base: string,
  patch: Partial<AtlasUrlState>,
  search: string | URLSearchParams = "",
): string {
  const query = writeAtlasUrl(search, patch).toString();
  return `${base}${query ? `?${query}` : ""}`;
}
