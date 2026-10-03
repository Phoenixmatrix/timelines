// Which option is active. Selection follows an option's ID, not its position,
// so results arriving or reordering never move it to a different option.

export interface Selection {
  id: string | null;
  /** The person moved to it (arrows, pointer); otherwise it's the default first option. */
  chosen: boolean;
}

export const FRESH: Selection = { id: null, chosen: false };

/**
 * The selection after the options change. A default selection settles on the
 * first option until there is one; a chosen option that disappears leaves
 * nothing selected rather than something the person didn't pick.
 */
export function reconcile(
  selection: Selection,
  ids: string[],
  /** The options a default may land on (fallbacks excluded); all of them if omitted. */
  defaults: string[] = ids,
): Selection {
  if (selection.id !== null && ids.includes(selection.id)) return selection;
  if (selection.chosen) return selection.id === null ? selection : { id: null, chosen: true };
  const first = defaults[0] ?? null;
  return first === selection.id ? selection : { id: first, chosen: false };
}

/** One step through the options (wrapping), as the person's choice. */
export function move(selection: Selection, ids: string[], step: 1 | -1): Selection {
  if (!ids.length) return selection;
  const at = selection.id === null ? -1 : ids.indexOf(selection.id);
  const next =
    at === -1 ? (step === 1 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length;
  return { id: ids[next]!, chosen: true };
}

/** Home and End. */
export function edge(ids: string[], end: "first" | "last"): Selection {
  const id = end === "first" ? ids[0] : ids[ids.length - 1];
  return id === undefined ? FRESH : { id, chosen: true };
}
