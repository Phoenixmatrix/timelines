import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeDurableState } from "../testing/durable-state.ts";
import { OperatorAuthStore } from "./operator-auth-store.ts";

const correct = "a".repeat(64);
const wrong = "b".repeat(64);
const firstSession = "c".repeat(64);
const secondSession = "d".repeat(64);
const close: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
});
afterEach(() => {
  for (const dispose of close.splice(0)) dispose();
  vi.useRealTimers();
});
function fixture() {
  const state = fakeDurableState({ name: "operator-auth" });
  close.push(() => state.db.close());
  return () => new OperatorAuthStore(state.ctx);
}

test("an emailed challenge is single-use and its session is scoped and expires across journal reconstruction", () => {
  const store = fixture();
  store().issue("run", "human", "challenge", correct);
  expect(store().verify("run", "human", "challenge", correct, firstSession)?.expiresAt).toBe(
    Date.now() + 15 * 60_000,
  );
  expect(store().verify("run", "human", "challenge", correct, secondSession)).toBeNull();
  expect(store().session("run", "human", firstSession)).toBe(true);
  expect(store().session("another-run", "human", firstSession)).toBe(false);
  expect(store().session("run", "another-human", firstSession)).toBe(false);
  vi.advanceTimersByTime(15 * 60_000);
  expect(store().session("run", "human", firstSession)).toBe(false);
});

test("failed guesses commit, survive reconstruction and cannot be reset by requesting another email", () => {
  const store = fixture();
  store().issue("run", "human", "first", correct);
  for (let attempt = 0; attempt < 4; attempt++)
    expect(store().verify("run", "human", "first", wrong, firstSession)).toBeNull();
  expect(() => store().issue("run", "human", "resend", correct)).toThrow("temporarily limited");
  vi.advanceTimersByTime(60_000);
  store().issue("run", "human", "resend", correct);
  expect(store().verify("run", "human", "resend", wrong, firstSession)).toBeNull();
  expect(store().verify("run", "human", "resend", correct, firstSession)).toBeNull();
  expect(() => store().issue("next-run", "human", "new", correct)).toThrow("temporarily limited");
  vi.advanceTimersByTime(15 * 60_000);
  store().issue("next-run", "human", "new", correct);
  expect(store().verify("next-run", "human", "new", correct, firstSession)?.expiresAt).toBe(
    Date.now() + 15 * 60_000,
  );
});

test("expired or superseded challenges cannot create a session", () => {
  const store = fixture();
  store().issue("run", "human", "old", correct);
  vi.advanceTimersByTime(10 * 60_000);
  expect(store().verify("run", "human", "old", correct, firstSession)).toBeNull();
  store().issue("run", "human", "new", correct);
  expect(store().verify("run", "human", "old", correct, firstSession)).toBeNull();
  expect(store().session("run", "human", firstSession)).toBe(false);
  expect(store().verify("run", "human", "new", correct, secondSession)?.expiresAt).toBe(
    Date.now() + 15 * 60_000,
  );
});

test("a new human login revokes the previous maintenance credential", () => {
  const store = fixture();
  store().issue("run", "human", "first", correct);
  store().verify("run", "human", "first", correct, firstSession);
  vi.advanceTimersByTime(60_000);
  store().issue("run", "human", "second", correct);
  store().verify("run", "human", "second", correct, secondSession);
  expect(store().session("run", "human", firstSession)).toBe(false);
  expect(store().session("run", "human", secondSession)).toBe(true);
});
