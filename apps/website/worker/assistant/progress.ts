// Between a turn's steps the orchestrator reads tool results and decides what
// to do next, which can take seconds with nothing streaming. The chat shows a
// generic status at once, then a few words from a small model about what's
// happening, written from what the turn has done so far.

import { toolLabel } from "../../shared/assistant.ts";
import { sentenceCase } from "./titles.ts";

/** The generic status, shown until (or instead of) a model-written one. */
export const WORKING = "Thinking";

export interface ProgressStep {
  text?: string;
  toolCalls?: ReadonlyArray<{ toolName: string; input?: unknown; toolCallId?: string }>;
  toolResults?: ReadonlyArray<{ toolCallId?: string; output?: unknown }>;
}

export const PROGRESS_INSTRUCTIONS =
  "You write the one-line status shown while an assistant works on a person's request. " +
  "From the request and what the assistant just did, say what it is doing now, in 2 to 6 words, " +
  "starting with a verb ending in -ing, e.g. “Comparing the failing jobs” or “Checking who owns CORE-12”. " +
  "Reply with the status only: no quotes, no trailing punctuation.";

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

function brief(output: unknown): string {
  if (output === undefined || output === null) return "";
  try {
    return clip(typeof output === "string" ? output : JSON.stringify(output), 400);
  } catch {
    return "";
  }
}

/** What the status model reads: the request and the last step, small enough to answer fast. */
export function progressPrompt(request: string, step: ProgressStep): string {
  const results = new Map(
    (step.toolResults ?? []).map((result) => [result.toolCallId, result.output]),
  );
  const did = (step.toolCalls ?? []).slice(0, 6).map((call) => {
    const label = toolLabel(call.toolName, (call.input ?? {}) as Record<string, unknown>);
    const result = brief(results.get(call.toolCallId));
    return result ? `- ${label}\n  Result: ${result}` : `- ${label}`;
  });
  return [
    `Request: ${clip(request.trim(), 600)}`,
    did.length ? `Just did:\n${did.join("\n")}` : "",
    step.text?.trim() ? `Just said: ${clip(step.text.trim(), 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A continued reply's last step, from the transcript: a continuation (after
 * an approval or a page opening) starts a new turn whose previous step's tool
 * results are only in the message.
 */
export function stepFromMessage(
  message:
    | {
        parts: ReadonlyArray<{
          type: string;
          text?: string;
          toolCallId?: string;
          input?: unknown;
          output?: unknown;
        }>;
      }
    | undefined,
): ProgressStep | null {
  const parts = message?.parts ?? [];
  const lastStep = parts.findLastIndex((part) => part.type === "step-start");
  const step = parts.slice(lastStep + 1);
  // An approved write hasn't run yet: there's nothing to describe until it has.
  const tools = step.filter(
    (part) => part.type.startsWith("tool-") && part.toolCallId && part.output !== undefined,
  );
  if (!tools.length) return null;
  return {
    text: step.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""),
    toolCalls: tools.map((part) => ({
      toolName: part.type.slice("tool-".length),
      toolCallId: part.toolCallId,
      input: part.input,
    })),
    toolResults: tools.map((part) => ({ toolCallId: part.toolCallId, output: part.output })),
  };
}

/** The model's reply as a status line, or null when it isn't one. */
export function cleanStatus(reply: string): string | null {
  const line = (reply.trim().split("\n")[0] ?? "")
    .replace(/^status:\s*/i, "")
    .replace(/["“”*`]/g, "")
    .replace(/[.…:;!,\s]+$/u, "")
    .trim();
  const words = line.split(/\s+/).filter(Boolean);
  if (!line || words.length > 8 || line.length > 60) return null;
  return sentenceCase(line.charAt(0).toUpperCase() + line.slice(1));
}
