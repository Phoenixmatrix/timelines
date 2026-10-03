// The Atlas across an explicit workspace scope (CORE-172): the selection in
// the URL, the map's per-repository layout, and the loading session that
// keeps what's on screen inside the scope it was read for.
//
// Selection. `?repos=a,b` names repositories under the page's account, in the
// order they were picked. It is the only state: no subscription is created,
// and nothing here starts or enables a Knowledge build. The server
// re-authorizes it on every request (worker/atlas/workspace.ts) and silently
// keeps only what the viewer can read now.
//
// Layout. Every repository with an Atlas gets its own column ("band"), in
// selection order, each a fixed TOP_WIDTH cells wide. Inside its band a
// repository's regions sit in their own stable slots (buildTerritory,
// CORE-165), exactly as on its repository map, so slot numbers that two
// repositories share never collide. A band's position depends only on the
// ready repositories selected before it: a repository growing or shrinking
// never moves another, losing access mid-view leaves an empty band in place,
// and picking one more appends a band without moving anything. Removing one
// (or one becoming ready between visits) shifts the bands after it sideways as
// a whole; nothing inside them moves. Repositories without an Atlas get no
// band, only their row in the coverage list, so the map isn't shrunk by empty
// columns. Columns rather than stacked rows because a band's height follows
// its own content, and stacking would let one repository's growth push the
// others.
//
// Session. One per scope (the page remounts it when the selection or account
// changes, so nothing from the previous scope survives the switch). It drops
// any answer that arrives after it was disposed, and when a pinned request
// says the authorized set changed (revocation mid-view), it re-reads the
// scope and discards everything from repositories the viewer can no longer
// read before showing anything else.

import {
  ATLAS_WORKSPACE_MAX_REPOS,
  type AtlasCompositionCoverage,
  type AtlasEntitySummary,
  type AtlasRegion,
  type AtlasWorkspaceComposition,
  type AtlasWorkspaceOverview,
  type AtlasWorkspacePage,
  type AtlasWorkspaceRepo,
} from "../../../shared/atlas.ts";
import { ApiError } from "../../lib/api.ts";
import type { AtlasPageRequest, AtlasRequest, AtlasWorkspace } from "../../lib/atlas.ts";
import {
  buildTerritory,
  CELL,
  ChildLoader,
  GAP,
  TOP_WIDTH,
  type Expanded,
  type Load,
  type Territory,
  type TerritoryCell,
} from "../repo/territory.ts";

// ---- selection -------------------------------------------------------------------

/** A repository name, as worker/api/repos.ts allows them. */
const NAME = /^(?!\.)[A-Za-z0-9._-]{1,100}$/;

/**
 * The selected repository names from `?repos=`, in selection order, without
 * duplicates. `owner/name` under this owner counts as `name`; anything else
 * that isn't a repository name is dropped.
 */
export function parseSelection(raw: string | null | undefined, owner: string): string[] {
  const names: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    let entry = part.trim();
    if (entry.startsWith(`${owner}/`)) entry = entry.slice(owner.length + 1);
    if (NAME.test(entry) && !names.includes(entry)) names.push(entry);
    if (names.length === ATLAS_WORKSPACE_MAX_REPOS) break;
  }
  return names;
}

/** Add a repository at the end of the selection, or take it out. */
export function toggleSelection(selection: readonly string[], name: string): string[] {
  return selection.includes(name)
    ? selection.filter((n) => n !== name)
    : selection.length < ATLAS_WORKSPACE_MAX_REPOS
      ? [...selection, name]
      : [...selection];
}

/** The search string for a selection: `?repos=a,b`, or "" when empty. */
export function selectionSearch(selection: readonly string[]): string {
  return selection.length ? `?repos=${selection.map(encodeURIComponent).join(",")}` : "";
}

/** What a view is about: another key is another scope, with nothing carried over. */
export const scopeKey = (owner: string, selection: readonly string[]) =>
  `${owner}\n${selection.join(",")}`;

// ---- what each selected repository is in this view --------------------------------

export type Coverage =
  /** A published Atlas, read at its own commit. */
  | { name: string; state: "ready"; repo: AtlasWorkspaceRepo }
  /** Readable, but no Atlas to read: building, unavailable or not enabled. */
  | { name: string; state: "building" | "unavailable" | "not-enabled"; repo: AtlasWorkspaceRepo }
  /** Not in the response: it doesn't exist or the viewer can't read it (indistinguishable). */
  | { name: string; state: "denied"; repo: null }
  /** Readable when the view opened; access went away while it was open. */
  | { name: string; state: "revoked"; repo: null };

