// The Atlas as an outline (CORE-170): the same hierarchy the map draws,
// from the same bounded pages (the overview's regions, the catalogue for the
// rest, a children page per opened entity), as an ARIA tree. It's the
// default on phones and always beside the map, so the canvas is never the
// only way through: arrow keys move, Right opens, Left closes or goes up,
// Enter selects, Home and End jump; a tap does the same without hover or
// pinch. What changed in this build, structural groups and summaries that
// aren't current are said in words, not only in colour.

import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { AtlasEntitySummary, AtlasRegion } from "../../../shared/atlas.ts";
import { OPENS } from "./atlasNavigation.ts";
import { focusLost, type OutlinePlace } from "./atlasPlace.ts";
import { summaryNote } from "./atlasStates.ts";
import type { Load } from "./territory.ts";

export const KIND_LABEL: Record<string, string> = {
  capability: "Capability",
  area: "Area",
  group: "Group",
  component: "Component",
  directory: "Folder",
  file: "File",
  symbol: "Symbol",
  concept: "Concept",
  package: "Package",
  repository: "Repository",
  "composite-capability": "Capability across repositories",
};

/** Whether the outline can open it: regions, and files that define symbols. */
export function opensInOutline(entity: AtlasEntitySummary): boolean {
  return OPENS.has(entity.kind) || (entity.kind === "file" && (entity.counts.symbols ?? 0) > 0);
}

export type OutlineRow =
  | {
      kind: "entity";
      key: string;
      entity: AtlasEntitySummary;
      level: number;
      parent: string | null;
      posinset: number;
      setsize: number;
      expandable: boolean;
      expanded: boolean;
    }
  | { kind: "loading" | "error" | "more"; key: string; parent: string | null; level: number };

/** The rows a tree shows: roots, and the loaded children of every expanded entity, depth first. */
export function outlineRows(
  roots: readonly AtlasEntitySummary[],
  rootsMore: boolean,
  expanded: ReadonlySet<string>,
  loads: ReadonlyMap<string, Load>,
): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (
    items: readonly AtlasEntitySummary[],
    level: number,
    parent: string | null,
    more: boolean,
  ) => {
    items.forEach((entity, i) => {
      const expandable = opensInOutline(entity);
      const open = expandable && expanded.has(entity.id);
      rows.push({
        kind: "entity",
        key: entity.id,
        entity,
        level,
        parent,
        posinset: i + 1,
        setsize: items.length,
        expandable,
        expanded: open,
      });
      if (!open) return;
      const load = loads.get(entity.id);
      if (!load || load.state === "loading")
        rows.push({
          kind: "loading",
          key: `${entity.id}\0loading`,
          parent: entity.id,
          level: level + 1,
        });
      else if (load.state === "error")
        rows.push({
          kind: "error",
          key: `${entity.id}\0error`,
          parent: entity.id,
          level: level + 1,
        });
      else walk(load.items, level + 1, entity.id, load.next !== null);
    });
    if (more) rows.push({ kind: "more", key: `${parent ?? ""}\0more`, parent, level });
  };
  walk(roots, 1, null, rootsMore);
  return rows;
}

