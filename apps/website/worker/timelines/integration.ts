import type { Landing, LandingRepo } from "../../shared/timelines.ts";
import type { SourceSnapshot } from "../../shared/code-source.ts";
import { getWorkSource } from "./sources.ts";
import { lsRefs } from "../artifacts.ts";

export type ReadParents = (oid: string) => Promise<readonly string[] | null>;

/** One operation's immutable metadata, isolated by physical repository.
 * Keep capabilities with their caller; never cache absence, errors or provenance. */
export class RevisionMetadata {
  private readonly repos = new Map<string, Map<string, ArtifactsCommitMetadata>>();

  reader(name: string, repo: Pick<ArtifactsRepo, "readCommit">) {
    let commits = this.repos.get(name);
    if (!commits) this.repos.set(name, (commits = new Map()));
    return async (oid: string): Promise<ArtifactsCommitMetadata | null> => {
      const known = commits.get(oid);
      if (known) return known;
      const commit = await repo.readCommit(oid);
      if (commit) commits.set(oid, commit);
      return commit;
    };
  }
}

/** Exhaustive closure: unavailable objects are uncertainty, never negative evidence. */
export async function revisionClosure(head: string, read: ReadParents): Promise<Set<string>> {
  const seen = new Set<string>();
  const pending = [head];
  while (pending.length) {
    const oid = pending.pop()!;
    if (seen.has(oid)) continue;
    const parents = await read(oid);
    if (!parents) throw new Error(`blocked_dependency: revision ${oid} is unavailable`);
    seen.add(oid);
    pending.push(...parents);
  }
  return seen;
}

export interface IntegrationReceipt {
  id: string;
  landing_id: string;
  checkpoint_id: string;
  repo_id: string;
  source_id: string;
  source_commit: string;
  source_tree: string;
  logical_base_json: string;
  dependencies_json: string;
  canonical_base: string;
  canonical_commit: string;
  canonical_tree: string;
  noop: number;
  status: "intent" | "integrated" | "complete";
}

export async function receiptFor(env: Env, landingId: string, repoId: string) {
  return env.DB.prepare(
    "SELECT * FROM source_integration_receipts WHERE landing_id=? AND repo_id=?",
  )
    .bind(landingId, repoId)
    .first<IntegrationReceipt>();
}

export async function admittedReceipts(env: Env, source: SourceSnapshot, canonical: Set<string>) {
  const result = await env.DB.prepare(`SELECT r.* FROM source_integration_receipts r
    JOIN source_integration_members m ON m.receipt_id=r.id
    WHERE m.repo_id=? AND m.source_id=? AND m.commit_oid=? AND r.status='complete'`)
    .bind(source.repoId, source.sourceId, source.commit)
    .all<IntegrationReceipt>();
  return result.results.filter((r) => canonical.has(r.canonical_commit));
}

/** Checkpoint chooses B; moving main can invalidate its proof, never select another B. */
export async function validateDependencies(
  env: Env,
  repo: LandingRepo,
  canonical: Set<string>,
  metadata = new RevisionMetadata(),
) {
  if (!repo.source || !repo.logicalBase || !repo.dependencies)
    throw new Error("migration_required: renew checkpoint with owned source metadata");
  const base = repo.logicalBase;
  const required = [
    ...(base.kind === "timeline-work" && base.sourceId !== repo.source.sourceId ? [base] : []),
    ...repo.dependencies.map((d) => d.source),
  ];
  for (const dependency of required) {
    const receipts = await admittedReceipts(env, dependency, canonical);
    if (receipts.length !== 1)
      throw new Error(
        "blocked_dependency: dependency needs one completed exact integration on current canonical history",
      );
  }
  if (!repo.dependencies.length) return;
  // Imported foreign snapshots must all be included in the explicitly reviewed base's graph.
  // OID equality is qualified by a durable source membership receipt, never change-id equality.
  const baseline = await admittedReceipts(env, base, canonical);
  if (baseline.length !== 1)
    throw new Error("blocked_dependency: reviewed logical base is not uniquely integrated");
  const owner = await getWorkSource(env, repo.id, repo.source.sourceId);
  if (!owner || owner.state === "purged" || owner.state === "purging")
    throw new Error("blocked_dependency: logical base source is unavailable");
  using artifacts = await env.ARTIFACTS.get(owner.artifacts_name);
  const readCommit = metadata.reader(owner.artifacts_name, artifacts);
  const closure = await revisionClosure(
    base.commit,
    async (oid) => (await readCommit(oid))?.parents ?? null,
  );
  if (repo.dependencies.some((dependency) => !closure.has(dependency.source.commit)))
    throw new Error(
      "blocked_dependency: incomparable foreign baselines; explicitly sync/rebase and renew approval",
    );
}

