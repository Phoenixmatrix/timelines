// A timeline's live feed of steps in one repository (CORE-239): the PRD's
// Durable Object path, fed directly when a step is uploaded (steps/api.ts),
// ahead of K2 (CORE-240). One per repository and timeline, named
// "<repoId>:<slug>", so repository deletion purges it.
//
// It keeps the newest records for a week and streams them as Server-Sent
// Events: what it has after the reader's Last-Event-ID, then each new record
// as it arrives. The Worker and Durable Object bind the reader to the
// repository, Space, timeline and migration epoch. Every outgoing event
// rechecks the original credential and current read grant.
//
// Deleting a step (CORE-399) makes the feed forget it: its record goes, and a
// tombstone stays as long as a record could, so a publish still in flight
// can't bring it back, and every reader, including one that reconnects after
// missing the live removal, is told to drop it (`event: removed`).

import { DurableObject } from "cloudflare:workers";
import { withCutoverAdmission, withCutoverAlarmAdmission } from "../durable/cutover-admission.ts";
import { reportCutoverRuntime } from "../durable/cutover-runtime.ts";
import { STEP_FEED_DAYS, type StepFeedRecord, type StepFeedRemoval } from "../../shared/steps.ts";
import { resolveWorkAuthority, type WorkAuthority } from "../ci/admission.ts";
import { isActorCredentialLive } from "../auth.ts";
import { findUserById, roleFor, selectRepos, type Actor } from "../db.ts";
import { atLeast } from "../permissions.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import {
  clearStorage,
  pendingRetirement,
  resetSoon,
  scheduleRetirement,
  settleRetirement,
  storageReport,
  type Purgeable,
  type PurgeReport,
} from "../durable/contract.ts";

/** Records kept, newest. */
export const FEED_KEEP = 100;
/** …for at most this long (the PRD's feed retention; a Space may keep less, CORE-244). */
export const FEED_TTL_MS = STEP_FEED_DAYS * 24 * 60 * 60_000;

/** A stored record: what readers get, and when it expires. */
type Stored = StepFeedRecord & { expiresAt?: number };
/** A forgotten step: what readers are told to drop, until it expires. No `seq`. */
type Tombstone = StepFeedRemoval & { expiresAt: number };
/** A stream ends after this long; readers reconnect, and are checked again. */
const STREAM_MS = 10 * 60_000;
/** A comment line this often keeps proxies from closing an idle stream. */
const KEEPALIVE_MS = 25_000;

/** When a record expires: its own time, or a week after it arrived (older records). */
const expiry = (record: Stored) => record.expiresAt ?? Date.parse(record.at) + FEED_TTL_MS;

const KEY = (seq: number) => `r:${String(seq).padStart(12, "0")}`;
const GONE = (step: { changeId: string; commitOid: string }) =>
  `x:${step.changeId}:${step.commitOid}`;
const encoder = new TextEncoder();

export interface StepFeedAccess {
  repoId: string;
  timeline: string;
  spaceId: string;
  migrationEpoch: number;
  personId: string | null;
  agentId: string | null;
  credential: Actor["credential"] | null;
}

export async function captureFeedAccess(
  env: Env,
  repoId: string,
  timeline: string,
  actor: Actor | null,
): Promise<StepFeedAccess> {
  const admission = await cutoverControl(env).admission(4);
  if (!admission.allowed) throw new Error("space_cutover_fenced");
  const repo = await selectRepos(env.DB, actor?.id ?? "")
    .where("r.id", "=", repoId)
    .executeTakeFirst();
  if (!repo || !repo.space_id) throw new Error("Step feed repository unavailable.");
  const access: StepFeedAccess = {
    repoId,
    timeline,
    spaceId: repo.space_id,
    migrationEpoch: admission.epoch,
    personId: actor?.id ?? null,
    agentId: actor?.agent?.id ?? null,
    credential: actor?.credential ?? null,
  };
  await resolveFeedAccess(env, access);
  return access;
}

