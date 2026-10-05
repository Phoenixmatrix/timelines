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

import { DurableObject } from "cloudflare:workers";
import { STEP_FEED_DAYS, type StepFeedRecord } from "../../shared/steps.ts";
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
/** A stream ends after this long; readers reconnect, and are checked again. */
const STREAM_MS = 10 * 60_000;
/** A comment line this often keeps proxies from closing an idle stream. */
const KEEPALIVE_MS = 25_000;

/** When a record expires: its own time, or a week after it arrived (older records). */
const expiry = (record: Stored) => record.expiresAt ?? Date.parse(record.at) + FEED_TTL_MS;

const KEY = (seq: number) => `r:${String(seq).padStart(12, "0")}`;
const encoder = new TextEncoder();

/** A record as an SSE event. */
export function sseEvent(record: StepFeedRecord): string {
  return `id: ${record.seq}\nevent: step\ndata: ${JSON.stringify(record)}\n\n`;
}

export class StepFeed extends DurableObject<Env> implements Purgeable {
  #subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  /** Append a record, keep the newest, and send it to everyone reading. */
  async publish(
    record: Omit<StepFeedRecord, "seq" | "at">,
    keepMs: number = FEED_TTL_MS,
  ): Promise<StepFeedRecord> {
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
    const event = encoder.encode(sseEvent(full));
    for (const writer of this.#subscribers) writer.write(event).catch(() => this.#drop(writer));
    return full;
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
    const backlog = await this.since(after);
    // Queued, not awaited: nothing reads the stream until the response is returned.
    // `retry` tells EventSource-style readers to reconnect after 5 s.
    const send = (text: string) =>
      writer.write(encoder.encode(text)).catch(() => this.#drop(writer));
    void send(`retry: 5000\n: ${backlog.length} record(s)\n\n`);
    for (const record of backlog) void send(sseEvent(record));
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
    // Expire records past their time; come back when the next one is due.
    const rows = await this.ctx.storage.list<Stored>({ prefix: "r:" });
    const now = Date.now();
    for (const [key, record] of rows) if (expiry(record) <= now) await this.ctx.storage.delete(key);
    const next = Math.min(...[...rows.values()].map(expiry).filter((at) => at > now));
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }

  async purge(reason: string): Promise<PurgeReport> {
    for (const writer of this.#subscribers) this.#drop(writer);
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
}
