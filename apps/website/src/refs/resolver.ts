// The client side of ref resolution (CORE-22): every ref a page renders asks
// here, and the asks of one render are sent as one POST /api/refs/resolve per
// context. Answers are kept briefly, so revisiting a page doesn't flash, and
// a failure resolves to nothing: the text simply stays text.

import { useEffect, useMemo, useState } from "react";
import {
  REF_LIMITS,
  type RefContext,
  type RefResolution,
  type ResolveRefsResponse,
} from "../../shared/refs.ts";
import { api } from "../lib/api.ts";

/** How long an answer is reused. Access changes apply after this at the latest. */
const FRESH_MS = 60_000;
/** A failed batch isn't retried for this long. */
const FAILED_MS = 10_000;

type Entry = { at: number; ttl: number; value: RefResolution | null };

const answers = new Map<string, Entry>();
const pending = new Map<string, Promise<RefResolution | null>>();
const queued = new Map<
  string,
  { context: RefContext; refs: Map<string, (value: RefResolution | null) => void> }
>();
let flushing: ReturnType<typeof setTimeout> | null = null;

/** The cache key of a context: refs resolve differently on different pages. */
export function contextKey(context: RefContext): string {
  return `${context.owner ?? ""}/${context.repo ?? ""}#${context.tracker ?? ""}`;
}

/** TESTS ONLY: forget every answer (a new world is a new viewer). */
export function resetRefResolutions() {
  answers.clear();
  pending.clear();
  queued.clear();
  if (flushing) clearTimeout(flushing);
  flushing = null;
}

/** A kept answer still fresh enough to show, or undefined. */
export function cachedResolution(
  ref: string,
  context: RefContext,
): RefResolution | null | undefined {
  const entry = answers.get(`${contextKey(context)}\n${ref}`);
  if (!entry) return undefined;
  if (Date.now() - entry.at > entry.ttl) return undefined;
  return entry.value;
}

async function send(context: RefContext, refs: string[]): Promise<(RefResolution | null)[]> {
  const out: (RefResolution | null)[] = [];
  for (let start = 0; start < refs.length; start += REF_LIMITS.refs) {
    const chunk = refs.slice(start, start + REF_LIMITS.refs);
    const { results } = await api<ResolveRefsResponse>("/refs/resolve", {
      method: "POST",
      json: { refs: chunk, context },
    });
    out.push(...results);
  }
  return out;
}

function flush() {
  flushing = null;
  const batches = [...queued.values()];
  queued.clear();
  for (const { context, refs } of batches) {
    const list = [...refs.keys()];
    const key = contextKey(context);
    void send(context, list).then(
      (results) => {
        list.forEach((ref, i) => {
          const value = results[i] ?? null;
          answers.set(`${key}\n${ref}`, { at: Date.now(), ttl: FRESH_MS, value });
          pending.delete(`${key}\n${ref}`);
          refs.get(ref)!(value);
        });
      },
      () => {
        for (const ref of list) {
          answers.set(`${key}\n${ref}`, { at: Date.now(), ttl: FAILED_MS, value: null });
          pending.delete(`${key}\n${ref}`);
          refs.get(ref)!(null);
        }
      },
    );
  }
}

/** Resolve one ref; asks made in the same tick share one request. */
export function resolveRef(ref: string, context: RefContext): Promise<RefResolution | null> {
  const cached = cachedResolution(ref, context);
  if (cached !== undefined) return Promise.resolve(cached);
  const key = `${contextKey(context)}\n${ref}`;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const promise = new Promise<RefResolution | null>((resolve) => {
    const batch = queued.get(contextKey(context)) ?? { context, refs: new Map() };
    batch.refs.set(ref, resolve);
    queued.set(contextKey(context), batch);
  });
  pending.set(key, promise);
  flushing ??= setTimeout(flush, 0);
  return promise;
}

/**
 * Answers for rendering, one per ref: null until they arrive (and when they
 * fail or there is nothing), so the plain text shows first and only gains links.
 */
export function useRefResolutions(refs: string[], context: RefContext): (RefResolution | null)[] {
  const key = contextKey(context);
  const list = refs.join("\n");
  const [settled, setSettled] = useState(0);
  const values = useMemo(
    () => refs.map((ref) => cachedResolution(ref, context) ?? null),
    // refs and context are fully described by list and key; settled re-reads the cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, key, settled],
  );
  useEffect(() => {
    if (!list) return;
    const wanted = list.split("\n");
    if (wanted.every((ref) => cachedResolution(ref, context) !== undefined)) return;
    let live = true;
    void Promise.all(wanted.map((ref) => resolveRef(ref, context))).then(() => {
      if (live) setSettled((n) => n + 1);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, key]);
  return values;
}

/** One ref's answer for rendering (see useRefResolutions). */
export function useRefResolution(ref: string, context: RefContext): RefResolution | null {
  return useRefResolutions([ref], context)[0] ?? null;
}
