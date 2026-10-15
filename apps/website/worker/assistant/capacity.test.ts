import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { APICallError, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { assistantCapacity } from "./capacity.ts";

function refusal(message = "3021: rate limiting: inference request per min rate reached") {
  return new APICallError({
    message,
    url: "workers-ai:binding/run/@cf/zai-org/glm-5.3-flash",
    requestBodyValues: {},
    isRetryable: false,
  });
}

function wrap(model: MockLanguageModelV4) {
  return wrapLanguageModel({ model, middleware: assistantCapacity });
}

function empty() {
  return { stream: new ReadableStream<never>({ start: (controller) => controller.close() }) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("assistant binding capacity", () => {
  test("preserves the SDK's default retry recovery for ordinary 503 errors", async () => {
    const unavailable = new APICallError({
      message: "Service unavailable",
      url: "workers-ai:binding/run/model",
      requestBodyValues: {},
      statusCode: 503,
    });
    let attempts = 0;
    const source = new MockLanguageModelV4({
      doStream: async () => {
        if (++attempts === 1) throw unavailable;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "answer" });
              controller.enqueue({ type: "text-delta", id: "answer", delta: "Recovered" });
              controller.enqueue({ type: "text-end", id: "answer" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const result = streamText({ model: wrap(source), prompt: "hello" });
    const recovered = expect(result.text).resolves.toBe("Recovered");
    await vi.advanceTimersByTimeAsync(10_000);
    await recovered;
    expect(attempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("the SDK does not multiply exhausted non-retryable 3021 acquisition attempts", async () => {
    const error = refusal();
    const source = new MockLanguageModelV4({
      doStream: async () => {
        throw error;
      },
    });
    const result = streamText({ model: wrap(source), prompt: "hello" });
    const errors: unknown[] = [];
    const consumed = (async () => {
      for await (const part of result.fullStream) {
        if (part.type === "error") errors.push(part.error);
      }
    })();
    await vi.advanceTimersByTimeAsync(180_000);
    await consumed;
    expect(errors).toEqual([error]);
    expect(source.doStreamCalls).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("recovers acquisition after waiting 5s", async () => {
    const result = empty();
    const source = new MockLanguageModelV4({
      doStream: vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce(result),
    });
    const model = wrap(source);
    const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];
    const pending = model.doStream({ prompt });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(source.doStreamCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(result);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("exhausts four attempts at 0, 5, 20 and 65 seconds and preserves the error", async () => {
    const error = refusal();
    const source = new MockLanguageModelV4({
      doStream: async () => {
        throw error;
      },
    });
    const pending = expect(wrap(source).doStream({ prompt: [] })).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(65_000);
    await pending;
    expect(source.doStreamCalls).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    refusal("3040: out of capacity"),
    new APICallError({
      message: "3021: rate limiting: inference request per min rate reached",
      url: "https://another-provider.example/model",
      requestBodyValues: {},
    }),
  ])("does not retry unrelated errors: %s", async (error) => {
    const source = new MockLanguageModelV4({
      doStream: async () => {
        throw error;
      },
    });
    await expect(wrap(source).doStream({ prompt: [] })).rejects.toBe(error);
    expect(source.doStreamCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("Stop aborts backoff immediately and makes no further call", async () => {
    const controller = new AbortController();
    const source = new MockLanguageModelV4({
      doStream: async () => {
        throw refusal();
      },
    });
    const reason = new DOMException("Stopped", "AbortError");
    const pending = expect(
      wrap(source).doStream({ prompt: [], abortSignal: controller.signal }),
    ).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(reason);
    await pending;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(source.doStreamCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("already stopped turns never invoke the provider", async () => {
    const reason = new DOMException("Stopped", "AbortError");
    const source = new MockLanguageModelV4();
    await expect(
      wrap(source).doStream({ prompt: [], abortSignal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(source.doStreamCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("acquisition deadline aborts the binding signal at 90s", async () => {
    const source = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        const { promise, reject } = Promise.withResolvers<{ stream: ReadableStream<never> }>();
        abortSignal!.addEventListener("abort", () => reject(abortSignal!.reason), { once: true });
        return promise;
      },
    });
    const pending = expect(wrap(source).doStream({ prompt: [] })).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await pending;
    expect(source.doStreamCalls).toHaveLength(1);
    expect(source.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
  });

  test("returned streams retain Stop but not the acquisition deadline", async () => {
    const controller = new AbortController();
    const source = new MockLanguageModelV4({ doStream: empty() });
    await wrap(source).doStream({ prompt: [], abortSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(90_000);
    const signal = source.doStreamCalls[0]?.abortSignal;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  test("never replays a returned stream, even if it fails after text or a tool call", async () => {
    const error = refusal();
    const source = new MockLanguageModelV4({
      doStream: {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", id: "text", delta: "partial" });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "write",
              toolName: "write",
              input: "{}",
            });
          },
          pull(controller) {
            controller.error(error);
          },
        }),
      },
    });
    const { stream } = await wrap(source).doStream({ prompt: [] });
    const reader = stream.getReader();
    expect((await reader.read()).value?.type).toBe("text-delta");
    expect((await reader.read()).value?.type).toBe("tool-call");
    await expect(reader.read()).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(source.doStreamCalls).toHaveLength(1);
  });
});