/** Every selected name, in selection order, with what this view knows of it. */
export function coverageOf(
  selection: readonly string[],
  repos: readonly AtlasWorkspaceRepo[],
  revoked: ReadonlySet<string> = new Set(),
): Coverage[] {
  return selection.map((name): Coverage => {
    if (revoked.has(name)) return { name, state: "revoked", repo: null };
    const repo = repos.find((r) => r.name === name);
    if (!repo) return { name, state: "denied", repo: null };
    return repo.state === "ready"
      ? { name, state: "ready", repo }
      : { name, state: repo.state, repo };
  });
}

// ---- layout ------------------------------------------------------------------------

/** World units around and above a repository's own territory, and between bands. */
export const BAND_PAD = GAP;
export const BAND_HEADER = 120;
export const BAND_GUTTER = CELL / 2;
/** A band is always this wide: its repository's grid width plus padding. */
export const BAND_WIDTH = TOP_WIDTH * (CELL + GAP) - GAP + BAND_PAD * 2;
/** The territory height a band with nothing to draw keeps. */
const EMPTY_HEIGHT = CELL / 2;

export interface Band {
  /** The selected name: a ready repository, or one whose access went away mid-view. */
  name: string;
  repoId: string | null;
  coverage: Coverage;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WorkspaceTerritory extends Territory {
  bands: Band[];
}

/**
 * The map for a workspace: one band per selected repository, in selection
 * order, each holding only its own regions (ids `<repoId>/<id>`) laid out by
 * buildTerritory from their own slots, then shifted into the band.
 */
export function buildWorkspaceTerritory(
  coverage: readonly Coverage[],
  regions: readonly AtlasRegion[],
  expanded: Expanded,
): WorkspaceTerritory {
  const cells: TerritoryCell[] = [];
  const byId = new Map<string, TerritoryCell>();
  const bands: Band[] = [];
  let height = 0;
  const drawn = coverage.filter((c) => c.state === "ready" || c.state === "revoked");
  drawn.forEach((entry, index) => {
    const x = index * (BAND_WIDTH + BAND_GUTTER);
    const repo = entry.state === "ready" ? entry.repo : null;
    const own = repo ? regions.filter((r) => r.repoId === repo.id) : [];
    const local = buildTerritory(own, expanded, repo?.snapshot?.seq ?? 0);
    const dx = x + BAND_PAD;
    const dy = BAND_HEADER;
    for (const cell of local.cells) {
      const moved = { ...cell, x: cell.x + dx, y: cell.y + dy };
      cells.push(moved);
      byId.set(moved.id, moved);
    }
    const h = BAND_HEADER + (local.cells.length ? local.height : EMPTY_HEIGHT) + BAND_PAD;
    bands.push({
      name: entry.name,
      repoId: entry.repo?.id ?? null,
      coverage: entry,
      x,
      y: 0,
      w: BAND_WIDTH,
      h,
    });
    height = Math.max(height, h);
  });
  const width = bands.length ? bands.length * (BAND_WIDTH + BAND_GUTTER) - BAND_GUTTER : 0;
  return { cells, byId, width, height, bands };
}

/** The repository id a namespaced workspace id belongs to. */
export const repoOf = (id: string) => id.slice(0, Math.max(0, id.indexOf("/")));

// ---- the session -------------------------------------------------------------------

export interface WorkspaceClient {
  overview(workspace: AtlasWorkspace, request: AtlasRequest): Promise<AtlasWorkspaceOverview>;
  children(
    workspace: AtlasWorkspace,
    id: string,
    request: AtlasPageRequest,
  ): Promise<AtlasWorkspacePage<AtlasEntitySummary>>;
  composition(
    workspace: AtlasWorkspace,
    request: AtlasPageRequest,
  ): Promise<AtlasWorkspaceComposition>;
}

/**
 * What cross-repository composition (CORE-167) could read from each selected
 * repository, at the overview's composite: whether its published packages are
 * recorded (only then can another repository's imports resolve to it).
 */
export type CompositionView =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      coverage: AtlasCompositionCoverage[];
      /** Capabilities spanning repositories, and resolved dependencies; null once access changed. */
      composites: number | null;
      resolved: number | null;
    };

export type Notice =
  /** Access changed while the view was open; `lost` names what was removed. */
  | { kind: "access"; lost: string[] }
  /** The pinned view can't continue (expired, or the scope changed underneath it). */
  | { kind: "restart"; message: string };

