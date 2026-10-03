// How the repository Atlas reaches an entity (CORE-171) without loading
// anything it doesn't need:
//
// - FocusResolver: a selection the map already draws is shown as it is. One
//   it doesn't (a cold link, Back/Forward, a lookup result or a neighbour in
//   the lens) is resolved by one `ancestors` read, and the path to it is
//   opened a level at a time with each ancestor's children page: never the
//   whole graph, never unrelated regions.
// - CatalogueLookup: find-as-you-type over the snapshot's materialized
//   catalogue (`/atlas/catalogue`, a D1 lookup). It never reaches a model,
//   an embedding index or AI Search, and only ever this one repository; code
//   and wiki search is a separate, explicit handoff to the palette.
//
// Both drop late answers: only the newest request's answer is ever shown.

import type {
  AtlasAncestors,
  AtlasEntitySummary,
  AtlasError,
  AtlasPage,
} from "../../../shared/atlas.ts";
import { atlasErrorOf, atlasNeedsRestart } from "../../lib/atlas.ts";

/** Regions and entities that hold others, and so can be opened. */
export const OPENS: ReadonlySet<string> = new Set([
  "capability",
  "area",
  "group",
  "component",
  "directory",
  "repository",
]);

export type Focus =
  | { state: "none" }
  | { state: "resolving"; id: string }
  | {
      state: "ready";
      id: string;
      entity: AtlasEntitySummary;
      /** Root first, parent last; null when it was already on the map. */
      ancestors: AtlasEntitySummary[] | null;
    }
  /** Not in this snapshot; `error.lineage` says where a retired capability went. */
  | { state: "missing"; id: string; error: AtlasError }
  /** The pinned snapshot can't be read any more: offer the current one, explicitly. */
  | { state: "restart"; id: string; error: AtlasError }
  | { state: "error"; id: string; message: string };

/** The ids to open so `entity` is drawn: its ancestors below the root, then itself if it holds others. */
export function pathToOpen(entity: AtlasEntitySummary, ancestors: AtlasEntitySummary[]): string[] {
  const path = ancestors.filter((a) => a.parentId !== null).map((a) => a.id);
  if (OPENS.has(entity.kind)) path.push(entity.id);
  return path;
}

export class FocusResolver {
  #generation = 0;
  #controller: AbortController | null = null;
  readonly #fetchAncestors: (id: string, signal: AbortSignal) => Promise<AtlasAncestors>;
  readonly #open: (id: string) => void;
  readonly #onChange: (focus: Focus) => void;

  constructor(
    fetchAncestors: (id: string, signal: AbortSignal) => Promise<AtlasAncestors>,
    /** Load a region's children (a no-op when they're loaded or loading). */
    open: (id: string) => void,
    onChange: (focus: Focus) => void,
  ) {
    this.#fetchAncestors = fetchAncestors;
    this.#open = open;
    this.#onChange = onChange;
  }

  /**
   * Show `id`. `drawn` is its summary when the map already has it, so its
   * parent is open and nothing but its own children needs reading.
   */
  async focus(id: string | null, drawn?: AtlasEntitySummary): Promise<void> {
    const generation = ++this.#generation;
    this.#controller?.abort();
    this.#controller = null;
    if (!id) {
      this.#onChange({ state: "none" });
      return;
    }
    if (drawn) {
      this.#onChange({ state: "ready", id, entity: drawn, ancestors: null });
      if (OPENS.has(drawn.kind)) this.#open(id);
      return;
    }
    const controller = new AbortController();
    this.#controller = controller;
    this.#onChange({ state: "resolving", id });
    try {
      const chain = await this.#fetchAncestors(id, controller.signal);
      if (generation !== this.#generation) return;
      this.#onChange({ state: "ready", id, entity: chain.entity, ancestors: chain.ancestors });
      for (const step of pathToOpen(chain.entity, chain.ancestors)) this.#open(step);
    } catch (error) {
      if (generation !== this.#generation || controller.signal.aborted) return;
      const atlasError = atlasErrorOf(error);
      if (atlasError && atlasNeedsRestart(error))
        this.#onChange({ state: "restart", id, error: atlasError });
      else if (atlasError?.code === "entity_unknown")
        this.#onChange({ state: "missing", id, error: atlasError });
      else
        this.#onChange({
          state: "error",
          id,
          message: error instanceof Error ? error.message : "Couldn't find it.",
        });
    }
  }

