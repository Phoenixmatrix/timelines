import { DurableObject } from "cloudflare:workers";
import {
  withCutoverAdmission,
  withCutoverAlarmAdmission,
} from "../../worker/durable/cutover-admission.ts";
import { reportCutoverRuntime } from "../../worker/durable/cutover-runtime.ts";

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

  cutoverRuntime(runId: string) {
    return reportCutoverRuntime(this.env, runId, "registry-repo");
  }

  npmArchive(repoId: string, digest: string): Promise<string> {
    return withCutoverAdmission(this.env, "registry-repo", async () => {
      const key = `${repoId}:${digest}`;
      let pending = this.archives.get(key);
      if (!pending) {
        pending = cacheNpmArchive(this.env, repoId, digest).finally(() =>
          this.archives.delete(key),
        );
        this.archives.set(key, pending);
      }
      return pending;
    });
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.logic = new RepoLogic(env);
  }

  mutate(repoId: string, op: string, payload: unknown, actor?: Actor): Promise<unknown> {
    return withCutoverAdmission(this.env, "registry-repo", () =>
      this.logic.mutate(repoId, op, payload, actor),
    );
  }

  /**
   * Leading + trailing debounce. A publish after a quiet period rebuilds right
   * away (the caller awaits it, so `helm repo update` / `apt-get update` right
   * after an upload see it); publishes inside the window coalesce into one
   * trailing rebuild shortly after the burst.
   */
  async requestRebuild(repoId: string, delayMs = REBUILD_DELAY_MS): Promise<void> {
    return withCutoverAdmission(this.env, "registry-repo", async () => {
      await this.ctx.storage.put("repoId", repoId);
      const last = (await this.ctx.storage.get<number>("lastRebuildAt")) ?? 0;
      if (Date.now() - last >= delayMs) {
        await this.ctx.storage.put("lastRebuildAt", Date.now());
        await this.logic.rebuild(repoId);
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
    });
  }

  rebuildNow(repoId: string): Promise<void> {
    return withCutoverAdmission(this.env, "registry-repo", () => this.logic.rebuild(repoId));
  }

  lease(key: string, ttlMs: number): Promise<boolean> {
    return withCutoverAdmission(this.env, "registry-repo", async () =>
      this.logic.lease(key, ttlMs),
    );
  }

  release(key: string): Promise<void> {
    return withCutoverAdmission(this.env, "registry-repo", async () => this.logic.release(key));
  }

  // The purge contract (worker/durable/contract.ts, CORE-197). Leases and
  // the rebuild debounce live in storage; the catalog lives in REGISTRY_DB.
  async purge(reason: string): Promise<PurgeReport> {
    const report = await withCutoverAdmission(this.env, "registry-repo", () =>
      clearStorage(this.ctx.storage, reason),
    );
    resetSoon(this.ctx);
    return report;
  }

  retire(reason: string, name: string, delayMs?: number): Promise<void> {
    return withCutoverAdmission(this.env, "registry-repo", () =>
      scheduleRetirement(this.ctx.storage, reason, name, delayMs),
    );
  }

  storageReport() {
    return withCutoverAdmission(this.env, "registry-repo", () => storageReport(this.ctx.storage));
  }

  override async alarm(): Promise<void> {
    return withCutoverAlarmAdmission(this.env, "registry-repo", this.ctx.storage, async () => {
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
    });
  }
}
