// One coordinator per repository (a Durable Object) decides when to build.
//
// Every push pings it. It waits for a short quiet period, so an agent pushing
// five times in ten seconds causes one build rather than five, then starts a
// Workflow. While a build runs, further pushes only mark the repo dirty; when
// the build finishes, a dirty repo builds again right away with the latest
// HEAD. Per-file work is cached by content, so the follow-up build is cheap.
// At most one build per repository is ever in flight.

import { DurableObject } from "cloudflare:workers";
import { db, nowIso } from "../schema.ts";

/** Quiet period after the last push before building. */
const DEBOUNCE_MS = 1_500;
/** …but never wait longer than this after the first push of a burst. */
const MAX_WAIT_MS = 8_000;
/** Check on a running build this often, in case it died without reporting. */
const WATCHDOG_MS = 60_000;
/** A build running longer than this is presumed hung: terminated and retried. */
const STALE_MS = 20 * 60_000;
/** Retries of a build that crashed or hung, before giving up until the next push. */
const MAX_RETRIES = 1;

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
    state.burstStartedAt ??= now;
    await this.#save(state);
    if (!state.running) {
      const due = Math.min(now + DEBOUNCE_MS, state.burstStartedAt + MAX_WAIT_MS);
      await this.ctx.storage.setAlarm(due);
    }
  }

  async alarm(): Promise<void> {
    const state = await this.#state();
    if (!state.repoId) return;
    if (state.running) {
      // Watchdog: a build that crashed without reporting must not block forever.
      const instance = await this.env.KNOWLEDGE_BUILD.get(state.running.buildId).catch(() => null);
      const status = instance ? await instance.status().catch(() => null) : null;
      const stale = Date.now() - state.running.startedAt > STALE_MS;
      if (status?.status === "complete") {
        state.lastError = null;
        state.builtSeq = state.running.seq;
        state.running = null;
      } else if (!status || stale || ["errored", "terminated"].includes(status.status)) {
        // Crashed, vanished or hung: stop it, and retry once before giving up.
        if (stale) await instance?.terminate().catch(() => undefined);
        await db(this.env.DB)
          .updateTable("kg_builds")
          .set({
            status: "failed",
            error: stale
              ? "Build hung; stopped by the watchdog"
              : `Build ${status?.status ?? "vanished"}`,
            finished_at: nowIso(),
          })
          .where("id", "=", state.running.buildId)
          .where("status", "=", "running")
          .execute();
        const reason = stale ? "hung" : (status?.status ?? "vanished");
        state.lastError = `Build ${reason}${status?.error?.message ? `: ${status.error.message}` : ""}`;
        if (state.retries < MAX_RETRIES) {
          state.retries += 1;
          state.force = true;
        } else {
          state.builtSeq = state.running.seq;
          state.retries = 0;
        }
        state.running = null;
      } else {
        await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
        await this.#save(state);
        return;
      }
    }
    if (state.seq <= state.builtSeq && !state.force) {
      state.burstStartedAt = null;
      await this.#save(state);
      return;
    }
    const buildId = crypto.randomUUID();
    await this.env.KNOWLEDGE_BUILD.create({
      id: buildId,
      params: { repoId: state.repoId, buildId, force: state.force },
    });
    state.running = { buildId, seq: state.seq, startedAt: Date.now() };
    state.force = false;
    state.burstStartedAt = null;
    await this.#save(state);
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
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
    await this.#save(state);
    // Pushes that arrived during the build: build again now, for the latest HEAD.
    if (state.seq > state.builtSeq) await this.ctx.storage.setAlarm(Date.now() + 250);
    else await this.ctx.storage.deleteAlarm();
  }

  async status(): Promise<CoordinatorStatus> {
    const state = await this.#state();
    return {
      running: state.running,
      pending: state.seq > state.builtSeq && !state.running,
      lastError: state.lastError,
      lastFinishedAt: state.lastFinishedAt,
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
  return coordinator(env, repoId).notify(repoId, options);
}
