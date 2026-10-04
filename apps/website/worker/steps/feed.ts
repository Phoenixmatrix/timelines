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
import type { StepFeedRecord } from "../../shared/steps.ts";
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
/** …for at most this long (the PRD's feed retention). */
export const FEED_TTL_MS = 7 * 24 * 60 * 60_000;
/** A stream ends after this long; readers reconnect, and are checked again. */
const STREAM_MS = 10 * 60_000;
/** A comment line this often keeps proxies from closing an idle stream. */
const KEEPALIVE_MS = 25_000;

const KEY = (seq: number) => `r:${String(seq).padStart(12, "0")}`;
const encoder = new TextEncoder();

/** A record as an SSE event. */
export function sseEvent(record: StepFeedRecord): string {
  return `id: ${record.seq}\nevent: step\ndata: ${JSON.stringify(record)}\n\n`;
}

export class StepFeed extends DurableObject<Env> implements Purgeable {
  #subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  /** Append a record, keep the newest, and send it to everyone reading. */
  async publish(record: Omit<StepFeedRecord, "seq" | "at">): Promise<StepFeedRecord> {
    const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
    const full: StepFeedRecord = { ...record, seq, at: new Date().toISOString() };
    await this.ctx.storage.put("seq", seq);
    await this.ctx.storage.put(KEY(seq), full);
    if (seq > FEED_KEEP) await this.ctx.storage.delete(KEY(seq - FEED_KEEP));
    // The oldest record expires a week from now at the latest.
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + FEED_TTL_MS);
    const event = encoder.encode(sseEvent(full));
    for (const writer of this.#subscribers) writer.write(event).catch(() => this.#drop(writer));
    return full;
  }

  /** Records after `after`, oldest first. */
  async since(after: number): Promise<StepFeedRecord[]> {
    // At most FEED_KEEP records: filtering here is as cheap as a ranged list.
    const rows = await this.ctx.storage.list<StepFeedRecord>({ prefix: "r:" });
    const cutoff = Date.now() - FEED_TTL_MS;
    return [...rows.values()]
      .filter((r) => r.seq > after && Date.parse(r.at) >= cutoff)
      .sort((a, b) => a.seq - b.seq);
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
    // Expire records older than a week; come back when the next one is due.
    const rows = await this.ctx.storage.list<StepFeedRecord>({ prefix: "r:" });
    const cutoff = Date.now() - FEED_TTL_MS;
    const old = [...rows].filter(([, r]) => Date.parse(r.at) < cutoff).map(([k]) => k);
    for (const key of old) await this.ctx.storage.delete(key);
    const next = [...rows.values()].find((r) => Date.parse(r.at) >= cutoff);
    if (next) await this.ctx.storage.setAlarm(Date.parse(next.at) + FEED_TTL_MS);
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
