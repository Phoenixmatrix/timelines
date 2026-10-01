import { DurableObject } from "cloudflare:workers";

/** One per OCI blob upload session; holds resumable state between PATCHes. */
export class UploadDO extends DurableObject<Env> {
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

  override async alarm(): Promise<void> {
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
    await this.ctx.storage.deleteAll();
  }
}
