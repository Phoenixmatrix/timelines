import { DurableObject } from "cloudflare:workers";

import type { Actor } from "../core/auth/actor.ts";
import { RepoLogic } from "./repo-logic.ts";
import { cacheNpmArchive } from "../manage/archive.ts";
import {
  clearStorage,
  pendingRetirement,
  resetSoon,
  scheduleRetirement,
  settleRetirement,
  storageReport,
  type Purgeable,
  type PurgeReport,
} from "../../worker/durable/contract.ts";

const REBUILD_DELAY_MS = 2_000;

/** One per repository (named by repository id). */
export class RepoDO extends DurableObject<Env> implements Purgeable {
  private readonly logic: RepoLogic;
  private readonly archives = new Map<string, Promise<string>>();

  npmArchive(repoId: string, digest: string): Promise<string> {
    const key = `${repoId}:${digest}`;
    let pending = this.archives.get(key);
    if (!pending) {
      pending = cacheNpmArchive(this.env, repoId, digest).finally(() => this.archives.delete(key));
      this.archives.set(key, pending);
      this.ctx.waitUntil(pending);
    }
    return pending;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.logic = new RepoLogic(env);
  }

  mutate(repoId: string, op: string, payload: unknown, actor?: Actor): Promise<unknown> {
    return this.logic.mutate(repoId, op, payload, actor);
  }

  /**
   * Leading + trailing debounce. A publish after a quiet period rebuilds right
   * away (the caller awaits it, so `helm repo update` / `apt-get update` right
   * after an upload see it); publishes inside the window coalesce into one
   * trailing rebuild shortly after the burst.
   */
  async requestRebuild(repoId: string, delayMs = REBUILD_DELAY_MS): Promise<void> {
    await this.ctx.storage.put("repoId", repoId);
    const last = (await this.ctx.storage.get<number>("lastRebuildAt")) ?? 0;
    if (Date.now() - last >= delayMs) {
      await this.ctx.storage.put("lastRebuildAt", Date.now());
      await this.logic.rebuild(repoId);
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  rebuildNow(repoId: string): Promise<void> {
    return this.logic.rebuild(repoId);
  }

  lease(key: string, ttlMs: number): boolean {
    return this.logic.lease(key, ttlMs);
  }

  release(key: string): void {
    this.logic.release(key);
  }

  // The purge contract (worker/durable/contract.ts, CORE-197). Leases and
  // the rebuild debounce live in storage; the catalog lives in REGISTRY_DB.
  async purge(reason: string): Promise<PurgeReport> {
    const report = await clearStorage(this.ctx.storage, reason);
    resetSoon(this.ctx);
    return report;
  }

  retire(reason: string, name: string, delayMs?: number): Promise<void> {
    return scheduleRetirement(this.ctx.storage, reason, name, delayMs);
  }

  storageReport() {
    return storageReport(this.ctx.storage);
  }

  override async alarm(): Promise<void> {
    const retirement = await pendingRetirement(this.ctx.storage);
    if (retirement) {
      await settleRetirement({
        storage: this.ctx.storage,
        env: this.env,
        className: "RegistryRepo",
        retirement,
        busy: this.archives.size > 0,
        purge: (reason) => clearStorage(this.ctx.storage, reason),
      });
      return;
    }
    const repoId = await this.ctx.storage.get<string>("repoId");
    if (!repoId) return;
    await this.ctx.storage.put("lastRebuildAt", Date.now());
    await this.logic.rebuild(repoId);
  }
}
