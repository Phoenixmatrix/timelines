// A repository's live step feed (GET …/steps/live) for a browser test. The
// in-memory API has no Durable Objects, so the feed is canned: each reader
// gets the backlog and then stays connected, so what the test pushes or
// removes arrives at once, as from the real feed, with no reconnect to wait
// out. `drop()` ends every connection, so a test can watch the page reconnect.

import { onTestFinished } from "vite-plus/test";
import type { StepFeedRecord, StepFeedRemoval } from "../../shared/steps.ts";
import type { CannedRequest, TestServer } from "./server.ts";

const encoder = new TextEncoder();
const step = (r: StepFeedRecord) => `id: ${r.seq}\nevent: step\ndata: ${JSON.stringify(r)}\n\n`;
const removed = ({ repo, changeId, commitOid }: StepFeedRemoval) =>
  `event: removed\ndata: ${JSON.stringify({ repo, changeId, commitOid })}\n\n`;

export interface CannedFeed {
  /** Connections made so far, reconnects included. */
  readonly connections: number;
  /** A new record, to every reader now and in every later backlog. */
  push(record: StepFeedRecord): void;
  /** A step an admin deleted (CORE-399), likewise. */
  remove(removal: StepFeedRemoval): void;
  /** End every open connection, as a dropped stream would. */
  drop(): void;
}

/**
 * Serve `records` as the feed of every repository. `replay` picks what a
 * connection gets first (by default every record, then every removal).
 */
export function cannedFeed(
  server: TestServer,
  records: StepFeedRecord[] = [],
  replay?: (
    request: CannedRequest,
    feed: { records: StepFeedRecord[]; removals: StepFeedRemoval[] },
  ) => string,
): CannedFeed {
  const removals: StepFeedRemoval[] = [];
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let connections = 0;
  const send = (text: string) => {
    for (const reader of open) reader.enqueue(encoder.encode(text));
  };
  const drop = () => {
    for (const reader of open) reader.close();
    open.clear();
  };
  // The page's reads never see the test's end: close them, or they hang on.
  onTestFinished(drop);
  server.on("GET", "/api/repos/:owner/:name/steps/live", (request) => {
    connections += 1;
    const backlog = replay
      ? replay(request, { records, removals })
      : records.map(step).join("") + removals.map(removed).join("");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        open.add(c);
        c.enqueue(encoder.encode(`retry: 5000\n\n${backlog}`));
      },
      cancel() {
        open.delete(controller);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  return {
    get connections() {
      return connections;
    },
    push(record) {
      records.push(record);
      send(step(record));
    },
    remove(removal) {
      removals.push(removal);
      send(removed(removal));
    },
    drop,
  };
}
