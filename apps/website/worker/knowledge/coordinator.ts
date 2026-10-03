// One coordinator per repository (a Durable Object) decides when to build.
//
// Every push pings it. It waits for a short quiet period, so an agent pushing
// five times in ten seconds causes one build rather than five, then starts a
// Workflow. While a build runs, further pushes only mark the repo dirty; when
// the build finishes, a dirty repo builds again right away with the latest
// HEAD. Per-file work is cached by content, so the follow-up build is cheap.
// At most one build per repository is ever in flight.
//
// The same pings keep timeline overlays current (overlay.ts, CORE-83): after
// the quiet period the coordinator lists the repository's `timeline/<slug>`
// bookmarks and starts an overlay for each whose tip, or main's indexed
// commit, moved since its last one: at most one per timeline in flight and a
// few per repository, and a push during one runs it again when it ends.
// Overlays never touch main's graph; a push that moved only timeline
// bookmarks starts no main build.

import { DurableObject } from "cloudflare:workers";
import { timelineSlugOf } from "../../shared/timelines.ts";
import { listRefs, type RepoRefs } from "../artifacts.ts";
import { db, nowIso } from "../schema.ts";
import {
  dropOverlays,
  overlayFailed,
  scanOverlays,
  type OverlayRun,
  type OverlayState,
} from "./overlay.ts";
import { watchdog } from "./watchdog.ts";

/** Quiet period after the last push before building. */
const DEBOUNCE_MS = 1_500;
/** …but never wait longer than this after the first push of a burst. */
const MAX_WAIT_MS = 8_000;
/** Check on a running build this often, in case it died without reporting. */
const WATCHDOG_MS = 60_000;
/** Retries of a build that crashed or hung, before giving up until the next push. */
const MAX_RETRIES = 1;
/** An overlay is a few steps; one running longer than this is stopped. */
const OVERLAY_MAX_MS = 2 * 60 * 60_000;

interface Running {
  buildId: string;
  /** The push sequence number the build covers. */
  seq: number;
  startedAt: number;
}

export interface CoordinatorStatus {
  running: (Running & { phase?: string }) | null;
  /** Pushes not yet covered by a finished or running build. */
  pending: boolean;
  lastError: string | null;
  lastFinishedAt: number | null;
  /** Per timeline bookmark (refs/heads/timeline/<slug>). */
  overlays: Record<string, { running: OverlayRun | null; lastError: string | null }>;
  /** Bookmarks not yet compared since the last push. */
  overlayScanPending: boolean;
}

interface State {
  repoId: string | null;
  seq: number;
  builtSeq: number;
  burstStartedAt: number | null;
  running: Running | null;
  force: boolean;
  retries: number;
  lastError: string | null;
  lastFinishedAt: number | null;
  /** Timeline bookmarks need comparing with their overlays. */
  scan: boolean;
  overlays: Record<string, OverlayState>;
}

const INITIAL: State = {
  repoId: null,
  seq: 0,
  builtSeq: 0,
  burstStartedAt: null,
  running: null,
  force: false,
  retries: 0,
  lastError: null,
  lastFinishedAt: null,
  scan: false,
  overlays: {},
};

