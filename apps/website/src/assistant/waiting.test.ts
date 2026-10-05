import { describe, expect, test } from "vite-plus/test";
import { waitingFor } from "./waiting.ts";

const user = { role: "user", parts: [{ type: "text", text: "Why did CI fail?" }] };
const tool = (state: string) => ({ type: "tool-ci_run", toolCallId: "call-1", state });
const reply = (...parts: { type: string; text?: string; state?: string }[]) => ({
  role: "assistant",
  parts: [{ type: "step-start" }, ...parts],
});

describe("the chat's status line", () => {
  test("shows from the moment a message is sent until the reply starts", () => {
    expect(waitingFor([user], true)).toBe("start");
    expect(waitingFor([user, reply()], true)).toBe("start");
    expect(waitingFor([user, reply({ type: "text", text: "  " })], true)).toBe("start");
  });

  test("shows between steps, once tool results are in and nothing new has arrived", () => {
    expect(waitingFor([user, reply(tool("output-available"))], true)).toBe("step");
    expect(waitingFor([user, reply(tool("output-error"))], true)).toBe("step");
    expect(
      waitingFor(
        [
          user,
          reply({ type: "text", text: "Let me look.", state: "done" }, tool("output-available"), {
            type: "step-start",
          }),
        ],
        true,
      ),
    ).toBe("step");
  });

  test("stays out of the way while a tool runs or words stream", () => {
    expect(waitingFor([user, reply(tool("input-streaming"))], true)).toBeNull();
    expect(
      waitingFor([user, reply(tool("output-available"), tool("input-available"))], true),
    ).toBeNull();
    expect(waitingFor([user, reply(tool("approval-requested"))], true)).toBeNull();
    // An approved write spins in its receipt until it runs.
    expect(waitingFor([user, reply(tool("approval-responded"))], true)).toBeNull();
    expect(
      waitingFor(
        [user, reply(tool("output-available"), { type: "text", text: "The", state: "streaming" })],
        true,
      ),
    ).toBeNull();
  });

  test("never shows once the turn is over", () => {
    expect(waitingFor([user], false)).toBeNull();
    expect(waitingFor([user, reply(tool("output-available"))], false)).toBeNull();
  });
});
