// One coordinator per repository (a Durable Object) decides when to build.
//
// Every push pings it. It waits for a short quiet period, so an agent pushing
// five times in ten seconds causes one build rather than five, then starts a
// Workflow. While a build runs, further pushes only mark the repo dirty; when
// the build finishes, a dirty repo builds again right away with the latest
// HEAD. Per-file work is cached by content, so the follow-up build is cheap.
// At most one build per repository is ever in flight.
//
// The same pings keep timeline overlays current: after the quiet period the
// coordinator scans owned ready work sources and starts overlays whose pinned
// work tip or canonical indexed commit moved. Each source has one job in flight.
// Logical timeline refs key scheduling and archived readers; they are never
// used to discover active work in the canonical repository.
//
// It also runs the queue of timeline wiki page sets (pages.ts, CORE-84): a
// checkpoint, or someone asking, queues a set in D1 and pings it; it starts
// the oldest queued sets, one per timeline and a couple per repository at a
// time, and watches them like overlays. Page sets never wait for pushes.

import { DurableObject } from "cloudflare:workers";
import { liveTimelineSources, timelineKnowledgeSource, knowledgeRepo } from "./sources.ts";
import { pinSourceRoot, releaseSourceRoots } from "../retention/work-sources.ts";
import { releaseKnowledgeBase } from "./source-reader.ts";
import { listRefs, type RepoRefs } from "../artifacts.ts";
import { productionOnly } from "../preview.ts";
import { db, nowIso } from "../schema.ts";
import type { KnowledgeOverlayEndReason } from "../../shared/api.ts";
import {
  endedOverlays,
  endOverlays,
  overlayFailed,
  reopenOverlay,
  scanOverlays,
  setEndReason,
  timelineEnd,
  type OverlayRun,
  type OverlayState,
} from "./overlay.ts";
import {
  abandonSet,
  claimSet,
  queuedSets,
  queueSet,
  schedulePages,
  type PageRequest,
  type PageRun,
} from "./pages.ts";
import type { Checkpoint } from "../../shared/timelines.ts";
import { watchdog } from "./watchdog.ts";
import { repoAiSnapshot } from "../settings/ai.ts";
import { knowledgePolicy, LEGACY_KNOWLEDGE_POLICY, type KnowledgePolicy } from "./policy.ts";
import {
  clearStorage,
  pendingRetirement,
  resetSoon,
  scheduleRetirement,
  settleRetirement,
  storageReport,
  type Purgeable,
  type PurgeReport,
  type Retirement,
} from "../durable/contract.ts";
import { durableStub } from "../durable/registry.ts";

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
/** A page set is a few model calls; one running longer than this is stopped. */
const PAGES_MAX_MS = 2 * 60 * 60_000;

const TERMINAL_WORKFLOW = new Set(["complete", "errored", "terminated"]);

/** An unavailable status or failed termination is not consumer completion. */
async function confirmedWorkflowEnd(env: Env, buildId: string, stop: boolean) {
  const instance = await env.KNOWLEDGE_BUILD.get(buildId);
  let status = await instance.status();
  if (TERMINAL_WORKFLOW.has(status.status)) return status;
  if (!stop) return null;
  await instance.terminate();
  status = await instance.status();
  return TERMINAL_WORKFLOW.has(status.status) ? status : null;
}

interface Running {
  buildId: string;
  /** The push sequence number the build covers. */
  seq: number;
  startedAt: number;
  policy?: KnowledgePolicy;
  force?: boolean;
  ai?: KnowledgePolicy["ai"];
  commit?: string;
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
  /** Timeline wiki page sets being written (CORE-84). */
  pages: PageRun[];
}

interface State {
  repoId: string | null;
  seq: number;
  builtSeq: number;
  burstStartedAt: number | null;
  running: Running | null;
  /** A watchdog continuation is separate from newer pending push signals. */
  retry?: Running;
  force: boolean;
  retries: number;
  lastError: string | null;
  lastFinishedAt: number | null;
  /** Timeline bookmarks need comparing with their overlays. */
  scan: boolean;
  overlays: Record<
    string,
    OverlayState & {
      policy?: KnowledgePolicy;
      retry?: { commit: string; base: string | null; sourceId?: string; policy: KnowledgePolicy };
    }
  >;
  /** Timeline wiki page sets being written, by build id. */
  pages: Record<string, PageRun>;
  /** Queued page sets may be waiting in D1. */
  pagesDue: boolean;
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
  pages: {},
  pagesDue: false,
};