export class KnowledgeCoordinator extends DurableObject<Env> {
  async #state(): Promise<State> {
    return { ...INITIAL, ...(await this.ctx.storage.get<State>("state")) };
  }

  async #save(state: State) {
    await this.ctx.storage.put("state", state);
  }

  /** Something changed in the repository (a push, a new repo, a manual rebuild). */
  async notify(repoId: string, options: { force?: boolean } = {}): Promise<void> {
    const state = await this.#state();
    const now = Date.now();
    state.repoId = repoId;
    state.seq += 1;
    state.force ||= Boolean(options.force);
    state.scan = true;
    state.burstStartedAt ??= now;
    await this.#save(state);
    // Even while a build runs: timeline overlays don't wait for main's build.
    const due = Math.min(now + DEBOUNCE_MS, state.burstStartedAt + MAX_WAIT_MS);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > due) await this.ctx.storage.setAlarm(due);
  }

  async alarm(): Promise<void> {
    // The alarm reads state, then waits on D1, the ref listing and Workflows
    // before saving it: a push arriving meanwhile must not be overwritten.
    await this.ctx.blockConcurrencyWhile(() => this.#alarm());
  }

  async #alarm(): Promise<void> {
    const state = await this.#state();
    if (!state.repoId) return;
    if (state.running) await this.#watchBuild(state);
    await this.#watchOverlays(state);
    const buildDue = !state.running && (state.seq > state.builtSeq || state.force);
    let refs: RepoRefs | null = null;
    let indexed: string | null = null;
    if (buildDue || state.scan) {
      const [repo, kgState] = await Promise.all([
        db(this.env.DB)
          .selectFrom("repos")
          .select(["artifacts_name", "artifacts_remote"])
          .where("id", "=", state.repoId)
          .executeTakeFirst(),
        db(this.env.DB)
          .selectFrom("kg_state")
          .select("indexed_commit")
          .where("repo_id", "=", state.repoId)
          .executeTakeFirst(),
      ]);
      indexed = kgState?.indexed_commit ?? null;
      refs = repo
        ? await listRefs(this.env, repo.artifacts_name, repo.artifacts_remote).catch((error) => {
            console.error("Knowledge: listing refs failed", { repo: state.repoId, error });
            return null;
          })
        : null;
      // A deleted repository has nothing left to compare.
      if (!repo) state.scan = false;
    }
    if (buildDue) {
      // Pushes that only moved other branches (timeline bookmarks) leave main as indexed.
      if (!state.force && refs?.head && refs.head === indexed) state.builtSeq = state.seq;
      else {
        const buildId = crypto.randomUUID();
        await this.env.KNOWLEDGE_BUILD.create({
          id: buildId,
          params: { repoId: state.repoId, buildId, force: state.force },
        });
        state.running = { buildId, seq: state.seq, startedAt: Date.now() };
        state.force = false;
      }
    }
    // Main's next build waits for its own run to end (finished() schedules it).
    state.burstStartedAt = null;
    // Without a ref listing the scan waits for the next ping.
    if (state.scan && refs) await this.#scanOverlays(state, refs, indexed);
    await this.#save(state);
    if (state.running || Object.values(state.overlays).some((o) => o.running))
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  /** Watchdog: a build that crashed without reporting must not block forever. */
  async #watchBuild(state: State) {
    const running = state.running!;
    const instance = await this.env.KNOWLEDGE_BUILD.get(running.buildId).catch(() => null);
    const status = instance ? await instance.status().catch(() => null) : null;
    const build = await db(this.env.DB)
      .selectFrom("kg_builds")
      .select("progress_at")
      .where("id", "=", running.buildId)
      .executeTakeFirst();
    const verdict = watchdog(Date.now(), running.startedAt, build?.progress_at ?? null);
    const stale = verdict !== "running";
    if (status?.status === "complete") {
      state.lastError = null;
      state.builtSeq = running.seq;
      state.running = null;
      state.scan = true;
    } else if (!status || stale || ["errored", "terminated"].includes(status.status)) {
      // Crashed, vanished or hung: stop it, and retry once before giving up.
      if (stale) await instance?.terminate().catch(() => undefined);
      await db(this.env.DB)
        .updateTable("kg_builds")
        .set({
          status: "failed",
          error: stale
            ? `Build ${verdict === "stalled" ? "stopped making progress" : "ran too long"}; stopped by the watchdog`
            : `Build ${status?.status ?? "vanished"}`,
          finished_at: nowIso(),
        })
        .where("id", "=", running.buildId)
        .where("status", "=", "running")
        .execute();
      const reason = stale ? "hung" : (status?.status ?? "vanished");
      state.lastError = `Build ${reason}${status?.error?.message ? `: ${status.error.message}` : ""}`;
      if (state.retries < MAX_RETRIES) {
        state.retries += 1;
        state.force = true;
      } else {
        state.builtSeq = running.seq;
        state.retries = 0;
      }
      state.running = null;
    }
  }

  /** The overlay watchdog: crashed, vanished or overdue overlays end, and retry once. */
  async #watchOverlays(state: State) {
    for (const [ref, overlay] of Object.entries(state.overlays)) {
      const run = overlay.running;
      if (!run) continue;
      const instance = await this.env.KNOWLEDGE_BUILD.get(run.buildId).catch(() => null);
      const status = instance ? await instance.status().catch(() => null) : null;
      const overdue = Date.now() - run.startedAt > OVERLAY_MAX_MS;
      if (status?.status === "complete") {
        this.#overlayEnded(state, overlay, { commit: run.commit, base: run.base }, null);
      } else if (!status || overdue || ["errored", "terminated"].includes(status.status)) {
        if (overdue) await instance?.terminate().catch(() => undefined);
        const error = `Overlay ${overdue ? "ran too long; stopped by the watchdog" : (status?.status ?? "vanished")}`;
        await overlayFailed(this.env.DB, state.repoId!, ref, run.commit, error).catch(
          () => undefined,
        );
        this.#overlayEnded(state, overlay, { commit: run.commit, base: run.base }, error);
      }
    }
  }

  #overlayEnded(
    state: State,
    overlay: OverlayState,
    covered: { commit: string; base: string | null },
    error: string | null,
  ) {
    overlay.running = null;
    overlay.lastError = error;
    // A failure is retried once (a cleared `done`), then left until the bookmark or main moves.
    if (error && overlay.retries < MAX_RETRIES) {
      overlay.retries += 1;
      overlay.done = null;
    } else {
      overlay.retries = 0;
      overlay.done = covered;
    }
    state.scan = true;
  }

  /** Start overlays for bookmarks whose tip or base moved; forget bookmarks that are gone. */
  async #scanOverlays(state: State, refs: RepoRefs, indexed: string | null) {
    const tips = new Map(
      refs.branches.filter((b) => timelineSlugOf(b.name)).map((b) => [b.name, b.oid]),
    );
    const scan = scanOverlays(state.overlays, tips, indexed);
    for (const ref of scan.gone) delete state.overlays[ref];
    await dropOverlays(this.env.DB, state.repoId!, scan.gone);
    // Over the limit: picked up when one of those in flight ends.
    state.scan = scan.deferred;
    for (const [ref, commit] of scan.start) {
      const buildId = crypto.randomUUID();
      await this.env.KNOWLEDGE_BUILD.create({
        id: buildId,
        params: { repoId: state.repoId!, buildId, overlay: { ref, commit } },
      });
      state.overlays[ref] = {
        ...(state.overlays[ref] ?? { done: null, retries: 0, lastError: null }),
        running: { buildId, commit, base: indexed!, startedAt: Date.now() },
      };
    }
  }

  /** Called by the Workflow when a build ends. */
  async finished(buildId: string, ok: boolean, error: string | null): Promise<void> {
    const state = await this.#state();
    if (state.running?.buildId !== buildId) return;
    state.builtSeq = state.running.seq;
    state.running = null;
    state.retries = 0;
    state.lastError = ok ? null : error;
    state.lastFinishedAt = Date.now();
    // Main's indexed commit moved: overlays are measured against it.
    if (ok) state.scan = true;
    await this.#save(state);
    // Pushes that arrived during the build: build again now, for the latest HEAD.
    if (state.seq > state.builtSeq || state.scan) await this.ctx.storage.setAlarm(Date.now() + 250);
    else if (!Object.values(state.overlays).some((o) => o.running))
      await this.ctx.storage.deleteAlarm();
  }

  /** Called by the Workflow when an overlay ends; `base` is main's commit it measured against. */
  async overlayFinished(
    ref: string,
    buildId: string,
    ok: boolean,
    error: string | null,
    base: string | null,
  ): Promise<void> {
    const state = await this.#state();
    const overlay = state.overlays[ref];
    if (overlay?.running?.buildId !== buildId) return;
    const covered = { commit: overlay.running.commit, base: ok ? base : overlay.running.base };
    this.#overlayEnded(state, overlay, covered, ok ? null : (error ?? "Overlay failed"));
    await this.#save(state);
    await this.ctx.storage.setAlarm(Date.now() + 250);
  }

  async status(): Promise<CoordinatorStatus> {
    const state = await this.#state();
    return {
      running: state.running,
      pending: state.seq > state.builtSeq && !state.running,
      lastError: state.lastError,
      lastFinishedAt: state.lastFinishedAt,
      overlays: Object.fromEntries(
        Object.entries(state.overlays).map(([ref, o]) => [
          ref,
          { running: o.running, lastError: o.lastError },
        ]),
      ),
      overlayScanPending: state.scan,
    };
  }
}

/** The coordinator for one repository. */
export function coordinator(env: Env, repoId: string): DurableObjectStub<KnowledgeCoordinator> {
  // The config names the class by string, so its binding type can't infer it.
  const namespace =
    env.KNOWLEDGE_COORDINATOR as unknown as DurableObjectNamespace<KnowledgeCoordinator>;
  return namespace.getByName(repoId);
}

/** Tell a repository's coordinator that something changed. */
export function notifyKnowledge(env: Env, repoId: string, options: { force?: boolean } = {}) {
  // Automatic non-AI agent environments omit provider bindings altogether.
  if (!env.AI) return Promise.resolve();
  return coordinator(env, repoId).notify(repoId, options);
}
