// Server-Timing for API responses: open devtools' network panel to see where
// a request spent its time (binding calls, cache hits, ls-refs).
//
// The Workers clock only advances across I/O, so an entry measures the waits
// (Durable Object RPCs, D1, Secrets Store); pure CPU work reads as about 0 ms.

export class Timing {
  #entries: { name: string; ms: number; desc?: string }[] = [];
  #counts = new Map<string, number>();
  #tallies = new Map<string, { unit: string; n: number; ms: number }>();
  #start = performance.now();

  async measure<T>(name: string, work: PromiseLike<T>, desc?: string): Promise<T> {
    const start = performance.now();
    try {
      return await work;
    } finally {
      this.#entries.push({ name, ms: performance.now() - start, desc });
    }
  }

  /** Synchronous work, such as constructing a library instance. */
  measureSync<T>(name: string, work: () => T): T {
    const start = performance.now();
    try {
      return work();
    } finally {
      this.#entries.push({ name, ms: performance.now() - start });
    }
  }

  /**
   * One entry per kind of call however many are made (a loop over Spaces must
   * not grow the header): how many, and their summed time, which exceeds wall
   * time when they overlap.
   */
  async tally<T>(name: string, unit: string, work: PromiseLike<T>): Promise<T> {
    const start = performance.now();
    try {
      return await work;
    } finally {
      const tally = this.#tallies.get(name) ?? { unit, n: 0, ms: 0 };
      tally.n++;
      tally.ms += performance.now() - start;
      this.#tallies.set(name, tally);
    }
  }

  count(name: string) {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + 1);
  }

  header(): string {
    const parts = this.#entries.map(
      (e, i) => `${e.name};desc="${e.desc ?? `${e.name} #${i + 1}`}";dur=${e.ms.toFixed(1)}`,
    );
    for (const [name, n] of this.#counts) parts.push(`${name};desc="${name} x${n}"`);
    for (const [name, { unit, n, ms }] of this.#tallies)
      parts.push(`${name};desc="${n} ${unit} (summed)";dur=${ms.toFixed(1)}`);
    parts.push(`total;dur=${(performance.now() - this.#start).toFixed(1)}`);
    return parts.join(", ");
  }
}

/** The Timing the Worker's fetch entry started for a request, so `total` covers it all. */
const started = new WeakMap<Request, Timing>();

export function startTiming(request: Request): Timing {
  const timing = new Timing();
  started.set(request, timing);
  return timing;
}

export function timingFor(request: Request): Timing | undefined {
  return started.get(request);
}

const statements = new WeakMap<object, D1PreparedStatement>();

function timedStatement(statement: D1PreparedStatement, timing: Timing): D1PreparedStatement {
  const proxy = new Proxy(statement, {
    get(target, property) {
      if (property === "bind")
        return (...values: unknown[]) => timedStatement(target.bind(...values), timing);
      if (property === "first" || property === "all" || property === "run" || property === "raw")
        return (...args: unknown[]) =>
          timing.tally(
            "d1",
            "queries",
            (target[property] as (...a: unknown[]) => Promise<unknown>).apply(target, args),
          );
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  statements.set(proxy, statement);
  return proxy;
}

/**
 * A D1 binding that tallies its round trips (`d1;desc="n queries (summed)"`) on
 * `timing`. Per request: wrap the binding a handler is given, never the shared env.
 */
export function timedD1(d1: D1Database, timing: Timing): D1Database {
  return new Proxy(d1, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => timedStatement(target.prepare(query), timing);
      if (property === "batch")
        return (batch: D1PreparedStatement[]) =>
          timing.tally(
            "d1",
            "queries",
            target.batch(batch.map((statement) => statements.get(statement) ?? statement)),
          );
      if (property === "exec")
        return (query: string) => timing.tally("d1", "queries", target.exec(query));
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** This request's view of `env` with its D1 database timed; other bindings are inherited. */
export function timedEnv(env: Env, timing: Timing): Env {
  return Object.create(env, { DB: { value: timedD1(env.DB, timing) } }) as Env;
}

/** Tally a Durable Object RPC (`do;desc="n calls (summed)"`) when a request is timed. */
export async function timedCall<W extends PromiseLike<unknown>>(
  timing: Timing | undefined,
  work: W,
): Promise<Awaited<W>> {
  return (await (timing ? timing.tally("do", "calls", work) : work)) as Awaited<W>;
}