export class KnowledgeCoordinator extends DurableObject<Env> implements Purgeable {
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
    state.pagesDue = true;
    state.burstStartedAt ??= now;
    await this.#save(state);
    // Even while a build runs: timeline overlays don't wait for main's build.
    const due = Math.min(now + DEBOUNCE_MS, state.burstStartedAt + MAX_WAIT_MS);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > due) await this.ctx.storage.setAlarm(due);
  }

  /** A timeline page set was queued in D1 (a checkpoint, or someone asked). */
  async pagesRequested(repoId: string): Promise<void> {
    const state = await this.#state();
    state.repoId = repoId;
    state.pagesDue = true;
    await this.#save(state);
    const due = Date.now() + 250;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > due) await this.ctx.storage.setAlarm(due);
  }

  async alarm(): Promise<void> {
    // The alarm reads state, then waits on D1, the ref listing and Workflows
    // before saving it: a push arriving meanwhile must not be overwritten.
    await this.ctx.blockConcurrencyWhile(() => this.#alarm());
  }

  async #alarm(): Promise<void> {
    const retirement = await pendingRetirement(this.ctx.storage);
    if (retirement) return this.#retire(retirement);
    const state = await this.#state();
    if (!state.repoId) return;
    if (state.running) await this.#watchBuild(state);
    await this.#watchOverlays(state);
    const buildDue =
      !state.running && (Boolean(state.retry) || state.seq > state.builtSeq || state.force);
    let refs: RepoRefs | null = null;
    let indexed: string | null = null;
    let ownerId: string | null = null;
    if (buildDue || state.scan) {
      const [repo, kgState] = await Promise.all([
        db(this.env.DB)
          .selectFrom("repos")
          .select(["artifacts_name", "artifacts_remote", "owner_id"])
          .where("id", "=", state.repoId)
          .where("deleted_at", "is", null)
          .executeTakeFirst(),
        db(this.env.DB)
          .selectFrom("kg_state")
          .select("indexed_commit")
          .where("repo_id", "=", state.repoId)
          .executeTakeFirst(),
      ]);
      indexed = kgState?.indexed_commit ?? null;
      ownerId = repo?.owner_id ?? null;
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
      if (!state.retry && !state.force && refs?.head && refs.head === indexed)
        state.builtSeq = state.seq;
      else {
        const retry = state.retry;
        const policy =
          retry?.policy ??
          (retry ? LEGACY_KNOWLEDGE_POLICY : await knowledgePolicy(this.env, state.repoId));
        if (!policy.ai.features.knowledge) {
          state.builtSeq = state.seq;
          state.force = false;
        } else {
          const buildId = crypto.randomUUID();
          const force = retry ? true : state.force;
          state.running = {
            buildId,
            seq: retry?.seq ?? state.seq,
            force,
            policy,
            commit: retry?.commit ?? refs?.head ?? undefined,
            startedAt: Date.now(),
          };
          if (!retry) state.force = false;
          state.retry = undefined;
          await this.#save(state);
          await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
          await this.env.KNOWLEDGE_BUILD.create({
            id: buildId,
            params: { repoId: state.repoId, buildId, force, policy, commit: state.running.commit },
          });
        }
      }
    }
    // Main's next build waits for its own run to end (finished() schedules it).
    state.burstStartedAt = null;
    // Without a ref listing the scan waits for the next ping.
    if (state.scan && refs && ownerId) await this.#scanOverlays(state, indexed, ownerId);
    await this.#watchPages(state);
    if (state.pagesDue) await this.#startPages(state);
    await this.#save(state);
    if (this.#busy(state)) await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  /**
   * Retiring (CORE-197): start nothing new, keep watching what runs, and
   * purge once it has all ended.
   */
  async #retire(retirement: Retirement): Promise<void> {
    const state = await this.#state();
    if (state.running) await this.#watchBuild(state);
    await this.#watchOverlays(state);
    await this.#watchPages(state);
    await this.#save(state);
    await settleRetirement(
      {
        storage: this.ctx.storage,
        env: this.env,
        className: "KnowledgeCoordinator",
        retirement,
        busy: this.#busy(state),
        purge: (reason) => clearStorage(this.ctx.storage, reason),
      },
      WATCHDOG_MS,
    );
  }

  // The purge contract (worker/durable/contract.ts). Builds, overlays and
  // page sets run in Workflows that report back by id; purge forgets them
  // (their reports find no state and start nothing), retire waits for them.
  async purge(reason: string): Promise<PurgeReport> {
    const report = await clearStorage(this.ctx.storage, reason);
    resetSoon(this.ctx);
    return report;
  }

  retire(reason: string, name: string): Promise<void> {
    return scheduleRetirement(this.ctx.storage, reason, name);
  }

  storageReport() {
    return storageReport(this.ctx.storage);
  }

  #busy(state: State) {
    return (
      Boolean(state.running) ||
      Object.values(state.overlays).some((o) => o.running) ||
      Object.keys(state.pages).length > 0
    );
  }

  /** Release claims only after the workflow reports completion or confirmed termination. */
  async #watchPages(state: State) {
    for (const run of Object.values(state.pages)) {
      const overdue = Date.now() - run.startedAt > PAGES_MAX_MS;
      const status = await confirmedWorkflowEnd(this.env, run.buildId, overdue);
      if (!status) continue;
      if (status.status !== "complete") {
        const error = `Pages ${status.status}`;
        await abandonSet(
          this.env.DB,
          { repoId: state.repoId!, ref: run.ref, key: run.key, sourceId: run.sourceId },
          run.buildId,
          error,
        );
        state.pagesDue = true;
      }
      await releaseSourceRoots(this.env, "knowledge-pages-build", run.buildId);
      await releaseKnowledgeBase(this.env, state.repoId!, `knowledge:${run.buildId}`);
      delete state.pages[run.buildId];
    }
  }

  /** Start the oldest queued page sets there's room for; none before main has a graph. */
  async #startPages(state: State) {
    const repoId = state.repoId!;
    const kgState = await db(this.env.DB)
      .selectFrom("kg_state")
      .select("indexed_commit")
      .where("repo_id", "=", repoId)
      .executeTakeFirst();
    // Main's first build ends with finished(), which looks again.
    if (!kgState?.indexed_commit) return;
    const queued = await queuedSets(this.env.DB, repoId);
    const plan = schedulePages(Object.values(state.pages), queued);
    for (const set of plan.start) {
      const policy = await knowledgePolicy(this.env, repoId);
      if (!policy.ai.features.knowledge || !policy.ai.features.wiki) {
        state.pagesDue = false;
        return;
      }
      const buildId = crypto.randomUUID();
      if (!(await claimSet(this.env.DB, { repoId, ...set }, buildId, policy))) continue;
      state.pages[buildId] = { buildId, ...set, startedAt: Date.now() };
      await this.#save(state);
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
      // Persist admission before create: an ambiguous provider response cannot
      // turn a possibly-running producer back into unclaimed queued work.
      await this.env.KNOWLEDGE_BUILD.create({
        id: buildId,
        params: { repoId, buildId, pages: set, policy },
      });
    }
    // The rest start as these finish (pagesFinished), or at the next wake-up.
    state.pagesDue = plan.more;
  }

  /** Watchdog: a build that crashed without reporting must not block forever. */
  async #watchBuild(state: State) {
    const running = state.running!;
    const build = await db(this.env.DB)
      .selectFrom("kg_builds")
      .select(["progress_at", "to_commit"])
      .where("id", "=", running.buildId)
      .executeTakeFirst();
    const verdict = watchdog(Date.now(), running.startedAt, build?.progress_at ?? null);
    const stale = verdict !== "running";
    const status = await confirmedWorkflowEnd(this.env, running.buildId, stale);
    if (!status) return;
    if (status?.status === "complete") {
      state.lastError = null;
      state.builtSeq = running.seq;
      state.running = null;
      state.scan = true;
    } else {
      // A failed or explicitly terminated workflow may retry; time alone never releases it.
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
        state.retry = {
          ...running,
          commit: build?.to_commit || running.commit,
          policy: running.policy ?? LEGACY_KNOWLEDGE_POLICY,
        };
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
      const overdue = Date.now() - run.startedAt > OVERLAY_MAX_MS;
      const status = await confirmedWorkflowEnd(this.env, run.buildId, overdue);
      if (!status) continue;
      if (status.status === "complete") {
        this.#overlayEnded(state, overlay, { commit: run.commit, base: run.base }, null);
      } else {
        const error = `Overlay ${status.status}`;
        await overlayFailed(this.env.DB, state.repoId!, ref, run.commit, error, run.sourceId);
        this.#overlayEnded(state, overlay, { commit: run.commit, base: run.base }, error);
      }
      if (run.sourceId)
        await releaseSourceRoots(
          this.env,
          "knowledge-overlay",
          `${state.repoId}:${run.sourceId}:${run.buildId}`,
        );
      await releaseKnowledgeBase(this.env, state.repoId!, `knowledge:${run.buildId}`);
    }
  }

  #overlayEnded(
    state: State,
    overlay: State["overlays"][string],
    covered: { commit: string; base: string | null },
    error: string | null,
  ) {
    const run = overlay.running;
    overlay.running = null;
    overlay.lastError = error;
    // A failure is retried once (a cleared `done`), then left until the bookmark or main moves.
    if (error && overlay.retries < MAX_RETRIES) {
      overlay.retries += 1;
      overlay.done = null;
      if (run)
        overlay.retry = {
          commit: run.commit,
          sourceId: run.sourceId,
          base: run.base,
          policy: overlay.policy ?? LEGACY_KNOWLEDGE_POLICY,
        };
    } else {
      overlay.retries = 0;
      overlay.done = { ...covered, sourceId: run?.sourceId };
      overlay.retry = undefined;
    }
    state.scan = true;
  }

  /**
   * Start overlays for bookmarks whose tip or base moved; end the overlays of
   * bookmarks that are gone, keeping them read-only.
   */
  async #scanOverlays(state: State, indexed: string | null, ownerId: string) {
    const repoId = state.repoId!;
    const sources = await liveTimelineSources(this.env, repoId);
    const tips = new Map([...sources].map(([ref, source]) => [ref, source.commit]));
    for (const [ref, source] of sources) {
      const overlay = state.overlays[ref];
      if (!overlay || overlay.running) continue;
      if (overlay.done?.sourceId !== source.sourceId) overlay.done = null;
      if (overlay.retry?.sourceId !== source.sourceId) overlay.retry = undefined;
    }
    // A bookmark this coordinator doesn't follow may be an ended overlay's,
    // pushed again: an ended timeline's overlay is never computed again.
    if ([...tips.keys()].some((ref) => !state.overlays[ref])) {
      for (const [ref, reason] of await endedOverlays(this.env.DB, repoId)) {
        if (!tips.has(ref) || state.overlays[ref]) continue;
        if (reason === "ended") {
          // The tracker never said it ended: it may have since, or it goes on.
          const ended = await timelineEnd(this.env, ownerId, ref);
          if (!ended) {
            await reopenOverlay(this.env.DB, repoId, ref, sources.get(ref)!.sourceId);
            continue;
          }
          await setEndReason(this.env.DB, repoId, ref, ended);
        }
        tips.delete(ref);
      }
    }
    const scan = scanOverlays(state.overlays, tips, indexed);
    const reasons = new Map<string, KnowledgeOverlayEndReason>();
    for (const ref of scan.gone) {
      delete state.overlays[ref];
      reasons.set(ref, (await timelineEnd(this.env, ownerId, ref)) ?? "ended");
    }
    await endOverlays(this.env.DB, repoId, reasons);
    // Over the limit: picked up when one of those in flight ends.
    state.scan = scan.deferred;
    for (const [ref, commit] of scan.start) {
      const previous = state.overlays[ref];
      const retry = previous?.retry;
      const policy = retry?.policy ?? (await knowledgePolicy(this.env, repoId));
      if (!policy.ai.features.knowledge) continue;
      const buildId = crypto.randomUUID();
      const sourceId = sources.get(ref)!.sourceId;
      await pinSourceRoot(this.env, {
        repoId,
        sourceId,
        consumerKind: "knowledge-overlay",
        consumerId: `${repoId}:${sourceId}:${buildId}`,
        commit: retry?.commit ?? commit,
      });
      state.overlays[ref] = {
        ...(state.overlays[ref] ?? { done: null, retries: 0, lastError: null }),
        running: {
          buildId,
          sourceId,
          commit: retry?.commit ?? commit,
          base: retry?.base ?? indexed!,
          startedAt: Date.now(),
        },
        policy,
        retry: undefined,
      };
      await this.#save(state);
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
      await this.env.KNOWLEDGE_BUILD.create({
        id: buildId,
        params: {
          repoId,
          buildId,
          overlay: {
            ref,
            sourceId,
            commit: retry?.commit ?? commit,
            base: retry?.base ?? indexed!,
          },
          policy,
        },
      });
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
    // Main's indexed commit moved: overlays are measured against it, and
    // page sets that waited for main's first graph can start.
    if (ok) {
      state.scan = true;
      state.pagesDue = true;
    }
    await this.#save(state);
    // Pushes that arrived during the build: build again now, for the latest HEAD.
    if (state.seq > state.builtSeq || state.scan) await this.ctx.storage.setAlarm(Date.now() + 250);
    // A retiring coordinator's alarm purges it once this was the last work.
    else if (await pendingRetirement(this.ctx.storage))
      await this.ctx.storage.setAlarm(Date.now() + 250);
    else if (!this.#busy(state)) await this.ctx.storage.deleteAlarm();
  }

  /** Called by the Workflow when a page set ends, however it ended. */
  async pagesFinished(buildId: string): Promise<void> {
    const state = await this.#state();
    if (!state.pages[buildId]) return;
    delete state.pages[buildId];
    state.pagesDue = true;
    await this.#save(state);
    await this.ctx.storage.setAlarm(Date.now() + 250);
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
      running: state.running
        ? { ...state.running, ai: state.running.policy?.ai ?? LEGACY_KNOWLEDGE_POLICY.ai }
        : null,
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
      pages: Object.values(state.pages),
    };
  }
}

