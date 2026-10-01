// Server-Timing for API responses: open devtools' network panel to see where
// a request spent its time (binding calls, cache hits, ls-refs).

export class Timing {
  #entries: { name: string; ms: number }[] = [];
  #counts = new Map<string, number>();
  #start = performance.now();

  async measure<T>(name: string, work: Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await work;
    } finally {
      this.#entries.push({ name, ms: performance.now() - start });
    }
  }

  count(name: string) {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + 1);
  }

  header(): string {
    const parts = this.#entries.map(
      (e, i) => `${e.name};desc="${e.name} #${i + 1}";dur=${e.ms.toFixed(1)}`,
    );
    for (const [name, n] of this.#counts) parts.push(`${name};desc="${name} x${n}"`);
    parts.push(`total;dur=${(performance.now() - this.#start).toFixed(1)}`);
    return parts.join(", ");
  }
}