/** Attribution is first service-recorded provenance, not where Git objects were authored. */
async function acknowledgedLocalRevision(
  env: Env,
  source: Pick<SourceSnapshot, "repoId" | "sourceId">,
  oid: string,
): Promise<boolean> {
  const member = await env.DB.prepare(`SELECT m.commit_oid FROM source_progress_members m
    JOIN source_revision_origins origin ON origin.repo_id=m.repo_id
      AND origin.commit_oid=m.commit_oid AND origin.source_id=m.source_id
    WHERE m.repo_id=? AND m.source_id=? AND m.commit_oid=?
      AND (EXISTS (
        SELECT 1 FROM source_operations o
        WHERE o.repo_id=m.repo_id AND o.source_id=m.source_id AND o.kind='push' AND o.state='accepted'
          AND (o.id=m.operation_id OR EXISTS (
            SELECT 1 FROM json_each(o.data,'$.commands') command
            WHERE json_extract(command.value,'$.new')=m.commit_oid)))
        OR EXISTS (
          SELECT 1 FROM source_operations o
          WHERE o.id=m.operation_id AND o.repo_id=m.repo_id AND o.source_id=m.source_id
            AND o.kind='push' AND o.state='rejected'
            AND json_extract(o.data,'$.recovery.outcome')='rejected'
            AND json_extract(o.data,'$.recovery.commit')=m.commit_oid
            AND json_extract(o.data,'$.recovery.head')=m.commit_oid)
        OR EXISTS (
          SELECT 1 FROM timeline_work_sources s
          WHERE s.repo_id=m.repo_id AND s.source_id=m.source_id
            AND s.allocation_operation_id=m.operation_id AND s.state IN ('ready','archived')))`)
    .bind(source.repoId, source.sourceId, oid)
    .first<{ commit_oid: string }>();
  return member !== null;
}

/** Native merges cannot silently bypass the checkpoint's reviewed dependency edges. */
export async function validateMergeEdges(
  env: Env,
  source: Pick<SourceSnapshot, "repoId" | "sourceId">,
  head: string,
  base: string,
  dependencies: readonly string[],
  read: ReadParents,
  canonical: ReadonlySet<string>,
) {
  const baseline = await revisionClosure(base, read);
  const covered = new Set(baseline);
  // Current canonical ancestry is already admitted independently of whichever
  // work source first observed it. Explicit dependencies are checked separately.
  for (const oid of canonical) covered.add(oid);
  for (const dependency of dependencies)
    for (const oid of await revisionClosure(dependency, read)) covered.add(oid);
  const local = new Map<string, boolean>();
  const acknowledged = async (oid: string): Promise<boolean> => {
    const cached = local.get(oid);
    if (cached !== undefined) return cached;
    const result = await acknowledgedLocalRevision(env, source, oid);
    local.set(oid, result);
    return result;
  };
  for (const oid of await revisionClosure(head, read)) {
    if (baseline.has(oid)) continue;
    if (!covered.has(oid)) {
      const origin = await env.DB.prepare(
        "SELECT source_id FROM source_revision_origins WHERE repo_id=? AND commit_oid=?",
      )
        .bind(source.repoId, oid)
        .first<{ source_id: string }>();
      if (origin && origin.source_id !== source.sourceId)
        throw new Error(
          "blocked_dependency: foreign source ancestry has no reviewed exact logical dependency",
        );
    }
    const parents = (await read(oid))!;
    for (const parent of parents.slice(1)) {
      if (covered.has(parent)) continue;
      for (const member of await revisionClosure(parent, read)) {
        if (covered.has(member) || (await acknowledged(member))) continue;
        throw new Error(
          "blocked_dependency: imported merge parent has no reviewed exact logical dependency or acknowledged same-source history; explicitly sync/rebase and renew checkpoint",
        );
      }
    }
  }
}

