import { describe, expect, test } from "vite-plus/test";
import { promptQueue } from "./queue.ts";

describe("queued prompts", () => {
  test("only the chat a prompt is addressed to can take it, and only once", () => {
    const queue = promptQueue();
    queue.put({ chatId: "new", prompt: "Why is CI slow?" });
    // The conversation that was on screen before can't take the new chat's prompt.
    expect(queue.take("old")).toBeNull();
    expect(queue.take("new")).toBe("Why is CI slow?");
    // A re-run effect or a second render finds nothing to send.
    expect(queue.take("new")).toBeNull();
  });

  test("a later prompt replaces an untaken one; blank prompts never queue", () => {
    const queue = promptQueue();
    expect(queue.put({ chatId: "a", prompt: "   " })).toBe(false);
    expect(queue.peek()).toBeNull();
    queue.put({ chatId: "a", prompt: "first" });
    queue.put({ chatId: "b", prompt: "second" });
    expect(queue.take("a")).toBeNull();
    expect(queue.take("b")).toBe("second");
  });
});