export interface WorkspaceState {
  status: "loading" | "ready" | "empty" | "error";
  error: string | null;
  /** What's on screen: never anything from a repository in `revoked`. */
  overview: AtlasWorkspaceOverview | null;
  loads: ReadonlyMap<string, Load>;
  /** Names of repositories whose content was discarded after access went away. */
  revoked: ReadonlySet<string>;
  notice: Notice | null;
  /** Null until the overview is read. */
  composition: CompositionView | null;
}

export const initialWorkspaceState: WorkspaceState = {
  status: "loading",
  error: null,
  overview: null,
  loads: new Map(),
  revoked: new Set(),
  notice: null,
  composition: null,
};

/** The pinned composite no longer matches what the viewer may read: re-read the scope. */
const RECHECK = new Set(["snapshot_unknown", "cursor_invalid", "scope_empty"]);
/** The pinned view expired: say so, and offer the current one. */
const EXPIRED = new Set(["snapshot_expired", "cursor_expired"]);

/** Child pages per request: the API's maximum. */
const PAGE = 100;

/**
 * Loads one workspace scope: its overview, then children of what someone
 * opens, pinned to the overview's composite snapshot. A disposed session
 * reports nothing more, so a late answer never reaches another scope's view.
 */
export class WorkspaceSession {
  readonly #workspace: AtlasWorkspace;
  readonly #client: WorkspaceClient;
  readonly #onChange: (state: WorkspaceState) => void;
  #state: WorkspaceState = initialWorkspaceState;
  #disposed = false;
  #opening: AbortController | null = null;
  #checking: AbortController | null = null;
  #children: ChildLoader | null = null;

  constructor(
    workspace: AtlasWorkspace,
    client: WorkspaceClient,
    onChange: (state: WorkspaceState) => void,
  ) {
    this.#workspace = workspace;
    this.#client = client;
    this.#onChange = onChange;
  }

  get state(): WorkspaceState {
    return this.#state;
  }