/** Membership is written completely BEFORE receipt visibility; retries fill the same identity. */
export async function recordIntent(
  env: Env,
  landing: Landing,
  repo: LandingRepo,
  tree: string,
  metadata = new RevisionMetadata(),
) {
  const source = repo.source!;
  const existing = await receiptFor(env, landing.id, repo.id);
  if (existing && existing.status !== "intent") return existing;
  const owned = await getWorkSource(env, repo.id, source.sourceId);
  if (
    !owned ||
    owned.state !== "ready" ||
    source.repoId !== repo.id ||
    owned.space_id !== landing.authority?.spaceId ||
    owned.timeline_id !== landing.timelineId
  )
    throw new Error("Source is not available in this landing's immutable Space.");
  using artifacts = await env.ARTIFACTS.get(owned.artifacts_name);
  const readCommit = metadata.reader(owned.artifacts_name, artifacts);
  const commit = await readCommit(source.commit);
  if (!commit || commit.treeHash !== source.tree)
    throw new Error("Approved source tree is unavailable");
  const inputs: ArtifactsCommitMetadata[] = [];
  const members = await revisionClosure(source.commit, async (oid) => {
    const value = await readCommit(oid);
    if (value) inputs.push(value);
    return value?.parents ?? null;
  });
  const baseMembers = await revisionClosure(
    repo.logicalBase!.commit,
    async (oid) => (await readCommit(oid))?.parents ?? null,
  );
  const id = `${landing.id}:${repo.id}`;
  for (const oid of members) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO source_integration_members(receipt_id,repo_id,source_id,commit_oid) VALUES(?,?,?,?)",
    )
      .bind(id, repo.id, source.sourceId, oid)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO source_integration_inputs(receipt_id,repo_id,commits_json) VALUES(?,?,?) ON CONFLICT(receipt_id) DO NOTHING",
  )
    .bind(id, repo.id, JSON.stringify(inputs.filter((value) => !baseMembers.has(value.hash))))
    .run();
  await env.DB.prepare(`INSERT INTO source_integration_receipts
    (id,landing_id,checkpoint_id,repo_id,source_id,source_commit,source_tree,logical_base_json,dependencies_json,canonical_base,canonical_commit,canonical_tree,noop,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'intent',datetime('now'))
    ON CONFLICT(landing_id,repo_id) DO UPDATE SET canonical_base=excluded.canonical_base,canonical_commit=excluded.canonical_commit,canonical_tree=excluded.canonical_tree,noop=excluded.noop WHERE status='intent'`)
    .bind(
      id,
      landing.id,
      landing.checkpointId,
      repo.id,
      source.sourceId,
      source.commit,
      source.tree,
      JSON.stringify(repo.logicalBase),
      JSON.stringify(repo.dependencies),
      repo.base,
      repo.merge,
      tree,
      Number(repo.merge === repo.base),
    )
    .run();
  return receiptFor(env, landing.id, repo.id);
}

export async function recordIntegrated(env: Env, landing: Landing, repo: LandingRepo) {
  await env.DB.prepare(
    "UPDATE source_integration_receipts SET status='integrated' WHERE landing_id=? AND repo_id=? AND status='intent'",
  )
    .bind(landing.id, repo.id)
    .run();
  await env.DB.prepare(
    "UPDATE source_operations SET state='accepted',updated_at=datetime('now') WHERE id=?",
  )
    .bind(`landing:${landing.id}:${repo.id}`)
    .run();
}
export async function completeReceipts(env: Env, landingId: string) {
  await env.DB.prepare(
    "UPDATE source_integration_receipts SET status='complete' WHERE landing_id=? AND status='integrated'",
  )
    .bind(landingId)
    .run();
}

/** Deletion may reconcile proof of success, never turn absence into failure or issue a CAS. */
export async function reconcileLandingOperations(env: Env, repoId: string): Promise<void> {
  const pending = await env.DB.prepare(`SELECT r.* FROM source_integration_receipts r
    JOIN source_operations o ON o.id='landing:' || r.landing_id || ':' || r.repo_id
    JOIN repos p ON p.id=r.repo_id AND p.space_id=o.space_id
    JOIN timeline_work_sources w ON w.source_id=r.source_id AND w.repo_id=p.id AND w.space_id=p.space_id
    WHERE r.repo_id=? AND o.repo_id=r.repo_id AND o.source_id=r.source_id
      AND o.kind='landing' AND o.state IN ('admitted','ambiguous')`)
    .bind(repoId)
    .all<IntegrationReceipt>();
  if (!pending.results.length) return;
  const repo = await env.DB.prepare(
    "SELECT artifacts_name,artifacts_remote,default_branch FROM repos WHERE id=?",
  )
    .bind(repoId)
    .first<{ artifacts_name: string; artifacts_remote: string; default_branch: string }>();
  if (!repo) return;
  const refs = await lsRefs(env, repo.artifacts_name, repo.artifacts_remote);
  const main = refs.find((ref) => ref.name === `refs/heads/${repo.default_branch}`)?.oid;
  if (!main) return;
  using artifacts = await env.ARTIFACTS.get(repo.artifacts_name);
  const history = await revisionClosure(
    main,
    async (oid) => (await artifacts.readCommit(oid))?.parents ?? null,
  );
  for (const receipt of pending.results) {
    if (!history.has(receipt.canonical_commit)) continue;
    await env.DB.prepare(
      "UPDATE source_integration_receipts SET status='integrated' WHERE id=? AND status='intent'",
    )
      .bind(receipt.id)
      .run();
    await env.DB.prepare(
      "UPDATE source_operations SET state='accepted',updated_at=datetime('now') WHERE id=?",
    )
      .bind(`landing:${receipt.landing_id}:${repoId}`)
      .run();
  }
}