  dispose() {
    this.#generation++;
    this.#controller?.abort();
    this.#controller = null;
  }
}

// ---- catalogue lookup ------------------------------------------------------------

export type LookupState =
  | { status: "idle" }
  | { status: "loading"; q: string; kind: string | null }
  | {
      status: "done";
      q: string;
      kind: string | null;
      items: AtlasEntitySummary[];
      counts: AtlasPage<AtlasEntitySummary>["counts"];
      next: string | null;
      /** A further page is loading. */
      more: boolean;
    }
  | {
      status: "failed";
      q: string;
      kind: string | null;
      message: string;
      /** Set when the pinned snapshot expired: offer the current one. */
      restart: AtlasError | null;
    };

export type LookupFetch = (
  q: string,
  kind: string | null,
  cursor: string | null,
  signal: AbortSignal,
) => Promise<AtlasPage<AtlasEntitySummary>>;

export const LOOKUP_DEBOUNCE_MS = 200;
export const LOOKUP_PAGE = 20;

export class CatalogueLookup {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | null = null;
  #key = "";
  #state: LookupState = { status: "idle" };
  readonly #fetch: LookupFetch;
  readonly #onState: (state: LookupState) => void;
  readonly #debounceMs: number;

  constructor(
    fetch: LookupFetch,
    onState: (state: LookupState) => void,
    debounceMs = LOOKUP_DEBOUNCE_MS,
  ) {
    this.#fetch = fetch;
    this.#onState = onState;
    this.#debounceMs = debounceMs;
  }

  #set(state: LookupState) {
    this.#state = state;
    this.#onState(state);
  }

  #cancel() {
    clearTimeout(this.#timer);
    this.#controller?.abort();
    this.#controller = null;
  }

  /** The latest text and kind filter; "" clears. Typing waits for a pause. */
  lookup(raw: string, kind: string | null, immediately = false) {
    const q = raw.trim().replace(/\s+/g, " ");
    const key = `${kind ?? ""}\n${q}`;
    if (key === this.#key) return;
    this.#key = key;
    this.#cancel();
    if (!q) {
      this.#set({ status: "idle" });
      return;
    }
    this.#set({ status: "loading", q, kind });
    const run = () => void this.#page(key, q, kind, null, []);
    if (immediately) run();
    else this.#timer = setTimeout(run, this.#debounceMs);
  }

  /** The next page of the current answer. */
  more() {
    const state = this.#state;
    if (state.status !== "done" || !state.next || state.more) return;
    this.#set({ ...state, more: true });
    void this.#page(this.#key, state.q, state.kind, state.next, state.items);
  }

  async #page(
    key: string,
    q: string,
    kind: string | null,
    cursor: string | null,
    previous: AtlasEntitySummary[],
  ) {
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const page = await this.#fetch(q, kind, cursor, controller.signal);
      if (key !== this.#key || controller.signal.aborted) return;
      this.#set({
        status: "done",
        q,
        kind,
        items: [...previous, ...page.items],
        counts: page.counts,
        next: page.next,
        more: false,
      });
    } catch (error) {
      if (key !== this.#key || controller.signal.aborted) return;
      this.#set({
        status: "failed",
        q,
        kind,
        message: error instanceof Error ? error.message : "The lookup failed.",
        restart: atlasNeedsRestart(error) ? atlasErrorOf(error) : null,
      });
    }
  }

  dispose() {
    this.#cancel();
    this.#key = "";
  }
}
