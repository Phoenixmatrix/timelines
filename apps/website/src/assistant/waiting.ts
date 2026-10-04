// Whether the chat should show its status line: whenever a turn is under way
// and nothing else on screen shows it working. Running tools show their own
// spinners and streaming text is its own sign; between them, after tool
// results come back and before the next words or call, nothing moves.

interface Part {
  type: string;
  text?: string;
  state?: string;
}
interface Message {
  role: string;
  parts: Part[];
}

const isTool = (part: Part) => part.type.startsWith("tool-") && "toolCallId" in part;
/** States in which a tool's receipt (or approval card) shows it's still going. */
const ACTIVE = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
]);

/**
 * "start" before the reply's first words or tool call; "step" when the reply
 * has stalled between steps; null when nothing is pending or something on
 * screen already shows progress.
 */
export function waitingFor(messages: readonly Message[], busy: boolean): "start" | "step" | null {
  if (!busy) return null;
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return "start";
  const shown = last.parts.filter((p) => (p.type === "text" && p.text?.trim()) || isTool(p));
  const tail = shown[shown.length - 1];
  if (!tail) return "start";
  if (shown.some((p) => isTool(p) && ACTIVE.has(p.state ?? ""))) return null;
  if (tail.type === "text" && tail.state === "streaming") return null;
  return "step";
}