async function resolveFeedAccess(env: Env, access: StepFeedAccess) {
  const admission = await cutoverControl(env).admission(4);
  if (!admission.allowed || admission.epoch !== access.migrationEpoch)
    throw new Error("migration_epoch_mismatch");
  let actor: Actor | null = null;
  if (access.personId !== null) {
    const person = await findUserById(env.DB, access.personId);
    if (!person || !access.credential) throw new Error("Step feed credential unavailable.");
    actor = { ...person, credential: access.credential };
    if (access.agentId !== null) actor.agent = { id: access.agentId, name: "" };
    if (!(await isActorCredentialLive(env.DB, actor)))
      throw new Error("Step feed credential revoked.");
  } else if (access.agentId !== null || access.credential !== null)
    throw new Error("Step feed identity mismatch.");
  const repo = await selectRepos(env.DB, actor?.id ?? "")
    .where("r.id", "=", access.repoId)
    .executeTakeFirst();
  if (!repo || repo.space_id !== access.spaceId || !atLeast(roleFor(repo, actor), "read"))
    throw new Error("Step feed access revoked.");
}

/** A record as an SSE event. */
export function sseEvent(record: StepFeedRecord): string {
  return `id: ${record.seq}\nevent: step\ndata: ${JSON.stringify(record)}\n\n`;
}

/** A removal as an SSE event: no `id`, so it never moves a reader's Last-Event-ID. */
export function sseRemoved(removal: StepFeedRemoval): string {
  const { repo, changeId, commitOid } = removal;
  return `event: removed\ndata: ${JSON.stringify({ repo, changeId, commitOid })}\n\n`;
}

export class StepFeed extends DurableObject<Env> implements Purgeable {
  #subscribers = new Map<
    WritableStreamDefaultWriter<Uint8Array>,
    (event: Uint8Array) => Promise<unknown>
  >();

  cutoverRuntime(runId: string) {
    return reportCutoverRuntime(this.env, runId, "step-feed");
  }

  /**
   * Append a record, keep the newest, and send it to everyone reading. A step
   * the feed was told to forget is refused (null): its publish was in flight
   * when it was deleted.
   */
  async publish(
    repoId: string,
    authority: WorkAuthority,
    record: Omit<StepFeedRecord, "seq" | "at">,
    keepMs: number = FEED_TTL_MS,
  ): Promise<StepFeedRecord | null> {
    return withCutoverAdmission(this.env, "step-feed", async () => {
      const { repo } = await resolveWorkAuthority(this.env, authority, repoId);
      if (repo.deleted_at) throw new Error("Step feed repository is being deleted.");
      if (record.repo !== `${repo.space_slug}/${repo.name}`)
        throw new Error("Step feed repository mismatch.");
      await this.#bind(repoId, record.timeline, authority.spaceId);
      if (await this.ctx.storage.get(GONE(record))) return null;
      const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
      const now = Date.now();
      const full: StepFeedRecord = { ...record, seq, at: new Date(now).toISOString() };
      const expiresAt = now + Math.min(Math.max(keepMs, 60_000), FEED_TTL_MS);
      await this.ctx.storage.put("seq", seq);
      await this.ctx.storage.put(KEY(seq), { ...full, expiresAt } satisfies Stored);
      if (seq > FEED_KEEP) await this.ctx.storage.delete(KEY(seq - FEED_KEEP));
      // Wake when this record expires, unless something expires sooner.
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
      await this.#broadcast(sseEvent(full));
      return full;
    });
  }

