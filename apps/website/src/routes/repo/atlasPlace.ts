// Where a reader is in the repository Atlas, kept when a Knowledge build
// lands under them (CORE-187). An unpinned view moves to the new map on its
// own: the status poll revalidates the route and the view is rebuilt for the
// new snapshot. That rebuild must not throw the reader out: the outline stays
// open where it was, and focus returns to what had it (the same outline row,
// the inspector, or the same control) instead of falling back to the page.
// A pinned view (anything selected) re-reads its own snapshot and isn't
// rebuilt at all.

/** What the outline had open, and which of its rows was current. */
export interface OutlinePlace {
  expanded: string[];
  active: string | null;
  /** The rows above the current one, outermost first. */
  trail: string[];
  /** Focus was on one of its rows. */
  focused: boolean;
}

/** A focused control outside the outline, told apart by what assistive technology reads. */
export interface FocusMark {
  tag: string;
  role: string | null;
  label: string;
}

export interface ReaderPlace {
  /** The repository this place is in: never carried to another one. */
  scope: string;
  outline: OutlinePlace | null;
  /** Focus was in the selection's inspector. */
  inspector: boolean;
  other: FocusMark | null;
}

/** The address and snapshot a view was last drawn for. */
export interface Shown {
  /** The location's key: a navigation makes a new one, a revalidation doesn't. */
  key: string;
  scope: string;
  snapshot: string | null;
}

/**
 * The view now shows another snapshot of the same repository without the
 * reader going anywhere: a build landed and the route was read again.
 */
export function landedUnder(before: Shown | null, now: Shown): boolean {
  return (
    before !== null &&
    before.snapshot !== null &&
    now.snapshot !== null &&
    before.key === now.key &&
    before.scope === now.scope &&
    before.snapshot !== now.snapshot
  );
}

const nameOf = (el: Element) =>
  (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();

export function markOf(el: Element): FocusMark {
  return { tag: el.tagName, role: el.getAttribute("role"), label: nameOf(el) };
}

/** The control under `root` that reads the same as `mark`, if there's exactly one. */
export function findMarked(root: ParentNode, mark: FocusMark): HTMLElement | null {
  const found = [...root.querySelectorAll<HTMLElement>(mark.tag)].filter(
    (el) => el.getAttribute("role") === mark.role && nameOf(el) === mark.label,
  );
  return found.length === 1 ? found[0]! : null;
}

/** Nothing has focus: it fell back to the page, as when what had it went away. */
export function focusLost(doc: Document = document): boolean {
  return !doc.activeElement || doc.activeElement === doc.body;
}
