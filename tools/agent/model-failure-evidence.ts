import { open } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  parseModelFailureDiagnostic,
  type ModelFailureDiagnostic,
} from "../../apps/website/worker/knowledge/model-failure.ts";

export const FAILURE_EVIDENCE_LIMITS = {
  bytes: 8 * 1024 * 1024,
  lineBytes: 4096,
  events: 256,
} as const;

export interface ModelFailureEvidence {
  source: "server.log";
  read: "complete" | "missing" | "unavailable";
  scannedBytes: number;
  omittedBytes: number;
  oversizedLines: number;
  invalidEvents: number;
  omittedEvents: number;
  events: ModelFailureDiagnostic[];
}

/** Snapshot only the owned log's bounded tail; never retain a raw line or read error. */
export async function collectModelFailureEvidence(
  artifacts: string,
): Promise<ModelFailureEvidence> {
  const report: ModelFailureEvidence = {
    source: "server.log",
    read: "complete",
    scannedBytes: 0,
    omittedBytes: 0,
    oversizedLines: 0,
    invalidEvents: 0,
    omittedEvents: 0,
    events: [],
  };
  let file;
  try {
    file = await open(join(artifacts, "server.log"), "r");
    const { size } = await file.stat();
    const start = Math.max(0, size - FAILURE_EVIDENCE_LIMITS.bytes);
    const bytes = Buffer.alloc(Math.min(size, FAILURE_EVIDENCE_LIMITS.bytes));
    let read = 0;
    while (read < bytes.length) {
      const chunk = await file.read(bytes, read, bytes.length - read, start + read);
      if (!chunk.bytesRead) break;
      read += chunk.bytesRead;
    }
    report.scannedBytes = read;
    report.omittedBytes = start;
    // A cut first line is not an event, even if its remaining bytes look like JSON.
    let begin = start ? bytes.subarray(0, read).indexOf(10) + 1 : 0;
    if (start && !begin) begin = read;
    report.omittedBytes += begin;
    while (begin < read) {
      const newline = bytes.subarray(0, read).indexOf(10, begin);
      const end = newline < 0 ? read : newline;
      if (end - begin > FAILURE_EVIDENCE_LIMITS.lineBytes) {
        report.oversizedLines++;
      } else {
        // Console warning framing only: never fish JSON out of arbitrary log text.
        const line = stripVTControlCharacters(bytes.toString("utf8", begin, end))
          .trim()
          .replace(/^(?:▲ )?\[WARNING\]\s*/, "");
        if (/^\{\s*"event"\s*:\s*"ai\.model\.failed"/.test(line)) {
          let diagnostic: ModelFailureDiagnostic | null = null;
          try {
            diagnostic = parseModelFailureDiagnostic(JSON.parse(line));
          } catch {
            // Malformed matching JSON is counted, never copied into retained evidence.
          }
          if (!diagnostic) report.invalidEvents++;
          else if (report.events.length < FAILURE_EVIDENCE_LIMITS.events)
            report.events.push(diagnostic);
          else report.omittedEvents++;
        }
      }
      begin = end + 1;
    }
  } catch (error) {
    report.read = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
  } finally {
    await file?.close().catch(() => {
      report.read = "unavailable";
    });
  }
  return report;
}

/** Gateway metadata is untrusted too: only a UUID can join the projected diagnostics. */
export function modelFailureAttempt(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}