const files = (n: number | undefined) =>
  n === undefined ? null : `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;

/** What a row says besides its name: kind, size, and states in words. */
export function rowDetail(entity: AtlasEntitySummary, seq: number): string {
  const parts = [entity.structural ? "Structural group" : (KIND_LABEL[entity.kind] ?? entity.kind)];
  const region = entity as Partial<AtlasRegion>;
  if (entity.structural && region.size)
    parts.push(
      `${region.size.members.toLocaleString()} item${region.size.members === 1 ? "" : "s"}`,
    );
  else if (files(entity.counts.files)) parts.push(files(entity.counts.files)!);
  else if (entity.kind === "file" && entity.counts.symbols)
    parts.push(`${entity.counts.symbols} symbol${entity.counts.symbols === 1 ? "" : "s"}`);
  if (seq > 1 && entity.since === seq) parts.push("changed in this build");
  return parts.join(" · ");
}

/** A region's summary, or why there isn't a current one (atlasStates' words). */
export function rowSummary(entity: AtlasEntitySummary): string | null {
  return entity.summary || summaryNote(entity.summaryState);
}

export function AtlasOutline({
  treeRef,
  label,
  roots,
  rootsMore,
  rootsCount,
  rootsState,
  loads,
  selected,
  path,
  seq,
  note,
  arrival,
  placeRef,
  onOpen,
  onRetry,
  onMore,
  onMoreRoots,
  onSelect,
}: {
  /** The tree element, so the page can return focus to it. */
  treeRef?: RefObject<HTMLDivElement | null>;
  label: string;
  roots: readonly AtlasEntitySummary[];
  /** More top-level regions can be loaded. */
  rootsMore: boolean;
  /** Top-level regions in all. */
  rootsCount: number;
  /** Loading the next page of top-level regions, or it failed. */
  rootsState: "loading" | "error" | null;
  loads: ReadonlyMap<string, Load>;
  selected: string | null;
  /** The selection's ancestors (and itself): opened so it's in view. */
  path: readonly string[];
  /** The snapshot sequence an entity was read at (per repository in a workspace). */
  seq: number | ((entity: AtlasEntitySummary) => number);
  /** More to say on a row, e.g. which repository it's in. */
  note?: (entity: AtlasEntitySummary) => string | null;
  /**
   * Where the reader was in the outline this one replaces (a build landed
   * under them, CORE-187): the same entries open, and focus back on the
   * same row if it had it.
   */
  arrival?: () => OutlinePlace | null;
  /** Kept up to date with what's open and current, for the next arrival. */
  placeRef?: RefObject<OutlinePlace | null>;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  onMore: (id: string) => void;
  onMoreRoots: () => void;
  onSelect: (entity: AtlasEntitySummary) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(path));
  const pathKey = path.join("\n");
  useEffect(() => {
    if (!pathKey) return;
    setExpanded((current) => {
      const ids = pathKey.split("\n").filter((id) => !current.has(id));
      return ids.length ? new Set([...current, ...ids]) : current;
    });
  }, [pathKey]);

  const rows = useMemo(
    () => outlineRows(roots, rootsMore, expanded, loads),
    [roots, rootsMore, expanded, loads],
  );
  const [active, setActive] = useState<string | null>(null);
  const current =
    (active && rows.some((r) => r.key === active) ? active : null) ??
    (selected && rows.some((r) => r.key === selected) ? selected : null) ??
    rows[0]?.key ??
    null;
  const own = useRef<HTMLDivElement>(null);
  const tree = treeRef ?? own;
  const refs = useRef(new Map<string, HTMLDivElement>());
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current || !current) return;
    moved.current = false;
    refs.current.get(current)?.focus();
  }, [current]);
  // A focused row can go away under the keyboard: "Loading…" becomes the
  // children, "Show more" becomes the next items. Focus then moves to what
  // took its place rather than falling out of the tree.
  const focusedKey = useRef<string | null>(null);
  const focusedAt = useRef(0);
  useEffect(() => {
    const key = focusedKey.current;
    if (!key || rows.some((r) => r.key === key)) return;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!lost || !rows.length) return;
    const next = rows[Math.min(focusedAt.current, rows.length - 1)]!;
    focusedKey.current = next.key;
    setActive(next.key);
    moved.current = true;
    refs.current.get(next.key)?.focus();
  }, [rows]);
  // Arriving where another outline was: open again what it had open, read
  // from this snapshot, and come back to the row that had focus once the way
  // to it has loaded (if it's gone, to the tree's current row, never to the
  // page).
  const returning = useRef<OutlinePlace | null>(null);
  const arrived = useRef<OutlinePlace | null | undefined>(undefined);
  useLayoutEffect(() => {
    // Read once (development's StrictMode runs this twice on mounting, and
    // the place has moved on by the second time); open on every run, since
    // a remount drops what was in flight.
    if (arrived.current === undefined) {
      const back = (arrived.current = arrival?.() ?? null);
      if (!back) return;
      setExpanded((now) => new Set([...now, ...back.expanded]));
      setActive(back.active);
      if (back.focused && back.active) returning.current = back;
    }
    for (const id of arrived.current?.expanded ?? []) onOpen(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on arriving only
  }, []);
  // Meanwhile focus waits on the nearest row on the way there.
  const waiting = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const back = returning.current;
    if (!back?.active) return;
    const ours = () => focusLost() || document.activeElement === waiting.current;
    const row = refs.current.get(back.active);
    const opening =
      !back.expanded.every((id) => expanded.has(id)) || rows.some((r) => r.kind === "loading");
    if (!row && opening) {
      const near = [...back.trail].reverse().flatMap((key) => refs.current.get(key) ?? []);
      if (focusLost() && near[0]) {
        waiting.current = near[0];
        near[0].focus();
      }
      return;
    }
    returning.current = null;
    if (ours()) (row ?? (current ? refs.current.get(current) : undefined))?.focus();
    waiting.current = null;
  }, [rows, current, expanded]);
  useEffect(() => {
    if (!placeRef) return;
    const parents = new Map(rows.map((r) => [r.key, r.parent]));
    const trail: string[] = [];
    for (let key = current && parents.get(current); key; key = parents.get(key)) trail.unshift(key);
    placeRef.current = { expanded: [...expanded], active: current, trail, focused: false };
  });
  const go = (key: string | undefined) => {
    if (!key) return;
    setActive(key);
    // Focus follows at once when the row is there; otherwise once it renders.
    const row = refs.current.get(key);
    if (row) row.focus();
    else moved.current = true;
  };

  const toggle = (entity: AtlasEntitySummary, open: boolean) => {
    setExpanded((now) => {
      const next = new Set(now);
      if (open) next.add(entity.id);
      else next.delete(entity.id);
      return next;
    });
    if (open) onOpen(entity.id);
  };
  const activate = (row: OutlineRow) => {
    if (row.kind === "entity") onSelect(row.entity);
    else if (row.kind === "more") {
      if (row.parent) onMore(row.parent);
      else onMoreRoots();
    } else if (row.kind === "error" && row.parent) onRetry(row.parent);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex((r) => r.key === current);
    const row = rows[i];
    if (!row) return;
    switch (event.key) {
      case "ArrowDown":
        go(rows[i + 1]?.key);
        break;
      case "ArrowUp":
        go(rows[i - 1]?.key);
        break;
      case "Home":
        go(rows[0]?.key);
        break;
      case "End":
        go(rows.at(-1)?.key);
        break;
      case "ArrowRight":
        if (row.kind !== "entity" || !row.expandable) break;
        if (!row.expanded) toggle(row.entity, true);
        else go(rows[i + 1]?.key);
        break;
      case "ArrowLeft":
        if (row.kind === "entity" && row.expanded) toggle(row.entity, false);
        else if (row.parent) go(row.parent);
        break;
      case "Enter":
      case " ":
        activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={tree}
      role="tree"
      aria-label={label}
      className="flex flex-col"
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Focus left for somewhere else on the page: nothing to restore.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node))
          focusedKey.current = null;
      }}
    >
      {rows.map((row) => {
        const indent = { paddingLeft: `${(row.level - 1) * 1}rem` };
        const common = {
          ref: (el: HTMLDivElement | null) => {
            if (el) refs.current.set(row.key, el);
            else refs.current.delete(row.key);
          },
          role: "treeitem" as const,
          "aria-level": row.level,
          tabIndex: row.key === current ? 0 : -1,
          onFocus: () => {
            setActive(row.key);
            focusedKey.current = row.key;
            focusedAt.current = rows.indexOf(row);
          },
          style: indent,
        };
        if (row.kind !== "entity") {
          const load = row.parent ? loads.get(row.parent) : undefined;
          const text =
            row.kind === "loading"
              ? "Loading…"
              : row.kind === "error"
                ? "Couldn't load this. Press Enter to retry."
                : !row.parent && rootsState === "loading"
                  ? "Loading more regions…"
                  : !row.parent && rootsState === "error"
                    ? "Couldn't load more regions. Press Enter to retry."
                    : row.parent
                      ? load?.state === "ready"
                        ? `Show more (${load.items.length.toLocaleString()}${load.total !== null ? ` of ${load.total.toLocaleString()}` : ""} shown)`
                        : "Show more"
                      : `Show more regions (${roots.length.toLocaleString()} of ${rootsCount.toLocaleString()} shown)`;
          return (
            <div
              key={row.key}
              {...common}
              aria-busy={row.kind === "loading" || undefined}
              onClick={() => activate(row)}
              className={`flex min-h-9 cursor-pointer items-center rounded-plate px-2 text-body-sm pointer-coarse:min-h-11 ${
                row.kind === "error" ? "text-danger-text" : "text-ink-faint"
              } hover:bg-raised`}
            >
              <span className="ml-7">{text}</span>
            </div>
          );
        }
        const { entity } = row;
        return (
          <div
            key={row.key}
            {...common}
            aria-selected={entity.id === selected}
            aria-expanded={row.expandable ? row.expanded : undefined}
            aria-setsize={row.setsize}
            aria-posinset={row.posinset}
            onClick={() => {
              setActive(row.key);
              onSelect(entity);
            }}
            className="flex min-h-9 cursor-pointer items-start gap-1 rounded-plate px-2 py-1 text-left hover:bg-raised aria-selected:bg-signal-wash pointer-coarse:min-h-11"
          >
            {row.expandable ? (
              <span
                aria-hidden
                className="grid size-6 shrink-0 place-items-center rounded-plate text-ink-faint hover:bg-pane pointer-coarse:size-9"
                onClick={(event) => {
                  event.stopPropagation();
                  setActive(row.key);
                  toggle(entity, !row.expanded);
                }}
              >
                {row.expanded ? <CaretDownIcon /> : <CaretRightIcon />}
              </span>
            ) : (
              <span aria-hidden className="size-6 shrink-0 pointer-coarse:size-9" />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                className={`break-words text-body-sm ${entity.structural ? "text-ink-muted" : "font-semibold text-ink"}`}
              >
                {entity.name}
              </span>
              <span className="text-micro text-ink-faint">
                {[rowDetail(entity, typeof seq === "number" ? seq : seq(entity)), note?.(entity)]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {row.level === 1 && rowSummary(entity) && (
                <span className="line-clamp-2 text-micro text-ink-muted">{rowSummary(entity)}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
