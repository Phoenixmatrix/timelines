import { DurableObject } from "cloudflare:workers";
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

/** One per OCI blob upload session; holds resumable state between PATCHes. */
export class UploadDO extends DurableObject<Env> implements Purgeable {
  async getState<T>(): Promise<T | null> {
    return (await this.ctx.storage.get<T>("state")) ?? null;
  }

  /** Optimistic write: only succeeds if `expectedVersion` matches. */
  async putState<T extends { version: number }>(
    state: T,
    expectedVersion: number | null,
  ): Promise<boolean> {
    const current = await this.ctx.storage.get<T>("state");
    if ((current?.version ?? null) !== expectedVersion) return false;
    await this.ctx.storage.put("state", state);
    return true;
  }

  async expireAt(at: number): Promise<void> {
    await this.ctx.storage.setAlarm(at);
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  // The purge contract (worker/durable/contract.ts, CORE-197). An upload
  // cleans itself up when it expires; purge and retire only do it sooner.
  async purge(reason: string): Promise<PurgeReport> {
    const report = await this.#clear(reason);
    resetSoon(this.ctx);
    return report;
  }

  async #clear(reason: string): Promise<PurgeReport> {
    await this.#release();
    return clearStorage(this.ctx.storage, reason);
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
        className: "RegistryUpload",
        retirement,
        busy: false,
        purge: (reason) => this.#clear(reason),
      });
      return;
    }
    await this.#release();
    await this.ctx.storage.deleteAll();
  }

  /** The upload's R2 leftovers: its multipart upload and any tails. */
  async #release(): Promise<void> {
    // Shape: UploadState in formats/oci/uploads.ts.
    const state = await this.ctx.storage.get<{
      r2Key?: string;
      r2UploadId?: string | null;
    }>("state");
    if (state?.r2UploadId && state.r2Key) {
      await this.env.REGISTRY_BLOBS.resumeMultipartUpload(state.r2Key, state.r2UploadId)
        .abort()
        .catch(() => undefined);
    }
    if (state?.r2Key) {
      // Tails are `<r2Key>.tail.<uuid>`; a crashed PATCH can leave extra ones.
      const tails = await this.env.REGISTRY_BLOBS.list({ prefix: `${state.r2Key}.tail.` });
      if (tails.objects.length > 0) {
        await this.env.REGISTRY_BLOBS.delete(tails.objects.map((o) => o.key)).catch(
          () => undefined,
        );
      }
    }
  }
}