  /**
   * Forget deleted steps (CORE-399): drop their records, remember them for as
   * long as a record could be kept, and tell everyone reading. Idempotent: a
   * step already forgotten is skipped. A step with no record is remembered
   * too, as a reader may still hold one the feed no longer keeps. Returns how
   * many were newly forgotten.
   */
  forget(steps: StepFeedRemoval[]): Promise<number> {
    return withCutoverAdmission(this.env, "step-feed", () => this.#forget(steps));
  }

  async #forget(steps: StepFeedRemoval[]): Promise<number> {
    let rows: Map<string, Stored> | undefined;
    const expiresAt = Date.now() + FEED_TTL_MS;
    let fresh = 0;
    for (const step of steps) {
      const gone = GONE(step);
      if (await this.ctx.storage.get(gone)) continue;
      rows ??= await this.ctx.storage.list<Stored>({ prefix: "r:" });
      // Readers match by the repository the record carried.
      let repo = step.repo;
      for (const [key, record] of rows) {
        if (record.changeId !== step.changeId || record.commitOid !== step.commitOid) continue;
        repo = record.repo;
        await this.ctx.storage.delete(key);
        rows.delete(key);
      }
      const removal: StepFeedRemoval = { repo, changeId: step.changeId, commitOid: step.commitOid };
      await this.ctx.storage.put(gone, { ...removal, expiresAt } satisfies Tombstone);
      await this.#broadcast(sseRemoved(removal));
      fresh += 1;
    }
    if (fresh) {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
    }
    return fresh;
  }

  /** The steps this feed was told to forget, and hasn't yet let go of. */
  removals(): Promise<StepFeedRemoval[]> {
    return withCutoverAdmission(this.env, "step-feed", () => this.#removals());
  }

  async #removals(): Promise<StepFeedRemoval[]> {
    const rows = await this.ctx.storage.list<Tombstone>({ prefix: "x:" });
    const now = Date.now();
    return [...rows.values()]
      .filter((t) => t.expiresAt > now)
      .map(({ repo, changeId, commitOid }) => ({ repo, changeId, commitOid }));
  }