  #set(next: Partial<WorkspaceState>) {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...next };
    this.#onChange(this.#state);
  }

  /** Read the scope's current composite (again, for "open the current view"). */
  async open() {
    if (this.#disposed) return;
    this.#opening?.abort();
    this.#checking?.abort();
    this.#checking = null;
    this.#children?.reset("");
    this.#children = null;
    const controller = new AbortController();
    this.#opening = controller;
    this.#set({ ...initialWorkspaceState });
    try {
      const overview = await this.#client.overview(this.#workspace, { signal: controller.signal });
      if (this.#disposed || controller.signal.aborted) return;
      this.#children = new ChildLoader(
        overview.snapshot.id,
        (id, cursor, signal) => this.#page(overview.snapshot.id, id, cursor, signal),
        (id, load) => {
          if (this.#disposed || this.#state.overview?.snapshot.id !== overview.snapshot.id) return;
          if (!this.#readable(repoOf(id))) return;
          this.#set({ loads: new Map(this.#state.loads).set(id, load) });
        },
      );
      this.#set({ status: "ready", overview, composition: { status: "loading" } });
      void this.#compose(overview, controller.signal);
    } catch (error) {
      if (this.#disposed || controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === "scope_empty")
        this.#set({ status: "empty", error: error.message });
      else
        this.#set({
          status: "error",
          error: error instanceof Error ? error.message : "Couldn't open this Atlas.",
        });
    }
  }

  /** Composition coverage, pinned to the overview's composite so both describe the same vector. */
  async #compose(overview: AtlasWorkspaceOverview, signal: AbortSignal) {
    try {
      const page = await this.#client.composition(this.#workspace, {
        snapshot: overview.snapshot.id,
        limit: 1,
        signal,
      });
      if (
        this.#disposed ||
        signal.aborted ||
        this.#state.overview?.snapshot.id !== overview.snapshot.id
      )
        return;
      const readable = new Set(this.#state.overview.snapshot.repos.map((r) => r.id));
      const changed = this.#state.revoked.size > 0;
      this.#set({
        composition: {
          status: "ready",
          coverage: page.coverage.filter((c) => readable.has(c.repoId)),
          composites: changed ? null : page.counts.knownTotal,
          resolved: changed ? null : page.resolved,
        },
      });
    } catch (error) {
      if (this.#disposed || signal.aborted) return;
      if (error instanceof ApiError && error.code && RECHECK.has(error.code)) void this.recheck();
      this.#set({
        composition: {
          status: "error",
          message: error instanceof Error ? error.message : "Couldn't read composition coverage.",
        },
      });
    }
  }

  async #page(snapshot: string, id: string, cursor: string | null, signal: AbortSignal) {
    try {
      const page = await this.#client.children(this.#workspace, id, {
        snapshot,
        cursor,
        signal,
        limit: PAGE,
      });
      return { items: page.items, next: page.next, total: page.counts.knownTotal };
    } catch (error) {
      if (error instanceof ApiError && error.code) {
        if (RECHECK.has(error.code)) void this.recheck();
        else if (EXPIRED.has(error.code))
          this.#set({
            notice: {
              kind: "restart",
              message: "This view's snapshot has expired. Open the current one to continue.",
            },
          });
      }
      throw error;
    }
  }

  /** Whether a repository id's content may still be shown. */
  #readable(repoId: string): boolean {
    const repo = this.#state.overview?.snapshot.repos.find((r) => r.id === repoId);
    return !!repo && !this.#state.revoked.has(repo.name);
  }

  /** Load (or continue) the children of something on the map. */
  expand(id: string, cursor: string | null = null, previous: AtlasEntitySummary[] = []) {
    if (this.#disposed || !this.#children || !this.#readable(repoOf(id))) return;
    void this.#children.load(id, cursor, previous);
  }

  /**
   * A pinned request said the authorized set changed: re-read the scope's
   * repositories and discard everything from those no longer readable. What
   * remains stays (it was read under the viewer's access to it), pinned to a
   * composite that can't continue, so the notice offers the current one.
   */
  async recheck() {
    if (this.#disposed || this.#checking || !this.#state.overview) return;
    const controller = new AbortController();
    this.#checking = controller;
    const before = this.#state.overview.snapshot.repos.map((r) => r.name);
    try {
      const current = await this.#client.overview(this.#workspace, { signal: controller.signal });
      if (this.#disposed || controller.signal.aborted) return;
      const now = new Set(current.snapshot.repos.map((r) => r.name));
      const lost = before.filter((name) => !now.has(name));
      this.revoke(lost);
      this.#set({
        notice: lost.length
          ? { kind: "access", lost }
          : {
              kind: "restart",
              message:
                "This selection's Atlas changed since you opened it. Open the current one to continue.",
            },
      });
    } catch (error) {
      if (this.#disposed || controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === "scope_empty") {
        this.revoke(before);
        this.#set({ notice: { kind: "access", lost: before } });
      } else
        this.#set({
          notice: {
            kind: "restart",
            message: "Couldn't check this view against your current access. Open the current one.",
          },
        });
    } finally {
      if (this.#checking === controller) this.#checking = null;
    }
  }

  /** Discard everything read from these repositories (by name), now. */
  revoke(names: readonly string[]) {
    const overview = this.#state.overview;
    if (!overview || !names.length) return;
    const gone = new Set(names);
    const ids = new Set(overview.snapshot.repos.filter((r) => gone.has(r.name)).map((r) => r.id));
    const keep = (item: { repoId?: string }) => !ids.has(item.repoId ?? "");
    const loads = new Map([...this.#state.loads].filter(([id]) => !ids.has(repoOf(id))));
    // Children of a remaining region can't come from another repository, but
    // filter them anyway: nothing of a revoked repository stays.
    for (const [id, load] of loads)
      if (load.state === "ready" && load.items.some((item) => !keep(item)))
        loads.set(id, { ...load, items: load.items.filter(keep) });
    const regions = overview.regions.filter(keep);
    const catalogue = overview.catalogue.items.filter(keep);
    const composition = this.#state.composition;
    this.#set({
      // Totals counted the revoked repositories: keep only per-repository rows.
      composition:
        composition?.status === "ready"
          ? {
              status: "ready",
              coverage: composition.coverage.filter((c) => !ids.has(c.repoId)),
              composites: null,
              resolved: null,
            }
          : composition,
      overview: {
        ...overview,
        regions,
        // Totals included the revoked repositories: show only what's left, and
        // don't continue a catalogue whose cursor belongs to the old scope.
        totalRegions: regions.length + catalogue.length,
        catalogue: {
          ...overview.catalogue,
          snapshot: {
            ...overview.catalogue.snapshot,
            repos: overview.catalogue.snapshot.repos.filter((r) => !gone.has(r.name)),
          },
          items: catalogue,
          next: null,
          counts: { loaded: catalogue.length, knownTotal: null, unknownTotal: true },
        },
        snapshot: {
          ...overview.snapshot,
          repos: overview.snapshot.repos.filter((r) => !gone.has(r.name)),
        },
      },
      loads,
      revoked: new Set([...this.#state.revoked, ...names]),
    });
  }

  /** The scope changed or the page left: abort everything, report nothing more. */
  dispose() {
    this.#disposed = true;
    this.#opening?.abort();
    this.#checking?.abort();
    this.#children?.reset("");
  }
}
