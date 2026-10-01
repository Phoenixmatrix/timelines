import { audit } from "../core/audit.ts";
import { deleteVersion, getDistTags, listVersions } from "../core/catalog.ts";
import type { Services } from "../core/context.ts";
import { listRepos, type Repository } from "../core/repos.ts";

/**
 * Prunes old versions per `config.retention` (`keepLatest`, `maxAgeDays`) for
 * formats whose history lives in the shared catalog. The newest version and
 * anything a dist-tag points at are never pruned. OCI (untagged manifests) and
 * Maven (snapshot builds) apply their own retention on write.
 */
const CATALOG_FORMATS = new Set(["npm", "pypi", "cargo", "go", "helm"]);

export async function applyRetention(
  services: Services,
  now = Date.now(),
): Promise<{ pruned: number }> {
  let pruned = 0;
  for (const repo of await listRepos(services.db)) {
    if (repo.kind !== "local" || !CATALOG_FORMATS.has(repo.format)) continue;
    const { keepLatest, maxAgeDays } = repo.config.retention ?? {};
    if (!keepLatest && !maxAgeDays) continue;
    pruned += await pruneRepo(services, repo, now);
  }
  return { pruned };
}

async function pruneRepo(services: Services, repo: Repository, now: number): Promise<number> {
  const { keepLatest, maxAgeDays } = repo.config.retention ?? {};
  const cutoff = maxAgeDays ? new Date(now - maxAgeDays * 86_400_000).toISOString() : null;
  const packages = await services.db
    .selectFrom("packages")
    .select(["id", "name"])
    .where("repo_id", "=", repo.id)
    .execute();
  let pruned = 0;
  for (const pkg of packages) {
    const versions = await listVersions(services.db, pkg.id);
    if (versions.length <= 1) continue;
    const tagged = new Set(Object.values(await getDistTags(services.db, pkg.id)));
    // Newest first; index 0 is always kept.
    const ordered = [...versions].reverse();
    const doomed = ordered.filter(
      (v, index) =>
        index > 0 &&
        !tagged.has(v.version) &&
        ((keepLatest !== undefined && index >= keepLatest) ||
          (cutoff !== null && v.createdAt < cutoff)),
    );
    for (const version of doomed) {
      await deleteVersion(services.db, version.id);
      pruned++;
    }
    if (doomed.length > 0) {
      await audit(services.db, await services.actor(), "retention.prune", {
        repoId: repo.id,
        target: pkg.name,
        detail: { versions: doomed.map((v) => v.version) },
      });
    }
  }
  if (pruned > 0) await services.repoObject(repo).requestRebuild(repo.id);
  return pruned;
}
