// A timeline's live feed of steps in one repository (CORE-239): the PRD's
// Durable Object path, fed directly when a step is uploaded (steps/api.ts),
// ahead of K2 (CORE-240). One per repository and timeline, named
// "<repoId>:<slug>", so repository deletion purges it.
//
// It keeps the newest records for a week and streams them as Server-Sent
// Events: what it has after the reader's Last-Event-ID, then each new record
// as it arrives. The Worker route checks the reader may read the repository
// before connecting; a stream ends after STREAM_MS so access is checked
// again on reconnect.
//
// Deleting a step (CORE-399) makes the feed forget it: its record goes, and a
// tombstone stays as long as a record could, so a publish still in flight
// can't bring it back, and every reader, including one that reconnects after
// missing the live removal, is told to drop it (`event: removed`).

import { DurableObject } from "cloudflare:workers";
import { STEP_FEED_DAYS, type StepFeedRecord, type StepFeedRemoval } from "../../shared/steps.ts";
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
/** …for at most this long (the PRD's feed retention; an account may keep less, CORE-244). */
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
  #subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  /**
   * Append a record, keep the newest, and send it to everyone reading. A step
   * the feed was told to forget is refused (null): its publish was in flight
   * when it was deleted.
   */
  async publish(
    record: Omit<StepFeedRecord, "seq" | "at">,
    keepMs: number = FEED_TTL_MS,
  ): Promise<StepFeedRecord | null> {
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
    this.#broadcast(sseEvent(full));
    return full;
  }

  /**
   * Forget deleted steps (CORE-399): drop their records, remember them for as
   * long as a record could be kept, and tell everyone reading. Idempotent: a
   * step already forgotten is skipped. A step with no record is remembered
   * too, as a reader may still hold one the feed no longer keeps. Returns how
   * many were newly forgotten.
   */
  async forget(steps: StepFeedRemoval[]): Promise<number> {
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
      this.#broadcast(sseRemoved(removal));
      fresh += 1;
    }
    if (fresh) {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
    }
    return fresh;
  }

  /** The steps this feed was told to forget, and hasn't yet let go of. */
  async removals(): Promise<StepFeedRemoval[]> {
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
  async replay(after: number): Promise<string> {
    const removals = await this.removals();
    const backlog = await this.since(after);
    return (
      `retry: 5000\n: ${backlog.length} record(s)\n\n` +
      removals.map(sseRemoved).join("") +
      backlog.map(sseEvent).join("")
    );
  }

  #broadcast(text: string) {
    const event = encoder.encode(text);
    for (const writer of this.#subscribers) writer.write(event).catch(() => this.#drop(writer));
  }

  /** Records after `after`, oldest first. */
  async since(after: number): Promise<StepFeedRecord[]> {
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
    const url = new URL(request.url);
    const raw = request.headers.get("last-event-id") ?? url.searchParams.get("after");
    const after = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    // Queued, not awaited: nothing reads the stream until the response is returned.
    // `retry` tells EventSource-style readers to reconnect after 5 s.
    writer.write(encoder.encode(await this.replay(after))).catch(() => this.#drop(writer));
    this.#subscribers.add(writer);
    const keepalive = setInterval(() => {
      writer.write(encoder.encode(": keepalive\n\n")).catch(() => this.#drop(writer));
    }, KEEPALIVE_MS);
    const end = setTimeout(() => this.#drop(writer), STREAM_MS);
    writer.closed
      .catch(() => {})
      .finally(() => {
        clearInterval(keepalive);
        clearTimeout(end);
        this.#subscribers.delete(writer);
      });
    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }

  #drop(writer: WritableStreamDefaultWriter<Uint8Array>) {
    this.#subscribers.delete(writer);
    writer.close().catch(() => {});
  }

  /** How many readers are connected (for tests and the retirement check). */
  subscribers(): number {
    return this.#subscribers.size;
  }

  override async alarm(): Promise<void> {
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
  }

  /** Deletes `key` if it's due; returns when it expires. */
  async #expire(key: string, at: number, now: number): Promise<number> {
    if (at <= now) await this.ctx.storage.delete(key);
    return at;
  }

  async purge(reason: string): Promise<PurgeReport> {
    for (const writer of this.#subscribers) this.#drop(writer);
    const report = await clearStorage(this.ctx.storage, reason);
    resetSoon(this.ctx);
    return report;
  }

  retire(reason: string, name: string, delayMs?: number): Promise<void> {
    return scheduleRetirement(this.ctx.storage, reason, name, delayMs);
  }

  storageReport() {
    return storageReport(this.ctx.storage);
  }
}