/** The coordinator for one repository. */
export function coordinator(env: Env, repoId: string): DurableObjectStub<KnowledgeCoordinator> {
  return durableStub(env, "KnowledgeCoordinator", repoId);
}

/** Tell a repository's coordinator that something changed. */
export async function notifyKnowledge(env: Env, repoId: string, options: { force?: boolean } = {}) {
  // Automatic non-AI agent environments omit provider bindings altogether,
  // and a preview never starts the (production) KnowledgeBuild Workflow.
  if (!env.AI || !productionOnly(env, "workflow", "a knowledge build")) return false;
  if (!(await repoAiSnapshot(env.DB, repoId)).features.knowledge) return false;
  await coordinator(env, repoId).notify(repoId, options);
  return true;
}

/**
 * Queue a timeline's wiki page set (CORE-84) and wake the repository's
 * coordinator. Idempotent per key; nothing is queued where knowledge AI is
 * off (automatic non-AI test environments) or the timeline's overlay ended.
 */
export async function requestPages(env: Env, request: PageRequest) {
  if (!env.AI || !productionOnly(env, "workflow", "wiki pages")) return null;
  const ai = await repoAiSnapshot(env.DB, request.repoId);
  if (!ai.features.knowledge || !ai.features.wiki) return null;
  const source = await timelineKnowledgeSource(env, request.repoId, request.ref);
  if (!source || source.source_id !== request.sourceId)
    throw new Error("Timeline source migration required or source mismatch");
  if (source.state !== "ready") return { status: "ended" as const, queued: false };
  if (!(await knowledgeRepo(env, request.repoId, source.source_id))) return null;
  const result = await queueSet(env.DB, request);
  if (result.status === "queued")
    await coordinator(env, request.repoId).pagesRequested(request.repoId);
  return result;
}

/**
 * A checkpoint was made: queue the wiki pages of its timeline in each of its
 * repositories, at the checkpoint's commits. Runs after the response
 * (waitUntil), so it never slows making the checkpoint.
 */
export async function requestCheckpointPages(
  env: Env,
  checkpoint: Checkpoint,
  slug: string,
  requestedBy: string | null,
) {
  const ref = `refs/heads/timeline/${slug}`;
  await Promise.all(
    checkpoint.repos.map((repo) =>
      requestPages(env, {
        repoId: repo.id,
        sourceId: repo.source?.sourceId,
        ref,
        key: checkpoint.id,
        commit: repo.commit,
        checkpoint: { id: checkpoint.id, number: checkpoint.number },
        requestedBy,
      }).catch((error) =>
        console.error("Knowledge: queueing a checkpoint's pages failed", {
          checkpoint: checkpoint.id,
          repo: repo.id,
          error,
        }),
      ),
    ),
  );
}