  /**
   * What a reader gets on connecting: the reconnect delay, every removal (a
   * reader may hold a record from before it reconnected), then the records
   * after `after`.
   */
  async #replay(after: number): Promise<string> {
    const removals = await this.#removals();
    const backlog = await this.#since(after);
    return (
      `retry: 5000\n: ${backlog.length} record(s)\n\n` +
      removals.map(sseRemoved).join("") +
      backlog.map(sseEvent).join("")
    );
  }

  /** Each reader's send rechecks its access before the event goes out. */
  async #broadcast(text: string) {
    const event = encoder.encode(text);
    await Promise.all([...this.#subscribers.values()].map((send) => send(event)));
  }

  /** Records after `after`, oldest first. */
  async since(access: StepFeedAccess, after: number): Promise<StepFeedRecord[]> {
    return withCutoverAdmission(this.env, "step-feed", async () => {
      await resolveFeedAccess(this.env, access);
      await this.#bind(access.repoId, access.timeline, access.spaceId);
      return this.#since(after);
    });
  }

  async #since(after: number): Promise<StepFeedRecord[]> {
    // At most FEED_KEEP records: filtering here is as cheap as a ranged list.
    const rows = await this.ctx.storage.list<Stored>({ prefix: "r:" });
    const now = Date.now();
    return [...rows.values()]
      .filter((r) => r.seq > after && expiry(r) > now)
      .sort((a, b) => a.seq - b.seq)
      .map((stored) => {
        const record: Stored = { ...stored };
        delete record.expiresAt;
        return record as StepFeedRecord;
      });
  }

  /** GET: an SSE stream from after Last-Event-ID (or `?after=`), or the newest records. */
  override async fetch(request: Request): Promise<Response> {
    return withCutoverAdmission(this.env, "step-feed", async () => {
      const url = new URL(request.url);
      const access = JSON.parse(
        request.headers.get("x-step-feed-access") ?? "null",
      ) as StepFeedAccess | null;
      if (!access) return new Response("Step feed access required.", { status: 403 });
      await resolveFeedAccess(this.env, access);
      await this.#bind(access.repoId, access.timeline, access.spaceId);
      const raw = request.headers.get("last-event-id") ?? url.searchParams.get("after");
      const after = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      // This independent ticket survives the fetch reply until every publication
      // settles and the connection ends. An abandoned reader is aborted at expiry.
      this.ctx.waitUntil(
        withCutoverAdmission(this.env, "step-feed", async () => {
          const end = setTimeout(() => {
            void this.#drop(writer);
          }, STREAM_MS);
          const writes = new Set<Promise<unknown>>();
          let queued = Promise.resolve<unknown>(undefined);
          const send = (event: Uint8Array) => {
            const pending = queued
              .then(() => resolveFeedAccess(this.env, access))
              .then(() => writer.write(event))
              .catch(() => this.#drop(writer));
            queued = pending;
            writes.add(pending);
            void pending.finally(() => writes.delete(pending));
            return pending;
          };
          const keepalive = setInterval(() => {
            void send(encoder.encode(": keepalive\n\n"));
          }, KEEPALIVE_MS);
          try {
            // Removals first: a reconnecting reader may hold a record deleted since.
            void send(encoder.encode(await this.#replay(after)));
            // Queue the replay before exposing this writer to live publications.
            this.#subscribers.set(writer, send);
            await writer.closed.catch(() => {});
          } finally {
            clearTimeout(end);
            clearInterval(keepalive);
            this.#subscribers.delete(writer);
            await Promise.allSettled(writes);
          }
        }).catch(async (error) => {
          await this.#drop(writer);
          throw error;
        }),
      );
      return new Response(readable, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        },
      });
    });
  }

  async #bind(repoId: string, timeline: string, spaceId: string) {
    const expected = `${repoId}:${timeline}`;
    if (this.ctx.id.name !== expected) throw new Error("Step feed scope mismatch.");
    const scope = await this.ctx.storage.get<{ repoId: string; timeline: string; spaceId: string }>(
      "scope",
    );
    if (
      scope &&
      (scope.repoId !== repoId || scope.timeline !== timeline || scope.spaceId !== spaceId)
    )
      throw new Error("Step feed immutable scope mismatch.");
    if (!scope) await this.ctx.storage.put("scope", { repoId, timeline, spaceId });
  }

  #drop(writer: WritableStreamDefaultWriter<Uint8Array>) {
    this.#subscribers.delete(writer);
    return writer.abort().catch(() => {});
  }

  /** How many readers are connected (for tests and the retirement check). */
  subscribers(): Promise<number> {
    return withCutoverAdmission(this.env, "step-feed", async () => this.#subscribers.size);
  }

  override async alarm(): Promise<void> {
    return withCutoverAlarmAdmission(this.env, "step-feed", this.ctx.storage, async () => {
      const retirement = await pendingRetirement(this.ctx.storage);
      if (retirement) {
        await settleRetirement({
          storage: this.ctx.storage,
          env: this.env,
          className: "StepFeed",
          retirement,
          busy: false,
          purge: (reason) => clearStorage(this.ctx.storage, reason),
        });
        return;
      }
      // Expire records and removals past their time; come back when the next one is due.
      const rows = await this.ctx.storage.list<Stored>({ prefix: "r:" });
      const gone = await this.ctx.storage.list<Tombstone>({ prefix: "x:" });
      const now = Date.now();
      const times: number[] = [];
      for (const [key, record] of rows) times.push(await this.#expire(key, expiry(record), now));
      for (const [key, tomb] of gone) times.push(await this.#expire(key, tomb.expiresAt, now));
      const next = Math.min(...times.filter((at) => at > now));
      if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    });
  }

  /** Deletes `key` if it's due; returns when it expires. */
  async #expire(key: string, at: number, now: number): Promise<number> {
    if (at <= now) await this.ctx.storage.delete(key);
    return at;
  }

  async purge(reason: string): Promise<PurgeReport> {
    const report = await withCutoverAdmission(this.env, "step-feed", async () => {
      await Promise.all([...this.#subscribers.keys()].map((writer) => this.#drop(writer)));
      return clearStorage(this.ctx.storage, reason);
    });
    resetSoon(this.ctx);
    return report;
  }

  retire(reason: string, name: string, delayMs?: number): Promise<void> {
    return withCutoverAdmission(this.env, "step-feed", () =>
      scheduleRetirement(this.ctx.storage, reason, name, delayMs),
    );
  }

  storageReport() {
    return withCutoverAdmission(this.env, "step-feed", () => storageReport(this.ctx.storage));
  }
}
