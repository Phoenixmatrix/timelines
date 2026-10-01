import { SYSTEM_ACTOR } from "../core/auth/system.ts";
import type { Actor } from "../core/auth/actor.ts";
import { Services, withServices } from "../core/context.ts";
import { RegistryError } from "../core/errors.ts";
import { getRepoById } from "../core/repos.ts";
import { formatModule } from "../formats/index.ts";

/**
 * What a repository's Durable Object does, without the Durable Object: kept
 * free of `cloudflare:*` imports so tests can run it in-process. One instance
 * per repository serializes mutations and index rebuilds with a promise-chain
 * mutex (DO input gates alone do not stop interleaving across D1 awaits).
 */
export class RepoLogic {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly leases = new Map<string, number>();

  private readonly env: Env;
  constructor(env: Env) {
    this.env = env;
  }

  private services(actor: Actor = SYSTEM_ACTOR): Services {
    return new Services(
      this.env,
      new Request("https://repo-object.internal/"),
      () => undefined,
      `do-${crypto.randomUUID()}`,
      actor,
    );
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * `actor` is whoever asked: the mutation runs as them, so the publish gate
   * and provenance (which read the request in scope) see the real publisher
   * and not the object itself.
   */
  mutate(repoId: string, op: string, payload: unknown, actor?: Actor): Promise<unknown> {
    return this.serialize(async () => {
      const services = this.services(actor);
      const repo = await getRepoById(services.db, repoId);
      if (!repo) throw RegistryError.notFound("Repository not found");
      const handler = formatModule(repo.format).mutations?.[op];
      if (!handler) throw new RegistryError("internal", `No mutation ${op} for ${repo.format}`);
      return actor
        ? withServices(services, () => handler(services, repo, payload))
        : handler(services, repo, payload);
    });
  }

  rebuild(repoId: string): Promise<void> {
    return this.serialize(async () => {
      const services = this.services();
      const repo = await getRepoById(services.db, repoId);
      if (!repo) return;
      await formatModule(repo.format).rebuild?.(services, repo);
    });
  }

  /** Single-flight for remote fetches: true if the caller now holds `key`. */
  lease(key: string, ttlMs: number): boolean {
    const now = Date.now();
    const until = this.leases.get(key);
    if (until && until > now) return false;
    this.leases.set(key, now + ttlMs);
    return true;
  }

  release(key: string): void {
    this.leases.delete(key);
  }
}
