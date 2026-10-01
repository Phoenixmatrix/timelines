import { actorLabel, type Actor } from "./auth/actor.ts";
import { nowIso, type DB } from "./db.ts";
import { ulid } from "./ids.ts";

export async function audit(
  db: DB,
  actor: Actor,
  action: string,
  entry: { repoId?: string | null; target?: string | null; detail?: Record<string, unknown> } = {},
): Promise<void> {
  await db
    .insertInto("audit_log")
    .values({
      id: ulid(),
      at: nowIso(),
      actor: actorLabel(actor),
      action,
      repo_id: entry.repoId ?? null,
      target: entry.target ?? null,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute();
}
