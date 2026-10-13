import { DurableObject } from "cloudflare:workers";
import {
  canonicalSpaceJson,
  spaceDigest,
  type SpaceManifest,
  type SpaceMapping,
  type SpaceMigrationContext,
  type SpaceParticipantOperation,
  type SpaceCheckpointPage,
} from "../../shared/space-cutover.ts";
import type { SpaceParticipantInventory } from "../../shared/space-cutover.ts";
import type { Actor } from "../db.ts";
import { advanceSpaceCutover, migrationContext } from "./engine.ts";
import { durableNamespace, peekStub } from "../durable/registry.ts";
import { fenceBusinessDatabase } from "./storage-fence.ts";
import { slugProblem } from "../names.ts";
import { OperatorAuthStore } from "./operator-auth-store.ts";
import { CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";
import { FreshInstallation, type FreshInstallationStatus } from "./installation.ts";
import { initializeWorkState, readWorkState, writeWorkState } from "./work-state.ts";
import {
  CENSUS_IN_FLIGHT_LIMIT,
  CUTOVER_WORKFLOWS,
  DEPLOYMENT_EVIDENCE_TTL_MS,
  TERMINAL_WORKFLOW_STATUSES,
  evaluateQuiescence,
  isLegacyInstance,
  legacyBoundElapsed,
  legacyBoundStart,
  parseCensus,
  preparationSoleSince,
  type CutoverWorkflow,
  type DeploymentEvidence,
  type QuiescenceEvidence,
  type WorkflowCensus,
} from "./quiescence.ts";

export const CUTOVER_CONSUMERS = [
  "http-git-registry",
  "queue",
  "scheduled",
  "durable-registry",
  "tracker",
  "registry-upload",
  "registry-repo",
  "registry-login",
  "ci-sandbox",
  "ci-workflow",
  "repo-purge",
  "knowledge-build",
  "knowledge-coordinator",
  "assistant",
  "step-feed",
] as const;
/**
 * Artifacts accepts Git writes outside every business store, so the cutover
 * never waits for a provider drain. Each stage instead proves that the refs
 * Artifacts holds are the refs the push log has seen (space-cutover/ref-barrier.ts):
 * under the fence before migration, before write admission opens, and once after.
 */
export type RefReconciliationStage = "fenced" | "pre-open" | "post-open";
export interface RefReconciliationPass {
  pass: number;
  stage: RefReconciliationStage;
  /** The cutover phase it ran in: a pre-open pass proves reconciled or restored stores. */
  phase: CutoverPhase;
  cursor: string | null;
  complete: boolean;
  targets: number;
  divergent: number;
  /** Post-open divergences left for a later pass: a live push may still be logging them. */
  deferred: number;
  startedAt: string;
  completedAt: string | null;
}
/** One repository's canonical refs, or one work source's. */
export interface RefTarget {
  repoId: string;
  sourceId: string;
}
export interface RefObservation extends RefTarget {
  /** Digest of the logged branches and tags Artifacts listed. */
  digest: string;
}
export interface RefDivergence extends RefObservation {
  changes: { ref: string; old: string | null; new: string | null }[];
}
export interface RefReplay extends RefDivergence {
  pass: number;
  stage: RefReconciliationStage;
}
/** A replay that could not run, kept for a person who can re-trigger it. */
export interface BlockedRefReplay extends RefTarget {
  pass: number;
  reason: string;
}
/** A post-open divergence seen but not yet repaired. */
export interface RefDeferral extends RefTarget {
  digest: string;
  observedAt: string;
  /** The push log's highest entry for the target when it was seen. */
  updateMark: number;
}
/** Bounded Artifacts reads per reconciliation request. */
export const REF_PAGE_LIMIT = 16;

export function refStage(run: CutoverRun): RefReconciliationStage | null {
  if (run.phase === "fenced" && run.storageFenced) return "fenced";
  if (["reconciled", "restored"].includes(run.phase) && run.storageFenced)
    return run.writeAdmissionOpenedAt ? null : "pre-open";
  if (run.phase === "active" && run.writeAdmissionOpenedAt) return "post-open";
  // A legacy reopening also admitted writes after its clean pre-open pass:
  // late Artifacts writes still need logging, and its journal an outcome.
  if (run.phase === "legacy-active" && run.releaseApproval?.mode === "legacy") return "post-open";
  return null;
}

export type CutoverTicketSource =
  | { kind: "workflow"; binding: "CI_RUN" | "KNOWLEDGE_BUILD" | "REPO_PURGE"; instanceId: string }
  | { kind: "ci-sandbox"; instanceId: string };
export type CutoverPhase =
  | "prepared"
  | "fenced"
  | "migrating"
  | "reconciled"
  | "recovering"
  | "restored"
  | "opening"
  | "opening-legacy"
  | "active"
  | "legacy-active";
export interface CutoverRun {
  runId: string;
  migrationEpoch: number;
  manifestDigest: string;
  manifest: SpaceManifest;
  checkpoint: string;
  phase: CutoverPhase;
  operatorId: string;
  recoveryDigest: string;
  preparationVersionId: string;
  /** When the preparation release was first seen serving, and when its version was uploaded:
   * together they bound when an older release could last have started work. */
  preparedAt?: string;
  preparationVersionTimestamp?: string;
  /** When the preparation release last became the only one serving again, after
   * another served: the legacy bound restarts here (quiescence.ts). */
  boundResetAt?: string | null;
  /** Set while this journal has seen another release executing. */
  foreignVersionSeenAt?: string | null;
  /** The provider's deployment history, checked with the census. */
  deploymentEvidence?: DeploymentEvidence | null;
  approval: { operatorId: string; manifestDigest: string; checkpoint: string; at: string } | null;
  consumers: Record<
    string,
    {
      checkpoint: string;
      contractVersion: number;
      drained: boolean;
      /** Why the consumer drained (space-cutover/quiescence.ts). */
      evidence?: QuiescenceEvidence;
    }
  >;
  /** The provider's own Workflow instance lists, recorded under the fence. */
  workflowCensus?: Partial<Record<CutoverWorkflow, WorkflowCensus>>;
  stores: Record<
    string,
    { exported: boolean; migrated: boolean; reconciled: boolean; restored: boolean }
  >;
  writeAdmissionOpenedAt: string | null;
  preflightComplete: boolean;
  completedMappings: string[];
  inventories: Record<string, SpaceParticipantInventory>;
  storageFenced: boolean;
  authorityToken: string;
  revokedAuthorityToken: string | null;
  recoveryFencesReady: boolean;
  legacyReleases: Record<string, { checkpointDigest: string; reconciliationDigest: string }>;
  drainBlockers: string[];
  releaseApproval: {
    id: string;
    checkpoint: string;
    versionId: string;
    mode: "space" | "legacy";
    operatorId: string;
    at: string;
  } | null;
  runtimeConsumers: Record<
    string,
    {
      checkpoint: string;
      versionId: string;
      contractVersion: number;
      stores: Record<string, string>;
    }
  >;
}

/** Independent Instance state: never included in a business-store restore. */
export class SpaceCutover extends DurableObject<Env> {
  private running = false;
  private readonly operatorAuth: OperatorAuthStore;
  private readonly fresh: FreshInstallation;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.operatorAuth = new OperatorAuthStore(ctx);
    initializeWorkState(ctx.storage);
    this.fresh = new FreshInstallation(
      ctx.storage,
      env,
      () => !this.status() && !this.activeTickets().length,
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pages (run_id TEXT NOT NULL, store_id TEXT NOT NULL, ordinal INTEGER NOT NULL, cursor TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id,store_id,ordinal), UNIQUE(run_id,store_id,cursor))",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS admissions (ticket TEXT PRIMARY KEY, consumer TEXT NOT NULL, epoch INTEGER NOT NULL, checkpoint TEXT NOT NULL, source TEXT)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS admission_sources (source TEXT PRIMARY KEY, ticket TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS journal_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,value TEXT NOT NULL,recorded_at TEXT NOT NULL)",
    );
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS journal_run ON journal_events(run_id,seq)");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS workflow_probes(run_id TEXT NOT NULL,binding TEXT NOT NULL,approval_key TEXT NOT NULL,instance_id TEXT NOT NULL UNIQUE,attempt INTEGER NOT NULL,status TEXT NOT NULL,provider_status TEXT,observed_at TEXT,PRIMARY KEY(run_id,binding,approval_key,attempt))",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ref_passes(run_id TEXT NOT NULL,pass INTEGER NOT NULL,stage TEXT NOT NULL,phase TEXT NOT NULL,cursor TEXT NOT NULL,targets INTEGER NOT NULL DEFAULT 0,divergent INTEGER NOT NULL DEFAULT 0,deferred INTEGER NOT NULL DEFAULT 0,started_at TEXT NOT NULL,completed_at TEXT,PRIMARY KEY(run_id,pass))",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ref_observations(run_id TEXT NOT NULL,pass INTEGER NOT NULL,repo_id TEXT NOT NULL,source_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(run_id,pass,repo_id,source_id))",
    );
    // A divergence is journaled BEFORE its repair, so a repair whose
    // acknowledgement was lost still leaves its effects to replay.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ref_replays(run_id TEXT NOT NULL,pass INTEGER NOT NULL,repo_id TEXT NOT NULL,source_id TEXT NOT NULL,digest TEXT NOT NULL,changes TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','replayed','blocked')),reason TEXT,replayed_at TEXT,PRIMARY KEY(run_id,pass,repo_id,source_id))",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ref_deferrals(run_id TEXT NOT NULL,repo_id TEXT NOT NULL,source_id TEXT NOT NULL,digest TEXT NOT NULL,observed_at TEXT NOT NULL,update_mark INTEGER NOT NULL,PRIMARY KEY(run_id,repo_id,source_id))",
    );
  }
  status(): CutoverRun | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM control WHERE id=1")
      .toArray()[0];
    if (!row) return null;
    return JSON.parse(row.value) as CutoverRun;
  }
  freshStatus(): FreshInstallationStatus | null {
    return this.fresh.status();
  }
  async verifyFreshInstallation(): Promise<void> {
    if (this.status()) throw new Error("fresh_install_migration_conflict");
    await this.fresh.verifyActive();
  }
  async advanceFreshInstallation(
    expected: FreshInstallationStatus | null,
  ): Promise<FreshInstallationStatus> {
    if (this.running) throw new Error("fresh_install_busy");
    this.running = true;
    try {
      return await this.fresh.advance(expected);
    } finally {
      this.running = false;
    }
  }
  issueOperatorAuthentication(runId: string, challengeId: string, codeDigest: string) {
    const run = this.require(runId);
    if (["prepared", "legacy-active", "active"].includes(run.phase))
      throw new Error("Use ordinary human authentication while business admission is open");
    return this.operatorAuth.issue(runId, run.operatorId, challengeId, codeDigest);
  }
  verifyOperatorAuthentication(
    runId: string,
    challengeId: string,
    codeDigest: string,
    sessionDigest: string,
  ) {
    const run = this.require(runId);
    if (["prepared", "legacy-active", "active"].includes(run.phase))
      throw new Error("Independent authentication is not available in this phase");
    return this.operatorAuth.verify(runId, run.operatorId, challengeId, codeDigest, sessionDigest);
  }
  operatorSession(runId: string, sessionDigest: string): boolean {
    const run = this.status();
    return (
      !!run &&
      run.runId === runId &&
      !["prepared", "legacy-active", "active"].includes(run.phase) &&
      this.operatorAuth.session(runId, run.operatorId, sessionDigest)
    );
  }
  historicalRun(runId: string): CutoverRun | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM journal_events WHERE run_id=? ORDER BY seq DESC LIMIT 1",
        runId,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.value) as CutoverRun) : null;
  }
  workState(runId: string, key: string): string | null {
    this.require(runId);
    return readWorkState(this.ctx.storage, runId, key);
  }
  recordWorkState(runId: string, key: string, value: string): void {
    const run = this.require(runId);
    if (!["migrating", "recovering"].includes(run.phase))
      throw new Error("Invalid bounded work state");
    writeWorkState(this.ctx.storage, runId, key, value);
  }
  pageAtCursor(runId: string, storeId: string, cursor: string | null): SpaceCheckpointPage {
    this.require(runId);
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM pages WHERE run_id=? AND store_id=? AND cursor=?",
        runId,
        storeId,
        cursor ?? "",
      )
      .toArray()[0];
    if (!row) throw new Error("Recoverable checkpoint page is absent");
    return JSON.parse(row.value) as SpaceCheckpointPage;
  }
  pageOrdinal(runId: string, storeId: string, cursor: string | null): number | null {
    this.require(runId);
    return (
      this.ctx.storage.sql
        .exec<{ ordinal: number }>(
          "SELECT ordinal FROM pages WHERE run_id=? AND store_id=? AND cursor=?",
          runId,
          storeId,
          cursor ?? "",
        )
        .toArray()[0]?.ordinal ?? null
    );
  }
  private save(run: CutoverRun) {
    this.ctx.storage.transactionSync(() => {
      const value = JSON.stringify(run);
      this.ctx.storage.sql.exec(
        "INSERT INTO control(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        value,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO journal_events(run_id,value,recorded_at) VALUES(?,?,?)",
        run.runId,
        value,
        new Date().toISOString(),
      );
    });
  }
  async prepare(
    manifest: SpaceManifest,
    checkpoint: string,
    operatorId: string,
    recoveryDigest: string,
  ): Promise<CutoverRun> {
    if (this.fresh.status())
      throw new Error("Forward migration of a fresh v4 installation is unsupported");
    const previous = this.status();
    if (
      this.running ||
      (previous &&
        (previous.phase !== "legacy-active" ||
          previous.writeAdmissionOpenedAt ||
          previous.manifest.mapping.some((mapping) => !previous.legacyReleases[mapping.space.id])))
    )
      throw new Error("A cutover run already exists or legacy reopening is incomplete");
    if (!/^[0-9a-f]{40,64}$/.test(checkpoint)) throw new Error("Exact release checkpoint required");
    if (
      checkpoint !== this.env.CUTOVER_DEPLOYMENT_CHECKPOINT ||
      !this.env.CI_VERSION.id ||
      (this.env.DEV_MODE !== "true" && this.env.CI_VERSION.tag !== checkpoint)
    )
      throw new Error("Preparation must name this deployed tagged release");
    if (
      manifest.manifestVersion !== 1 ||
      manifest.contentContractVersion !== 4 ||
      !manifest.mapping.length
    )
      throw new Error("Unsupported manifest");
    const owners = new Set<string>();
    const slugs = new Set<string>();
    const organizations = new Map<string, SpaceMapping["organization"]>();
    const organizationSlugs = new Map<string, string>();
    for (const m of manifest.mapping) {
      if (
        !m.legacyOwner.id ||
        !m.organization.id ||
        slugProblem(m.space.slug) ||
        slugProblem(m.organization.slug) ||
        !m.space.displayName.trim() ||
        !m.organization.displayName.trim()
      )
        throw new Error("Invalid namespace or identity in mapping");
      const previousOrganization = organizations.get(m.organization.id);
      if (
        previousOrganization &&
        canonicalSpaceJson(previousOrganization) !== canonicalSpaceJson(m.organization)
      )
        throw new Error("Grouped Organization mapping is inconsistent");
      const previousSlug = organizationSlugs.get(m.organization.slug);
      if (previousSlug && previousSlug !== m.organization.id)
        throw new Error("Organization slug collision");
      if (
        !manifest.mapping.some(
          (candidate) =>
            candidate.space.id === m.organization.defaultSpaceId &&
            candidate.space.organizationId === m.organization.id &&
            !candidate.space.archived,
        )
      )
        throw new Error("Organization default is absent from approved mapping");
      organizations.set(m.organization.id, m.organization);
      organizationSlugs.set(m.organization.slug, m.organization.id);
      if (
        owners.has(m.legacyOwner.id) ||
        slugs.has(m.space.slug.toLowerCase()) ||
        m.space.id !== m.legacyOwner.id ||
        m.trackerDoName !== m.space.id ||
        m.space.organizationId !== m.organization.id ||
        m.space.archived ||
        m.space.slug !== m.legacyOwner.slug
      )
        throw new Error("Invalid or conflicting mapping");
      if (
        m.legacyOwner.kind === "user" &&
        (m.organization.kind !== "personal" ||
          m.organization.personalAccountId !== m.legacyOwner.id ||
          m.organization.defaultSpaceId !== m.space.id)
      )
        throw new Error("Personal ownership must remain private");
      owners.add(m.legacyOwner.id);
      slugs.add(m.space.slug.toLowerCase());
    }
    const manifestDigest = await spaceDigest(canonicalSpaceJson(manifest));
    // Hashing yielded; do not overwrite a concurrently prepared run.
    if (this.status()?.runId !== previous?.runId) throw new Error("A cutover run already exists");
    const run: CutoverRun = {
      runId: crypto.randomUUID(),
      migrationEpoch: (previous?.migrationEpoch ?? 0) + 1,
      manifestDigest,
      manifest,
      checkpoint,
      preparationVersionId: this.env.CI_VERSION.id,
      // This request is executing on the preparation release: it serves now.
      preparedAt: new Date().toISOString(),
      preparationVersionTimestamp: this.env.CI_VERSION.timestamp,
      operatorId,
      recoveryDigest,
      phase: "prepared",
      approval: null,
      consumers: {},
      stores: {},
      writeAdmissionOpenedAt: null,
      preflightComplete: false,
      completedMappings: [],
      inventories: {},
      storageFenced: false,
      authorityToken: crypto.randomUUID(),
      revokedAuthorityToken: null,
      recoveryFencesReady: false,
      legacyReleases: {},
      drainBlockers: ["drain_inspection_required"],
      releaseApproval: null,
      runtimeConsumers: {},
    };
    this.save(run);
    return run;
  }
  approve(runId: string, digest: string, checkpoint: string, operatorId: string) {
    const run = this.require(runId);
    if (run.phase !== "prepared" || digest !== run.manifestDigest || checkpoint !== run.checkpoint)
      throw new Error("Approval does not match prepared manifest and checkpoint");
    run.approval = { operatorId, manifestDigest: digest, checkpoint, at: new Date().toISOString() };
    this.save(run);
  }
  private require(runId: string): CutoverRun {
    const run = this.status();
    if (!run || run.runId !== runId) throw new Error("Cutover run mismatch");
    return run;
  }
  async authorizeRecovery(token: string): Promise<boolean> {
    const digest = await spaceDigest(token);
    return this.status()?.recoveryDigest === digest;
  }
  admission(contractVersion: number = CONTENT_CONTRACT_VERSION): {
    allowed: boolean;
    epoch: number;
  } {
    const run = this.status();
    const fresh = this.fresh.status();
    if (fresh)
      return {
        allowed: !run && fresh.phase === "active" && contractVersion === fresh.contractVersion,
        epoch: fresh.epoch,
      };
    // Approval pins the opening transition, not subsequent compatible releases.
    const allowed =
      !run || run.phase === "prepared"
        ? contractVersion === 3
        : (run.phase === "active" &&
            run.releaseApproval?.mode === "space" &&
            !!run.writeAdmissionOpenedAt &&
            contractVersion === 4) ||
          (run.phase === "legacy-active" &&
            run.releaseApproval?.mode === "legacy" &&
            contractVersion === 3);
    return { allowed, epoch: run?.migrationEpoch ?? 0 };
  }
  acquire(
    consumer: string,
    contractVersion: number,
    source?: CutoverTicketSource,
  ): { ticket: string; epoch: number } {
    if (
      ![3, 4].includes(contractVersion) ||
      !CUTOVER_CONSUMERS.includes(consumer as (typeof CUTOVER_CONSUMERS)[number])
    )
      throw new Error("space_cutover_fenced");
    const sourceKey = source ? canonicalSpaceJson({ consumer, source }) : null;
    if (sourceKey) {
      const previous = this.ctx.storage.sql
        .exec<{ ticket: string }>("SELECT ticket FROM admission_sources WHERE source=?", sourceKey)
        .toArray()[0];
      if (previous) {
        const live = this.activeTickets().find((entry) => entry.ticket === previous.ticket);
        if (!live) throw new Error("space_cutover_ticket_already_completed");
        this.assertTicket(live.ticket, live.epoch, contractVersion);
        return { ticket: live.ticket, epoch: live.epoch };
      }
    }
    const admission = this.admission(contractVersion);
    if (!admission.allowed) throw new Error("space_cutover_fenced");
    const ticket = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO admissions VALUES(?,?,?,?,?)",
        ticket,
        consumer,
        admission.epoch,
        this.env.CUTOVER_DEPLOYMENT_CHECKPOINT,
        source ? JSON.stringify(source) : null,
      );
      if (sourceKey)
        this.ctx.storage.sql.exec("INSERT INTO admission_sources VALUES(?,?)", sourceKey, ticket);
    });
    return { ticket, epoch: admission.epoch };
  }
  assertTicket(ticket: string, epoch: number, contractVersion: number): void {
    const current = this.activeTickets().find((entry) => entry.ticket === ticket);
    if (
      !current ||
      current.epoch !== epoch ||
      contractVersion !==
        (this.fresh.status()?.phase === "active" || this.status()?.writeAdmissionOpenedAt ? 4 : 3)
    )
      throw new Error("space_cutover_ticket_mismatch");
  }
  async reconcileWorkflowTickets(): Promise<void> {
    for (const ticket of this.activeTickets()) {
      if (ticket.source?.kind !== "workflow") continue;
      const binding = this.env[ticket.source.binding];
      if (!binding) throw new Error("Workflow binding unavailable for authoritative drain");
      const instance = await binding.get(ticket.source.instanceId);
      const status = await instance.status();
      if (["complete", "errored", "terminated"].includes(status.status))
        this.release(ticket.ticket);
    }
  }
  async reconcileSandboxTickets(runId: string): Promise<void> {
    if (this.require(runId).phase !== "fenced")
      throw new Error("Sandbox reconciliation requires closed admission");
    const namespace = durableNamespace(this.env, "CiSandbox");
    for (const ticket of this.activeTickets()) {
      if (ticket.source?.kind !== "ci-sandbox") continue;
      const sandbox = namespace.get(namespace.idFromString(ticket.source.instanceId));
      if (await sandbox.cutoverReconcile(runId, ticket.ticket, ticket.epoch))
        this.release(ticket.ticket);
    }
  }
  release(ticket: string): void {
    const existing = this.activeTickets().find((entry) => entry.ticket === ticket);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM admissions WHERE ticket=?", ticket);
      // Workflow IDs are exactly-once operations; a sandbox instance is reused.
      if (existing?.source?.kind === "ci-sandbox")
        this.ctx.storage.sql.exec("DELETE FROM admission_sources WHERE ticket=?", ticket);
    });
  }
  activeTickets(): {
    ticket: string;
    consumer: string;
    epoch: number;
    checkpoint: string;
    source: CutoverTicketSource | null;
  }[] {
    return this.ctx.storage.sql
      .exec<{
        ticket: string;
        consumer: string;
        epoch: number;
        checkpoint: string;
        source: string | null;
      }>("SELECT * FROM admissions ORDER BY consumer,ticket")
      .toArray()
      .map((row) => ({
        ...row,
        source: row.source ? (JSON.parse(row.source) as CutoverTicketSource) : null,
      }));
  }
  fence(runId: string) {
    const run = this.require(runId);
    if (
      !["prepared", "fenced"].includes(run.phase) ||
      !run.approval ||
      run.approval.manifestDigest !== run.manifestDigest ||
      run.approval.checkpoint !== run.checkpoint
    )
      throw new Error("Exact human approval required");
    run.phase = "fenced";
    this.save(run);
  }
  async fenceDatabases(runId: string): Promise<void> {
    const run = this.require(runId);
    if (run.phase !== "fenced")
      throw new Error("Close independent admission before database fencing");
    const context = migrationContext(run, run.manifest.mapping[0]!);
    await fenceBusinessDatabase(this.env.DB, context, run.authorityToken);
    await fenceBusinessDatabase(this.env.REGISTRY_DB, context, run.authorityToken);
    const current = this.require(runId);
    if (current.phase !== "fenced") throw new Error("Fence phase changed");
    current.storageFenced = true;
    this.save(current);
  }
  /** Only the internal authoritative inspector supplies these computed findings;
   * operator requests accept a runId, never a caller's readiness flags. */
  recordDrainInspection(
    runId: string,
    inspection: { preparationVersionId: string; blockers: string[] },
  ) {
    const run = this.require(runId);
    if (
      run.phase !== "fenced" ||
      inspection.preparationVersionId !== run.preparationVersionId ||
      this.env.CI_VERSION.id !== run.preparationVersionId
    )
      throw new Error("Drain inspection belongs to a different preparation deployment");
    run.drainBlockers = [...inspection.blockers];
    this.save(run);
  }
  /** When work an older release started could last have begun, for this run. */
  private boundStart(run: CutoverRun): number | null {
    return legacyBoundStart(run.preparedAt, run.preparationVersionTimestamp, run.boundResetAt);
  }
  /** Every drain acknowledgement and census rests on the bound: restarting it voids them. */
  private restartBound(run: CutoverRun, at: string) {
    run.boundResetAt = at;
    run.consumers = {};
    run.workflowCensus = undefined;
    run.deploymentEvidence = null;
  }
  /**
   * Records which release executes this journal. Another one (even a brief
   * rollback before the preparation release returns) leaves its own work
   * unbounded, so the bound restarts when the preparation release is seen again.
   * Returns whether the preparation release serves; the caller saves `run`.
   */
  private observeServingVersion(run: CutoverRun): boolean {
    const now = new Date().toISOString();
    if (this.env.CI_VERSION.id !== run.preparationVersionId) {
      if (!run.foreignVersionSeenAt) {
        run.foreignVersionSeenAt = now;
        this.restartBound(run, now);
      }
      return false;
    }
    if (run.foreignVersionSeenAt) {
      run.foreignVersionSeenAt = null;
      this.restartBound(run, now);
    }
    return true;
  }
  /** The installation's own in-flight Workflow work, as D1 records it. */
  private async inFlightWorkflowIds(): Promise<Record<CutoverWorkflow, string[]>> {
    const read = async (sql: string) => {
      const { results } = await this.env.DB.prepare(sql)
        .bind(CENSUS_IN_FLIGHT_LIMIT + 1)
        .all<{ id: string }>();
      if (results.length > CENSUS_IN_FLIGHT_LIMIT)
        throw new Error("Too much in-flight Workflow work to cross-check one census");
      return results.map((row) => row.id);
    };
    return {
      "ci-run": await read("SELECT id FROM ci_runs WHERE status IN ('queued','running') LIMIT ?"),
      "knowledge-build": await read("SELECT id FROM kg_builds WHERE status='running' LIMIT ?"),
      "repo-purge": await read(
        "SELECT workflow_id AS id FROM repo_deletions WHERE finished_at IS NULL AND workflow_id IS NOT NULL LIMIT ?",
      ),
    };
  }
  /**
   * Records the operator's export of the provider's own lists (contract §5,
   * amended): every instance of each Workflow, of every status, from a named
   * account, and the Worker's deployment history. Only under the fence, only
   * after the documented bound for other legacy work, so no queue, cron or
   * object of an older release can still create an instance the list missed.
   * D1's own record of in-flight work must all be listed: an instance that
   * exists but is missing means the census is incomplete and proves nothing.
   */
  async recordWorkflowCensus(runId: string, value: unknown, operatorId: string): Promise<void> {
    const run = this.require(runId);
    if (run.phase !== "fenced" || !run.storageFenced)
      throw new Error("A workflow census requires closed admission and storage fences");
    const serving = this.observeServingVersion(run);
    this.save(run);
    if (!serving) throw new Error("A workflow census belongs to the preparation deployment");
    const census = parseCensus(value);
    const sole = preparationSoleSince(census.deployments, run.preparationVersionId);
    if (!sole.ok) throw new Error(sole.message);
    const before = this.boundStart(run);
    if (before !== null && sole.since > before) {
      // Another release served after preparation: its work is bounded only from
      // when the preparation release alone served again.
      this.restartBound(run, new Date(sole.since).toISOString());
      this.save(run);
      throw new Error(
        `Another release served since preparation; the legacy bound restarts at ${run.boundResetAt}. Record the census after it.`,
      );
    }
    if (!legacyBoundElapsed(before, Date.now()))
      throw new Error("A workflow census must follow the documented legacy execution bound");
    const boundStart = before!;
    const inFlight = await this.inFlightWorkflowIds();
    const recordedAt = new Date().toISOString();
    const workflows = {} as Record<CutoverWorkflow, WorkflowCensus>;
    for (const workflow of Object.keys(CUTOVER_WORKFLOWS) as CutoverWorkflow[]) {
      const { name, instances } = census.workflows[workflow];
      const listed = new Set(instances.map((instance) => instance.id));
      const unlisted: string[] = [];
      const orphaned: string[] = [];
      const binding = this.env[CUTOVER_WORKFLOWS[workflow]];
      for (const id of inFlight[workflow]) {
        if (listed.has(id)) continue;
        if (!binding) throw new Error("Workflow binding unavailable for authoritative census");
        // The provider decides: an instance it holds but did not list makes the
        // census incomplete; no instance at all means nothing executes the work.
        try {
          await (await binding.get(id)).status();
          unlisted.push(id);
        } catch (error) {
          if (!/not.?found/i.test(error instanceof Error ? error.message : String(error)))
            throw error;
          orphaned.push(id);
        }
      }
      const live = instances.filter(
        (instance) => !TERMINAL_WORKFLOW_STATUSES.includes(instance.status),
      );
      workflows[workflow] = {
        recordedAt,
        operatorId,
        account: census.account,
        workflowName: name,
        listed: instances.length,
        instances: live,
        terminated: [],
        remaining: live
          .filter((instance) => isLegacyInstance(instance, boundStart))
          .map((instance) => instance.id),
        unlisted,
        orphaned,
        settledAt: null,
      };
    }
    // D1 and provider reads yielded: apply only to the same fenced run and bound.
    const current = this.require(runId);
    if (
      current.phase !== "fenced" ||
      !current.storageFenced ||
      this.boundStart(current) !== boundStart ||
      current.foreignVersionSeenAt
    )
      throw new Error("Fence phase or legacy bound changed during the census");
    // A repeated census keeps the terminations an earlier one already caused.
    for (const workflow of Object.keys(workflows) as CutoverWorkflow[])
      workflows[workflow].terminated = [...(current.workflowCensus?.[workflow]?.terminated ?? [])];
    current.workflowCensus = workflows;
    current.deploymentEvidence = {
      recordedAt,
      operatorId,
      account: census.account,
      worker: census.worker,
      latestDeploymentId: sole.latestId,
      soleSince: new Date(sole.since).toISOString(),
    };
    this.save(current);
  }
  /**
   * Terminates every censused instance an older release started (created
   * before the bound start). An instance holding a live ticket was admitted by
   * this release and settles through its ticket instead
   * (reconcileWorkflowTickets); one created since runs this release's code,
   * which admission and the fence already govern. Each termination is
   * journaled as it happens, so a later failure loses no evidence.
   */
  async settleLegacyWorkflows(runId: string): Promise<void> {
    const initial = this.require(runId);
    if (initial.phase !== "fenced" || !initial.storageFenced)
      throw new Error("Legacy workflow settlement requires the fenced drain phase");
    const serving = this.observeServingVersion(initial);
    this.save(initial);
    if (!serving) return;
    const census = initial.workflowCensus ?? {};
    const ticketed = new Set(
      this.activeTickets().flatMap((ticket) =>
        ticket.source?.kind === "workflow" ? [ticket.source.instanceId] : [],
      ),
    );
    const sameCensus = (workflow: CutoverWorkflow) => {
      const run = this.require(runId);
      if (run.phase !== "fenced" || run.foreignVersionSeenAt)
        throw new Error("Fence phase changed");
      const entry = run.workflowCensus?.[workflow];
      return entry && entry.recordedAt === census[workflow]?.recordedAt ? { run, entry } : null;
    };
    for (const workflow of Object.keys(census) as CutoverWorkflow[]) {
      const entry = census[workflow]!;
      if (entry.settledAt) continue;
      const binding = this.env[CUTOVER_WORKFLOWS[workflow]];
      if (!binding) throw new Error("Workflow binding unavailable for authoritative drain");
      const remaining: string[] = [];
      for (const id of entry.remaining) {
        if (ticketed.has(id)) {
          remaining.push(id);
          continue;
        }
        const instance = await binding.get(id);
        let { status } = await instance.status();
        if (!TERMINAL_WORKFLOW_STATUSES.includes(status)) {
          await instance.terminate();
          ({ status } = await instance.status());
          if (status === "terminated") {
            const current = sameCensus(workflow);
            if (!current) return;
            if (!current.entry.terminated.includes(id)) {
              current.entry.terminated.push(id);
              this.save(current.run);
            }
          }
        }
        if (!TERMINAL_WORKFLOW_STATUSES.includes(status)) remaining.push(id);
      }
      // Provider calls yielded: apply only to the same fenced run and census.
      const current = sameCensus(workflow);
      if (!current) return;
      current.entry.remaining = remaining;
      current.entry.settledAt = remaining.length ? null : new Date().toISOString();
      this.save(current.run);
    }
  }
  /**
   * The production drain acknowledgement, computed here from the journal, the
   * serving version, the provider lists and the clock, never from a caller's
   * readiness claims.
   */
  inspectQuiescence(
    runId: string,
  ): { consumer: string; acknowledged: boolean; code?: string; message?: string }[] {
    const run = this.require(runId);
    if (run.phase !== "fenced")
      throw new Error("Consumer quiescence is inspected in the fenced drain phase");
    // Another release's own older work is unbounded here: every acknowledgement,
    // including an earlier one, is void, and the bound restarts once the
    // preparation release is seen again.
    if (!this.observeServingVersion(run)) {
      this.save(run);
      return CUTOVER_CONSUMERS.map((consumer) => ({
        consumer,
        acknowledged: false,
        code: "preparation_version_not_serving",
        message:
          "Another release is executing; legacy work is only bounded while the preparation release serves.",
      }));
    }
    const now = Date.now();
    const tickets = this.activeTickets();
    const refsClean = this.refStageClean(runId, "fenced");
    const boundStart = this.boundStart(run);
    const findings = CUTOVER_CONSUMERS.map((consumer) => {
      const existing = run.consumers[consumer];
      if (existing?.drained && existing.checkpoint === run.checkpoint)
        return { consumer, acknowledged: true };
      const finding = evaluateQuiescence({
        consumer,
        now,
        boundStart,
        versionId: this.env.CI_VERSION.id,
        preparationVersionId: run.preparationVersionId,
        storageFenced: run.storageFenced,
        activeTickets: tickets.filter((ticket) => ticket.consumer === consumer).length,
        refsClean,
        census: run.workflowCensus ?? {},
        deployments: run.deploymentEvidence ?? null,
      });
      if (!finding.ok)
        return { consumer, acknowledged: false, code: finding.code, message: finding.message };
      run.consumers[consumer] = {
        checkpoint: run.checkpoint,
        contractVersion: 3,
        drained: true,
        evidence: finding.evidence,
      };
      return { consumer, acknowledged: true };
    });
    this.save(run);
    return findings;
  }
  /** A state-machine record for fixtures representing an already drained consumer.
   * Production acknowledgements come only from inspectQuiescence, with evidence. */
  acknowledge(runId: string, consumer: string, checkpoint: string, contractVersion: number) {
    const run = this.require(runId);
    if (
      run.phase !== "fenced" ||
      !CUTOVER_CONSUMERS.includes(consumer as (typeof CUTOVER_CONSUMERS)[number]) ||
      checkpoint !== run.checkpoint ||
      checkpoint !== this.env.CUTOVER_DEPLOYMENT_CHECKPOINT ||
      this.env.CI_VERSION.id !== run.preparationVersionId ||
      contractVersion !== 3 ||
      this.activeTickets().some((ticket) => ticket.consumer === consumer)
    )
      throw new Error("Invalid consumer acknowledgement");
    run.consumers[consumer] = { checkpoint, contractVersion, drained: true };
    this.save(run);
  }
  beginMigration(runId: string) {
    const run = this.require(runId);
    if (run.phase !== "fenced")
      throw new Error("Every deployed consumer and storage writer must drain");
    // Acknowledgements bound legacy work only while the preparation release serves.
    const serving = this.observeServingVersion(run);
    this.save(run);
    if (!serving) throw new Error("Every deployed consumer and storage writer must drain");
    if (
      run.phase !== "fenced" ||
      !run.storageFenced ||
      run.drainBlockers.length ||
      this.activeTickets().length ||
      CUTOVER_CONSUMERS.some((id) => !run.consumers[id]?.drained)
    )
      throw new Error("Every deployed consumer and storage writer must drain");
    // A Durable Object sees only its own version: a gradual deployment begun
    // since the census is visible only in the provider's history, so it must be
    // recent. (Fixture acknowledgements, from `acknowledge`, carry no evidence.)
    const evidence = Object.values(run.consumers).some((ack) => ack.evidence);
    if (
      evidence &&
      (!run.deploymentEvidence ||
        Date.now() - Date.parse(run.deploymentEvidence.recordedAt) > DEPLOYMENT_EVIDENCE_TTL_MS)
    )
      throw new Error("Record the deployment history again (workflow-census) before migrating");
    // Checked here too, never only through the recorded inspection.
    if (!this.refStageClean(runId, "fenced"))
      throw new Error("Artifacts refs must reconcile under the fence before the stores drain");
    run.phase = "migrating";
    this.save(run);
  }
  private refPassRow(runId: string, stage?: RefReconciliationStage): RefReconciliationPass | null {
    const row = this.ctx.storage.sql
      .exec<{
        pass: number;
        stage: RefReconciliationStage;
        phase: CutoverPhase;
        cursor: string;
        targets: number;
        divergent: number;
        deferred: number;
        started_at: string;
        completed_at: string | null;
      }>(
        stage
          ? "SELECT * FROM ref_passes WHERE run_id=? AND stage=? ORDER BY pass DESC LIMIT 1"
          : "SELECT * FROM ref_passes WHERE run_id=? ORDER BY pass DESC LIMIT 1",
        ...(stage ? [runId, stage] : [runId]),
      )
      .toArray()[0];
    if (!row) return null;
    return {
      pass: row.pass,
      stage: row.stage,
      phase: row.phase,
      cursor: row.cursor || null,
      complete: row.completed_at !== null,
      targets: row.targets,
      divergent: row.divergent,
      deferred: row.deferred,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }
  /**
   * The stage's latest pass listed every target and found each already logged.
   * A pass proves only the stores of the phase it ran in: a restoration discards
   * repairs made to the reconciled stores, so their pass no longer counts.
   * After opening, no replay may still be pending either; a blocked one is
   * reported for a person to re-trigger (refReconciliation), not retried here.
   */
  refStageClean(runId: string, stage: RefReconciliationStage, phase?: CutoverPhase): boolean {
    this.require(runId);
    const latest = this.refPassRow(runId, stage);
    return (
      !!latest &&
      (!phase || latest.phase === phase) &&
      latest.complete &&
      latest.divergent === 0 &&
      latest.deferred === 0 &&
      (stage !== "post-open" || !this.pendingRefReplays(runId, 1).length)
    );
  }
  /** Resumes this phase's unfinished pass; a clean pass stands unless `fresh`. */
  refPass(runId: string, stage: RefReconciliationStage, fresh = false): RefReconciliationPass {
    const run = this.require(runId);
    if (refStage(run) !== stage)
      throw new Error("Artifacts ref reconciliation is unavailable in this phase");
    const latest = this.refPassRow(runId);
    if (
      latest?.stage === stage &&
      latest.phase === run.phase &&
      (!latest.complete || (!fresh && latest.divergent === 0 && latest.deferred === 0))
    )
      return latest;
    this.ctx.storage.sql.exec(
      "INSERT INTO ref_passes(run_id,pass,stage,phase,cursor,started_at) VALUES(?,?,?,?,'',?)",
      runId,
      (latest?.pass ?? 0) + 1,
      stage,
      run.phase,
      new Date().toISOString(),
    );
    return this.refPassRow(runId)!;
  }
  private assertRefProgress(runId: string, pass: number, cursor: string | null) {
    const run = this.require(runId);
    const current = this.refPassRow(runId);
    if (
      !current ||
      current.pass !== pass ||
      current.complete ||
      current.cursor !== cursor ||
      refStage(run) !== current.stage ||
      current.phase !== run.phase
    )
      throw new Error("Artifacts ref reconciliation progress changed");
    return current;
  }
  /** Journals what Artifacts holds that the push log lacks, before any repair. */
  recordRefDivergence(
    runId: string,
    pass: number,
    cursor: string | null,
    divergence: RefDivergence,
  ): void {
    this.assertRefProgress(runId, pass, cursor);
    if (!divergence.changes.length) throw new Error("A divergence names its ref changes");
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ changes: string }>(
          "SELECT changes FROM ref_replays WHERE run_id=? AND pass=? AND repo_id=? AND source_id=?",
          runId,
          pass,
          divergence.repoId,
          divergence.sourceId,
        )
        .toArray()[0];
      if (existing) {
        // A retried page saw a later move too: keep both, and replay again.
        this.ctx.storage.sql.exec(
          "UPDATE ref_replays SET digest=?,changes=?,status='pending',reason=NULL,replayed_at=NULL WHERE run_id=? AND pass=? AND repo_id=? AND source_id=?",
          divergence.digest,
          JSON.stringify([
            ...(JSON.parse(existing.changes) as RefDivergence["changes"]),
            ...divergence.changes,
          ]),
          runId,
          pass,
          divergence.repoId,
          divergence.sourceId,
        );
        return;
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO ref_replays(run_id,pass,repo_id,source_id,digest,changes,status) VALUES(?,?,?,?,?,?,'pending')",
        runId,
        pass,
        divergence.repoId,
        divergence.sourceId,
        divergence.digest,
        JSON.stringify(divergence.changes),
      );
      this.ctx.storage.sql.exec(
        "UPDATE ref_passes SET divergent=divergent+1 WHERE run_id=? AND pass=?",
        runId,
        pass,
      );
    });
  }
  /** Advances the pass past one page; the final page completes it. */
  recordRefPage(
    runId: string,
    pass: number,
    cursor: string | null,
    nextCursor: string | null,
    observations: RefObservation[],
  ): RefReconciliationPass {
    this.assertRefProgress(runId, pass, cursor);
    if (observations.length > REF_PAGE_LIMIT || (nextCursor !== null && !observations.length))
      throw new Error("Invalid Artifacts ref reconciliation page");
    this.ctx.storage.transactionSync(() => {
      for (const observation of observations)
        this.ctx.storage.sql.exec(
          "INSERT INTO ref_observations VALUES(?,?,?,?,?)",
          runId,
          pass,
          observation.repoId,
          observation.sourceId,
          observation.digest,
        );
      this.ctx.storage.sql.exec(
        "UPDATE ref_passes SET cursor=?,targets=targets+?,completed_at=? WHERE run_id=? AND pass=?",
        nextCursor ?? "",
        observations.length,
        nextCursor === null ? new Date().toISOString() : null,
        runId,
        pass,
      );
    });
    return this.refPassRow(runId)!;
  }
  /** Records a post-open divergence left unrepaired for now (ref-barrier.ts). */
  recordRefDeferral(runId: string, pass: number, cursor: string | null, deferral: RefDeferral) {
    this.assertRefProgress(runId, pass, cursor);
    if (refStage(this.require(runId)) !== "post-open")
      throw new Error("Only a post-open divergence waits for a live push to log itself");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO ref_deferrals VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,repo_id,source_id) DO UPDATE SET digest=excluded.digest,observed_at=excluded.observed_at,update_mark=excluded.update_mark",
        runId,
        deferral.repoId,
        deferral.sourceId,
        deferral.digest,
        deferral.observedAt,
        deferral.updateMark,
      );
      this.ctx.storage.sql.exec(
        "UPDATE ref_passes SET deferred=deferred+1 WHERE run_id=? AND pass=?",
        runId,
        pass,
      );
    });
  }
  refDeferral(runId: string, target: RefTarget): RefDeferral | null {
    this.require(runId);
    const row = this.ctx.storage.sql
      .exec<{ digest: string; observed_at: string; update_mark: number }>(
        "SELECT digest,observed_at,update_mark FROM ref_deferrals WHERE run_id=? AND repo_id=? AND source_id=?",
        runId,
        target.repoId,
        target.sourceId,
      )
      .toArray()[0];
    return row
      ? {
          ...target,
          digest: row.digest,
          observedAt: row.observed_at,
          updateMark: row.update_mark,
        }
      : null;
  }
  clearRefDeferral(runId: string, target: RefTarget) {
    this.require(runId);
    this.ctx.storage.sql.exec(
      "DELETE FROM ref_deferrals WHERE run_id=? AND repo_id=? AND source_id=?",
      runId,
      target.repoId,
      target.sourceId,
    );
  }
  private replayRows(where: string, limit: number, ...params: (string | number)[]): RefReplay[] {
    return this.ctx.storage.sql
      .exec<{
        pass: number;
        stage: RefReconciliationStage;
        repo_id: string;
        source_id: string;
        digest: string;
        changes: string;
      }>(
        `SELECT r.pass,p.stage,r.repo_id,r.source_id,r.digest,r.changes FROM ref_replays r JOIN ref_passes p ON p.run_id=r.run_id AND p.pass=r.pass WHERE ${where} ORDER BY r.pass,r.repo_id,r.source_id LIMIT ?`,
        ...params,
        limit,
      )
      .toArray()
      .map((row) => ({
        pass: row.pass,
        stage: row.stage,
        repoId: row.repo_id,
        sourceId: row.source_id,
        digest: row.digest,
        changes: JSON.parse(row.changes) as RefDivergence["changes"],
      }));
  }
  pendingRefReplays(runId: string, limit: number): RefReplay[] {
    return this.replayRows("r.run_id=? AND r.status='pending'", limit, runId);
  }
  /** One journaled replay that has not run, pending or blocked: a targeted re-trigger. */
  refReplay(runId: string, key: { pass: number; repoId: string; sourceId: string }) {
    this.require(runId);
    return (
      this.replayRows(
        "r.run_id=? AND r.pass=? AND r.repo_id=? AND r.source_id=? AND r.status IN ('pending','blocked')",
        1,
        runId,
        key.pass,
        key.repoId,
        key.sourceId,
      )[0] ?? null
    );
  }
  /** Push effects are new-epoch work: they replay only after admission opened. */
  settleRefReplay(
    runId: string,
    replay: Pick<RefReplay, "pass" | "repoId" | "sourceId" | "digest">,
  ) {
    if (refStage(this.require(runId)) !== "post-open")
      throw new Error("Push effects replay only after write admission opened");
    // A divergence journaled since this replay began stays pending.
    this.ctx.storage.sql.exec(
      "UPDATE ref_replays SET status='replayed',reason=NULL,replayed_at=? WHERE run_id=? AND pass=? AND repo_id=? AND source_id=? AND digest=? AND status IN ('pending','blocked')",
      new Date().toISOString(),
      runId,
      replay.pass,
      replay.repoId,
      replay.sourceId,
      replay.digest,
    );
  }
  /**
   * A replay that could not run: it no longer holds up the others or the pass,
   * and stays listed until a person who can run it re-triggers it.
   */
  blockRefReplay(
    runId: string,
    replay: Pick<RefReplay, "pass" | "repoId" | "sourceId" | "digest">,
    reason: string,
  ) {
    if (refStage(this.require(runId)) !== "post-open")
      throw new Error("Push effects replay only after write admission opened");
    this.ctx.storage.sql.exec(
      "UPDATE ref_replays SET status='blocked',reason=? WHERE run_id=? AND pass=? AND repo_id=? AND source_id=? AND digest=? AND status IN ('pending','blocked')",
      reason.slice(0, 500),
      runId,
      replay.pass,
      replay.repoId,
      replay.sourceId,
      replay.digest,
    );
  }
  refReconciliation(runId: string) {
    this.require(runId);
    const stages = Object.fromEntries(
      (["fenced", "pre-open", "post-open"] as const).map((stage) => [
        stage,
        { latest: this.refPassRow(runId, stage), clean: this.refStageClean(runId, stage) },
      ]),
    ) as Record<RefReconciliationStage, { latest: RefReconciliationPass | null; clean: boolean }>;
    const count = (status: string) =>
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM ref_replays WHERE run_id=? AND status=?",
          runId,
          status,
        )
        .one().count;
    const blocked: BlockedRefReplay[] = this.ctx.storage.sql
      .exec<{ pass: number; repo_id: string; source_id: string; reason: string | null }>(
        "SELECT pass,repo_id,source_id,reason FROM ref_replays WHERE run_id=? AND status='blocked' ORDER BY pass,repo_id,source_id LIMIT 50",
        runId,
      )
      .toArray()
      .map((row) => ({
        pass: row.pass,
        repoId: row.repo_id,
        sourceId: row.source_id,
        reason: row.reason ?? "",
      }));
    return {
      stages,
      pendingReplays: count("pending"),
      blockedReplays: count("blocked"),
      blocked,
    };
  }
  assertParticipant(
    context: SpaceMigrationContext,
    operation: SpaceParticipantOperation,
  ): SpaceMapping {
    const run = this.require(context.runId);
    const mapping = run.manifest.mapping.find((m) => m.legacyOwner.id === context.legacyOwnerId);
    if (
      !mapping ||
      context.migrationEpoch !== run.migrationEpoch ||
      context.manifestDigest !== run.manifestDigest ||
      context.contractVersion !== 4 ||
      context.spaceId !== mapping.space.id ||
      context.organizationId !== mapping.organization.id ||
      context.spaceSlug !== mapping.space.slug ||
      !run.approval
    )
      throw new Error("Migration authority mismatch");
    if (operation === "release-legacy") {
      if (
        run.phase !== "opening-legacy" ||
        run.writeAdmissionOpenedAt ||
        run.releaseApproval?.mode !== "legacy" ||
        run.releaseApproval.checkpoint !== this.env.CUTOVER_DEPLOYMENT_CHECKPOINT ||
        run.releaseApproval.versionId !== this.env.CI_VERSION.id ||
        !run.stores[`tracker:${mapping.space.id}`]?.restored
      )
        throw new Error("Legacy participant release is not approved");
    } else if (operation === "refs") {
      // Never while a store is checkpointed or transformed: before migration
      // the repair is in the checkpoint; after reconciliation it is forward.
      const stage = refStage(run);
      if (stage !== "fenced" && stage !== "pre-open") throw new Error("Participant is fenced");
    } else if (operation === "restore") {
      if (run.writeAdmissionOpenedAt || !["recovering", "restored"].includes(run.phase))
        throw new Error("Pre-cutover restore forbidden");
    } else if (
      !["fenced", "migrating", "reconciled", "recovering", "restored"].includes(run.phase) ||
      ((operation === "migrate" || operation === "reconcile") && run.phase !== "migrating")
    )
      throw new Error("Participant is fenced");
    return mapping;
  }
  /**
   * One journaled step, or, given a budget, as many as fit in it: each step is
   * still independently journaled, so stopping anywhere loses nothing. Steps stop
   * early when the phase changes, so a transition is never run past.
   */
  async advance(runId: string, actor: Actor, budgetMs = 0): Promise<void> {
    this.require(runId);
    if (this.running) throw new Error("Another cutover operation is running");
    this.running = true;
    try {
      const until = Date.now() + budgetMs;
      const phase = this.require(runId).phase;
      do {
        await advanceSpaceCutover(this.env, this, actor);
      } while (
        Date.now() < until &&
        this.require(runId).phase === phase &&
        !["reconciled", "restored"].includes(phase)
      );
    } finally {
      this.running = false;
    }
  }
  recordPreflight(runId: string) {
    const run = this.require(runId);
    if (run.phase !== "migrating") throw new Error("Preflight phase mismatch");
    run.preflightComplete = true;
    this.save(run);
  }
  recordInventory(runId: string, inventory: SpaceParticipantInventory) {
    const run = this.require(runId);
    const stores = [
      "application",
      "registry",
      ...run.manifest.mapping.map((mapping) => `tracker:${mapping.space.id}`),
    ];
    if (
      run.phase !== "migrating" ||
      !stores.includes(inventory.storeId) ||
      (run.inventories[inventory.storeId] &&
        canonicalSpaceJson(run.inventories[inventory.storeId]) !== canonicalSpaceJson(inventory))
    )
      throw new Error("Inventory evidence changed");
    run.inventories[inventory.storeId] = inventory;
    this.save(run);
  }
  recordMapping(runId: string, spaceId: string) {
    const run = this.require(runId);
    if (
      run.phase !== "migrating" ||
      !run.manifest.mapping.some((mapping) => mapping.space.id === spaceId)
    )
      throw new Error("Mapping phase mismatch");
    if (!run.completedMappings.includes(spaceId)) run.completedMappings.push(spaceId);
    this.save(run);
  }
  checkpointPosition(
    runId: string,
    storeId: string,
  ): { ordinal: number; cursor: string | null; complete: boolean } {
    this.require(runId);
    const last = this.ctx.storage.sql
      .exec<{ ordinal: number; value: string }>(
        "SELECT ordinal,value FROM pages WHERE run_id=? AND store_id=? ORDER BY ordinal DESC LIMIT 1",
        runId,
        storeId,
      )
      .toArray()[0];
    if (!last) return { ordinal: 0, cursor: null, complete: false };
    const page = JSON.parse(last.value) as SpaceCheckpointPage;
    return {
      ordinal: last.ordinal + 1,
      cursor: page.nextCursor,
      complete: page.nextCursor === null,
    };
  }
  async storePage(runId: string, storeId: string, ordinal: number, page: SpaceCheckpointPage) {
    if (
      new TextEncoder().encode(page.payload).byteLength > 512 * 1024 ||
      (await spaceDigest(page.payload)) !== page.digest
    )
      throw new Error("Invalid checkpoint page");
    const run = this.require(runId);
    if (run.phase !== "migrating" || run.stores[storeId]?.migrated)
      throw new Error("Checkpoint is immutable");
    const existing = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM pages WHERE run_id=? AND store_id=? AND ordinal=?",
        runId,
        storeId,
        ordinal,
      )
      .toArray()[0];
    if (existing && existing.value !== JSON.stringify(page)) throw new Error("Checkpoint changed");
    if (!existing) {
      const position = this.checkpointPosition(runId, storeId);
      if (position.complete || ordinal !== position.ordinal || page.cursor !== position.cursor)
        throw new Error("Checkpoint chain mismatch");
    }
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO pages VALUES(?,?,?,?,?)",
      runId,
      storeId,
      ordinal,
      page.cursor ?? "",
      JSON.stringify(page),
    );
  }
  page(runId: string, storeId: string, ordinal: number): SpaceCheckpointPage | null {
    this.require(runId);
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM pages WHERE run_id=? AND store_id=? AND ordinal=?",
        runId,
        storeId,
        ordinal,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.value) as SpaceCheckpointPage) : null;
  }
  recordStore(
    runId: string,
    storeId: string,
    step: "exported" | "migrated" | "reconciled" | "restored",
  ) {
    const run = this.require(runId);
    const expected = [
      "application",
      "registry",
      ...run.manifest.mapping.map((mapping) => `tracker:${mapping.space.id}`),
    ];
    if (!expected.includes(storeId)) throw new Error("Unknown business store");
    if (step === "exported" && !this.checkpointPosition(runId, storeId).complete)
      throw new Error("Recoverable checkpoint is incomplete");
    if (step === "migrated" && expected.some((id) => !run.stores[id]?.exported))
      throw new Error("Every store must be checkpointed before any transformation");
    const state = run.stores[storeId] ?? {
      exported: false,
      migrated: false,
      reconciled: false,
      restored: false,
    };
    if (
      step === "restored"
        ? run.phase !== "recovering" || !!run.writeAdmissionOpenedAt
        : run.phase !== "migrating"
    )
      throw new Error("Invalid store phase");
    if ((step === "migrated" && !state.exported) || (step === "reconciled" && !state.migrated))
      throw new Error("Missing store prerequisite");
    state[step] = true;
    run.stores[storeId] = state;
    this.save(run);
  }
  complete(runId: string, storeIds: string[]) {
    const run = this.require(runId);
    const expected = [
      "application",
      "registry",
      ...run.manifest.mapping.map((mapping) => `tracker:${mapping.space.id}`),
    ];
    if (
      canonicalSpaceJson(storeIds.toSorted()) !== canonicalSpaceJson(expected.toSorted()) ||
      run.completedMappings.length !== run.manifest.mapping.length
    )
      throw new Error("Whole-store reconciliation set mismatch");
    if (
      run.phase !== "migrating" ||
      !storeIds.length ||
      storeIds.some((id) => !run.stores[id]?.reconciled)
    )
      throw new Error("Store reconciliation missing");
    run.phase = "reconciled";
    this.save(run);
  }
  approveRelease(
    runId: string,
    checkpoint: string,
    versionId: string,
    mode: "space" | "legacy",
    operatorId: string,
  ) {
    const run = this.require(runId);
    if (
      this.running ||
      !/^[0-9a-f]{40,64}$/.test(checkpoint) ||
      !versionId ||
      run.phase !== (mode === "space" ? "reconciled" : "restored") ||
      run.writeAdmissionOpenedAt
    )
      throw new Error("Release approval requires the exact reconciled or restored checkpoint");
    if (
      mode === "legacy" &&
      (checkpoint !== run.checkpoint || versionId !== run.preparationVersionId)
    )
      throw new Error("Legacy reopening requires the reviewed preparation release");
    run.releaseApproval = {
      id: crypto.randomUUID(),
      checkpoint,
      versionId,
      mode,
      operatorId,
      at: new Date().toISOString(),
    };
    run.runtimeConsumers = {};
    this.save(run);
  }
  private runtimeRelease(run: CutoverRun): {
    key: string;
    checkpoint: string;
    versionId: string;
    contractVersion: 3 | 4;
  } {
    const approval = run.releaseApproval;
    if (!approval || !["reconciled", "restored", "opening", "opening-legacy"].includes(run.phase))
      throw new Error("No approved runtime attestation boundary");
    return {
      key: `release:${approval.id}`,
      checkpoint: approval.checkpoint,
      versionId: approval.versionId,
      contractVersion: approval.mode === "space" ? 4 : 3,
    };
  }
  /** Runtime compatibility is independent of quiescence: this never changes
   * preparation drain acknowledgements or clears legacy execution blockers. */
  acknowledgeRuntime(
    runId: string,
    consumer: string,
    contractVersion: number,
    observed: { versionId: string; checkpoint: string },
  ) {
    const run = this.require(runId);
    const release = this.runtimeRelease(run);
    if (
      !CUTOVER_CONSUMERS.includes(consumer as (typeof CUTOVER_CONSUMERS)[number]) ||
      contractVersion !== release.contractVersion ||
      observed.versionId !== release.versionId ||
      observed.checkpoint !== release.checkpoint ||
      release.versionId !== this.env.CI_VERSION.id ||
      release.checkpoint !== this.env.CUTOVER_DEPLOYMENT_CHECKPOINT ||
      (this.env.DEV_MODE !== "true" && this.env.CI_VERSION.tag !== release.checkpoint)
    )
      throw new Error("Runtime acknowledgement does not match the approved deployed release");
    const stores = [
      "application",
      "registry",
      ...run.manifest.mapping.map((mapping) => `tracker:${mapping.space.id}`),
    ];
    if (
      this.activeTickets().length ||
      stores.some((store) =>
        release.contractVersion === 4
          ? !run.stores[store]?.reconciled
          : !run.stores[store]?.restored,
      )
    )
      throw new Error("Runtime acknowledgement requires settled business stores");
    run.runtimeConsumers[consumer] = {
      ...observed,
      contractVersion,
      stores: Object.fromEntries(
        Object.entries(run.inventories).map(([id, inventory]) => [id, inventory.digest]),
      ),
    };
    this.save(run);
  }
  async reserveWorkflowRuntimeProbe(
    runId: string,
    binding: "CI_RUN" | "KNOWLEDGE_BUILD" | "REPO_PURGE",
    versionId: string,
    checkpoint: string,
  ): Promise<{
    instanceId: string;
    attempt: number;
    status: "reserved" | "reported" | "exhausted";
  }> {
    if (!["CI_RUN", "KNOWLEDGE_BUILD", "REPO_PURGE"].includes(binding))
      throw new Error("Unknown Workflow binding");
    const release = this.runtimeRelease(this.require(runId));
    if (
      versionId !== release.versionId ||
      checkpoint !== release.checkpoint ||
      versionId !== this.env.CI_VERSION.id ||
      checkpoint !== this.env.CUTOVER_DEPLOYMENT_CHECKPOINT
    )
      throw new Error("Workflow reservation release mismatch");
    const latest = () =>
      this.ctx.storage.sql
        .exec<{
          instance_id: string;
          attempt: number;
          status: "reserved" | "reported" | "exhausted";
        }>(
          "SELECT instance_id,attempt,status FROM workflow_probes WHERE run_id=? AND binding=? AND approval_key=? ORDER BY attempt DESC LIMIT 1",
          runId,
          binding,
          release.key,
        )
        .toArray()[0];
    let prior = latest();
    if (prior && prior.status !== "reserved")
      return { instanceId: prior.instance_id, attempt: prior.attempt, status: prior.status };
    if (prior) {
      let providerStatus = "unknown";
      try {
        const instance = await this.env[binding].get(prior.instance_id);
        providerStatus = (await instance.status()).status;
      } catch {
        /* Unknown provider state never permits a replacement execution. */
      }
      if (this.runtimeRelease(this.require(runId)).key !== release.key)
        throw new Error("Workflow approval changed during inspection");
      const current = latest();
      if (current?.instance_id !== prior.instance_id || current.status !== "reserved") {
        if (!current) throw new Error("Workflow probe reservation disappeared");
        return {
          instanceId: current.instance_id,
          attempt: current.attempt,
          status: current.status,
        };
      }
      prior = current;
      this.ctx.storage.sql.exec(
        "UPDATE workflow_probes SET provider_status=?,observed_at=? WHERE instance_id=?",
        providerStatus,
        new Date().toISOString(),
        prior.instance_id,
      );
      if (!["complete", "errored", "terminated"].includes(providerStatus))
        return { instanceId: prior.instance_id, attempt: prior.attempt, status: prior.status };
      if (prior.attempt >= 3) {
        this.ctx.storage.sql.exec(
          "UPDATE workflow_probes SET status='exhausted' WHERE instance_id=?",
          prior.instance_id,
        );
        return { instanceId: prior.instance_id, attempt: prior.attempt, status: "exhausted" };
      }
    }
    const instanceId = `cutover-${crypto.randomUUID()}`;
    const attempt = (prior?.attempt ?? 0) + 1;
    this.ctx.storage.sql.exec(
      "INSERT INTO workflow_probes(run_id,binding,approval_key,instance_id,attempt,status) VALUES(?,?,?,?,?,'reserved')",
      runId,
      binding,
      release.key,
      instanceId,
      attempt,
    );
    return { instanceId, attempt, status: "reserved" };
  }
  reportWorkflowRuntime(
    runId: string,
    binding: "CI_RUN" | "KNOWLEDGE_BUILD" | "REPO_PURGE",
    instanceId: string,
    versionId: string,
    checkpoint: string,
    contractVersion: number,
  ): void {
    const release = this.runtimeRelease(this.require(runId));
    const probe = this.ctx.storage.sql
      .exec<{ instance_id: string; status: string }>(
        "SELECT instance_id,status FROM workflow_probes WHERE run_id=? AND binding=? AND approval_key=? ORDER BY attempt DESC LIMIT 1",
        runId,
        binding,
        release.key,
      )
      .toArray()[0];
    if (!probe || probe.instance_id !== instanceId || probe.status === "exhausted")
      throw new Error("Unreserved Workflow runtime report");
    const consumer = {
      CI_RUN: "ci-workflow",
      KNOWLEDGE_BUILD: "knowledge-build",
      REPO_PURGE: "repo-purge",
    }[binding];
    if (!consumer) throw new Error("Unknown Workflow binding");
    this.acknowledgeRuntime(runId, consumer, contractVersion, { versionId, checkpoint });
    this.ctx.storage.sql.exec(
      "UPDATE workflow_probes SET status='reported' WHERE instance_id=?",
      instanceId,
    );
  }
  async openWriteAdmission(runId: string): Promise<void> {
    const run = this.require(runId);
    const approval = run.releaseApproval;
    if (
      this.running ||
      !approval ||
      approval.versionId !== this.env.CI_VERSION.id ||
      approval.checkpoint !== this.env.CUTOVER_DEPLOYMENT_CHECKPOINT ||
      (this.env.DEV_MODE !== "true" && this.env.CI_VERSION.tag !== approval.checkpoint) ||
      this.activeTickets().length
    )
      throw new Error("Reviewed release is not ready");
    const space = approval.mode === "space";
    if (!(space ? ["reconciled", "opening"] : ["restored", "opening-legacy"]).includes(run.phase))
      throw new Error("Admission phase mismatch");
    if (!this.refStageClean(runId, "pre-open", space ? "reconciled" : "restored"))
      throw new Error("Artifacts refs must reconcile before write admission opens");
    const expected = [
      "application",
      "registry",
      ...run.manifest.mapping.map((mapping) => `tracker:${mapping.space.id}`),
    ];
    if (
      expected.some((id) =>
        space ? !run.stores[id]?.reconciled : run.stores[id]?.exported && !run.stores[id]?.restored,
      )
    )
      throw new Error("Coordinated business checkpoints are incomplete");
    if (
      CUTOVER_CONSUMERS.some((id) => {
        const ack = run.runtimeConsumers[id];
        return (
          !ack ||
          ack.checkpoint !== approval.checkpoint ||
          ack.versionId !== approval.versionId ||
          ack.contractVersion !== (space ? 4 : 3) ||
          canonicalSpaceJson(ack.stores) !==
            canonicalSpaceJson(
              Object.fromEntries(
                Object.entries(run.inventories).map(([store, inventory]) => [
                  store,
                  inventory.digest,
                ]),
              ),
            )
        );
      })
    )
      throw new Error("Compatible consumer acknowledgements are incomplete");
    // This durable write is the irreversible boundary, before either D1 gate
    // opens or any new-epoch lease can be acquired. A partial opening is resumable
    // but can NEVER restore the old checkpoint.
    if (space) run.writeAdmissionOpenedAt ??= new Date().toISOString();
    run.phase = space ? "opening" : "opening-legacy";
    this.save(run);
    if (!space) {
      for (const mapping of run.manifest.mapping) {
        const latest = this.require(runId);
        if (latest.legacyReleases[mapping.space.id]) continue;
        const receipt = await peekStub(
          this.env,
          "Tracker",
          mapping.trackerDoName,
        ).spaceMigrationReleaseLegacy(migrationContext(latest, mapping));
        if (
          !receipt.released ||
          receipt.runId !== runId ||
          receipt.migrationEpoch !== latest.migrationEpoch ||
          receipt.storeId !== `tracker:${mapping.space.id}`
        )
          throw new Error("Participant legacy release mismatch");
        const current = this.require(runId);
        if (current.phase !== "opening-legacy") throw new Error("Legacy release phase changed");
        current.legacyReleases[mapping.space.id] = {
          checkpointDigest: receipt.checkpointDigest,
          reconciliationDigest: receipt.reconciliationDigest,
        };
        this.save(current);
      }
    }
    for (const database of [this.env.DB, this.env.REGISTRY_DB]) {
      const result = await database
        .prepare(
          "UPDATE _space_cutover_fence SET fenced=0,bypass=0 WHERE id=1 AND run_id=? AND migration_epoch=? AND manifest_digest=? AND authority_token=? AND bypass=0",
        )
        .bind(run.runId, run.migrationEpoch, run.manifestDigest, run.authorityToken)
        .run();
      if (result.meta.changes !== 1) throw new Error("Storage admission fence context changed");
    }
    const current = this.require(runId);
    if (current.phase !== run.phase || current.releaseApproval?.versionId !== approval.versionId)
      throw new Error("Release changed during admission");
    current.phase = space ? "active" : "legacy-active";
    current.storageFenced = false;
    this.save(current);
  }
  recover(runId: string) {
    const run = this.require(runId);
    if (this.running)
      throw new Error("Wait for current cutover operation to settle before recovery");
    if (
      run.writeAdmissionOpenedAt ||
      !["fenced", "migrating", "reconciled", "recovering"].includes(run.phase)
    )
      throw new Error("Recovery is forward-only after admission");
    if (run.phase !== "recovering") {
      run.revokedAuthorityToken = run.authorityToken;
      run.authorityToken = crypto.randomUUID();
      run.recoveryFencesReady = false;
    }
    run.phase = "recovering";
    this.save(run);
  }
  async establishRecoveryFences(runId: string): Promise<void> {
    const run = this.require(runId);
    if (run.phase !== "recovering" || run.writeAdmissionOpenedAt)
      throw new Error("Recovery fence phase mismatch");
    const context = migrationContext(run, run.manifest.mapping[0]!);
    await fenceBusinessDatabase(
      this.env.DB,
      context,
      run.authorityToken,
      run.revokedAuthorityToken ?? undefined,
    );
    await fenceBusinessDatabase(
      this.env.REGISTRY_DB,
      context,
      run.authorityToken,
      run.revokedAuthorityToken ?? undefined,
    );
    const current = this.require(runId);
    if (current.phase !== "recovering" || current.authorityToken !== run.authorityToken)
      throw new Error("Recovery authority changed");
    current.recoveryFencesReady = true;
    current.storageFenced = true;
    this.save(current);
  }
  finishRestore(runId: string, storeIds: string[]) {
    const run = this.require(runId);
    const expected = [
      "application",
      "registry",
      ...run.manifest.mapping.map((mapping) => `tracker:${mapping.space.id}`),
    ];
    if (canonicalSpaceJson(storeIds.toSorted()) !== canonicalSpaceJson(expected.toSorted()))
      throw new Error("Whole-store restoration set mismatch");
    if (
      run.phase !== "recovering" ||
      !run.recoveryFencesReady ||
      run.writeAdmissionOpenedAt ||
      storeIds.some((id) => !run.stores[id]?.restored)
    )
      throw new Error("Coordinated restore incomplete");
    run.phase = "restored";
    this.save(run);
  }
}
