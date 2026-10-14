import type { CUTOVER_CONSUMERS } from "./control.ts";

// Consumer quiescence for the fenced drain (contract §5, amended 2026-10-12).
//
// Tickets cover work admitted since the preparation release. Work an older
// release started has none, so a consumer drains only once that legacy work is
// provably over: either Cloudflare documents a maximum wall time for the
// invocation that has elapsed since the preparation release was serving, or
// (Workflows, for which no bound is documented) the provider's own instance
// list was settled authoritatively. Zero tickets or elapsed time alone never
// acknowledge anything.

type Consumer = (typeof CUTOVER_CONSUMERS)[number];

/**
 * The longest documented wall time an invocation that started on an older
 * release can keep running:
 * - Queue consumers: "Each consumer invocation has a maximum wall time of 15
 *   minutes." https://developers.cloudflare.com/queues/platform/limits/ (Apr 21 2026)
 * - Cron: "Scheduled Workers have a maximum wall time of 15 minutes per
 *   invocation." https://developers.cloudflare.com/workers/platform/limits/ (Oct 12 2026)
 * - Durable Object alarms: "Alarm handler invocations have a maximum wall time
 *   of 15 minutes." (the same limits page). Objects restart on "New Worker
 *   deployments with code updates", and a request that touches storage during
 *   that shutdown "will be stopped immediately and return an error"
 *   https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
 *   (Sep 30 2026); old object code may still run "for a short period of time
 *   (typically seconds to minutes)"
 *   https://developers.cloudflare.com/durable-objects/platform/known-issues/ (Jul 3 2026).
 * - waitUntil: "can extend execution for up to 30 seconds after the response is
 *   sent" (the limits page).
 * HTTP requests have no documented limit: their D1 writes meet the storage
 * fence, their Durable Object calls meet restarted objects that refuse fenced
 * admission, their Artifacts writes are covered by the ref barrier, and a late
 * registry blob without its D1 row is unreferenced and reclaimed by registry GC.
 */
export const DOCUMENTED_LEGACY_WALL_MS = 15 * 60_000;
/** Slack for clock skew and eventually consistent release propagation. */
export const QUIESCENCE_MARGIN_MS = 5 * 60_000;

/** Workflows the Worker binds. Their docs give no old-version bound. */
export const CUTOVER_WORKFLOWS = {
  "ci-run": "CI_RUN",
  "knowledge-build": "KNOWLEDGE_BUILD",
  "repo-purge": "REPO_PURGE",
} as const;
export type CutoverWorkflow = keyof typeof CUTOVER_WORKFLOWS;
export type CutoverWorkflowNames = Record<CutoverWorkflow, string>;
/** Production's workflow names (vite/instance.ts productionInstance), which its census must name exactly. */
export const PRODUCTION_WORKFLOW_NAMES: CutoverWorkflowNames = {
  "ci-run": "ci-run",
  "knowledge-build": "knowledge-build",
  "repo-purge": "repo-purge",
};
export const TERMINAL_WORKFLOW_STATUSES = ["complete", "errored", "terminated"];
/** Instances one census may list per Workflow, every status included. */
export const CENSUS_INSTANCE_LIMIT = 200_000;
/** D1 records of in-flight Workflow work one census cross-checks, per Workflow. */
export const CENSUS_IN_FLIGHT_LIMIT = 5_000;
/** How long a recorded deployment history stands before migration needs a fresh one. */
export const DEPLOYMENT_EVIDENCE_TTL_MS = 10 * 60_000;

/** Each consumer's legacy work and what proves it ended. */
const POLICY: Record<Consumer, { workflows: CutoverWorkflow[]; refs?: true }> = {
  "http-git-registry": { workflows: [], refs: true },
  queue: { workflows: [] },
  scheduled: { workflows: [] },
  "durable-registry": { workflows: [] },
  tracker: { workflows: [] },
  "registry-upload": { workflows: [] },
  "registry-repo": { workflows: [] },
  "registry-login": { workflows: [] },
  // Legacy sandbox jobs are driven by legacy CI Workflows; with those settled
  // and the object restarted, nothing issues their containers new work.
  "ci-sandbox": { workflows: ["ci-run"] },
  "ci-workflow": { workflows: ["ci-run"] },
  "repo-purge": { workflows: ["repo-purge"] },
  "knowledge-build": { workflows: ["knowledge-build"] },
  "knowledge-coordinator": { workflows: [] },
  assistant: { workflows: [] },
  "step-feed": { workflows: [] },
};

/** One provider-listed instance. */
export interface CensusInstance {
  id: string;
  status: string;
  createdOn: string | null;
}
/** The operator's export of the provider's own instance list, and its settlement. */
export interface WorkflowCensus {
  recordedAt: string;
  operatorId: string;
  /** The account and provider workflow the list came from. */
  account: string;
  workflowName: string;
  /** How many instances the provider listed, of every status. */
  listed: number;
  /** Listed instances that were not terminal, of any age. */
  instances: CensusInstance[];
  /** Instances this cutover terminated, by ID, recorded as each one is. */
  terminated: string[];
  /** Legacy instances (created before the bound start) not yet terminal: empty once settled. */
  remaining: string[];
  /**
   * In-flight D1 work whose instance exists but the list omitted: the census
   * is incomplete (another account, a skipped page) and proves nothing.
   */
  unlisted: string[];
  /** In-flight D1 work with no instance at all: nothing executes it, so nothing to drain. */
  orphaned: string[];
  settledAt: string | null;
}
/** One Worker deployment, as the provider lists it. */
export interface DeploymentRecord {
  id: string;
  createdOn: string;
  versions: { versionId: string; percentage: number }[];
}
/** The Worker's deployment history, checked when the census was recorded. */
export interface DeploymentEvidence {
  recordedAt: string;
  operatorId: string;
  account: string;
  worker: string;
  latestDeploymentId: string;
  /** Since when every deployment served only the preparation release. */
  soleSince: string;
}

export interface QuiescenceEvidence {
  /** When legacy work could last have started: the latest of preparation, version
   * upload, and the preparation release becoming the only one serving again. */
  boundStart: string;
  boundMs: number;
  marginMs: number;
  inspectedAt: string;
  versionId: string;
  deployments: { latestDeploymentId: string; soleSince: string; recordedAt: string };
  refPassClean?: true;
  workflows?: Partial<
    Record<CutoverWorkflow, { settledAt: string; terminated: string[]; orphaned: string[] }>
  >;
}

export type QuiescenceFinding =
  | { ok: true; evidence: QuiescenceEvidence }
  | { ok: false; code: string; message: string };

/**
 * When an older release could last have started work: never earlier than
 * preparation, and restarted whenever another release served since.
 */
export function legacyBoundStart(
  preparedAt: string | undefined,
  versionTimestamp: string | undefined,
  resetAt?: string | null,
): number | null {
  const prepared = Date.parse(preparedAt ?? "");
  const uploaded = Date.parse(versionTimestamp ?? "");
  if (!Number.isFinite(prepared) || !Number.isFinite(uploaded)) return null;
  const reset = Date.parse(resetAt ?? "");
  return Math.max(prepared, uploaded, Number.isFinite(reset) ? reset : 0);
}

/** Whether an instance an older release could have started: unknown age counts as older. */
export function isLegacyInstance(instance: CensusInstance, boundStart: number): boolean {
  const created = Date.parse(instance.createdOn ?? "");
  return !Number.isFinite(created) || created < boundStart;
}

/**
 * Since when the preparation release alone served: the oldest deployment of the
 * newest unbroken run that routes all traffic to it. A gradual (split)
 * deployment, or any other version, breaks the run. Listing fewer deployments
 * than really exist can only make this later, never earlier.
 */
export function preparationSoleSince(
  deployments: DeploymentRecord[],
  preparationVersionId: string,
): { ok: true; since: number; latestId: string } | { ok: false; code: string; message: string } {
  const sorted = deployments.toSorted((a, b) => Date.parse(b.createdOn) - Date.parse(a.createdOn));
  const sole = (deployment: DeploymentRecord) =>
    deployment.versions.length === 1 &&
    deployment.versions[0]!.versionId === preparationVersionId &&
    deployment.versions[0]!.percentage === 100;
  const latest = sorted[0];
  if (!latest)
    return {
      ok: false,
      code: "deployment_history_required",
      message: "The Worker's deployment history lists no deployment.",
    };
  if (!sole(latest))
    return {
      ok: false,
      code: "preparation_deployment_not_sole",
      message:
        "The latest deployment does not route all traffic to the preparation release; a gradual or other release leaves its work unbounded.",
    };
  let since = latest;
  for (const deployment of sorted.slice(1)) {
    if (!sole(deployment)) break;
    since = deployment;
  }
  return { ok: true, since: Date.parse(since.createdOn), latestId: latest.id };
}

export function legacyBoundElapsed(start: number | null, now: number): boolean {
  return start !== null && now - start >= DOCUMENTED_LEGACY_WALL_MS + QUIESCENCE_MARGIN_MS;
}

export function evaluateQuiescence(input: {
  consumer: Consumer;
  now: number;
  boundStart: number | null;
  versionId: string;
  preparationVersionId: string;
  storageFenced: boolean;
  activeTickets: number;
  refsClean: boolean;
  census: Partial<Record<CutoverWorkflow, WorkflowCensus>>;
  deployments: DeploymentEvidence | null;
}): QuiescenceFinding {
  const policy = POLICY[input.consumer];
  if (!input.storageFenced)
    return {
      ok: false,
      code: "storage_fence_required",
      message: "Both database write fences must be closed before a consumer can drain.",
    };
  if (input.versionId !== input.preparationVersionId)
    return {
      ok: false,
      code: "preparation_version_not_serving",
      message:
        "Another release is executing; legacy work is only bounded while the preparation release serves.",
    };
  if (input.activeTickets)
    return {
      ok: false,
      code: "execution_still_admitted",
      message: `${input.activeTickets} execution ticket(s) still require completion or authoritative termination evidence.`,
    };
  if (input.boundStart === null)
    return {
      ok: false,
      code: "preparation_time_unknown",
      message:
        "The run does not record when its preparation release began serving; legacy work cannot be bounded.",
    };
  if (!legacyBoundElapsed(input.boundStart, input.now))
    return {
      ok: false,
      code: "legacy_execution_bound_pending",
      message: `Work an older release started may still run until ${new Date(
        input.boundStart + DOCUMENTED_LEGACY_WALL_MS + QUIESCENCE_MARGIN_MS,
      ).toISOString()} (documented 15-minute wall time plus margin).`,
    };
  // Every consumer: only the preparation release served, as the provider lists
  // it, since the bound start. A Durable Object only sees its own version.
  if (!input.deployments)
    return {
      ok: false,
      code: "deployment_history_required",
      message:
        "Record the Worker's deployment history with workflow-census: the bound holds only if the preparation release alone served.",
    };
  if (
    Date.parse(input.deployments.recordedAt) <
    input.boundStart + DOCUMENTED_LEGACY_WALL_MS + QUIESCENCE_MARGIN_MS
  )
    return {
      ok: false,
      code: "deployment_history_stale",
      message:
        "The recorded deployment history predates the end of the legacy bound; record it again.",
    };
  if (policy.refs && !input.refsClean)
    return {
      ok: false,
      code: "artifacts_ref_reconciliation_incomplete",
      message: "A clean fenced ref pass must cover Git writes Artifacts already accepted.",
    };
  const workflows: NonNullable<QuiescenceEvidence["workflows"]> = {};
  for (const workflow of policy.workflows) {
    const census = input.census[workflow];
    if (!census)
      return {
        ok: false,
        code: "workflow_census_required",
        message: `Record the provider's ${workflow} instance list with workflow-census; its docs bound no older execution.`,
      };
    if (census.unlisted.length)
      return {
        ok: false,
        code: "workflow_census_incomplete",
        message: `${census.unlisted.length} in-flight ${workflow} instance(s) recorded in D1 exist but the census did not list them; record a complete census from the installation's own account.`,
      };
    if (!census.settledAt)
      return {
        ok: false,
        code: "legacy_workflow_still_running",
        message: `${census.remaining.length} ${workflow} instance(s) an older release started are not yet terminal.`,
      };
    workflows[workflow] = {
      settledAt: census.settledAt,
      terminated: [...census.terminated],
      orphaned: [...census.orphaned],
    };
  }
  return {
    ok: true,
    evidence: {
      boundStart: new Date(input.boundStart).toISOString(),
      boundMs: DOCUMENTED_LEGACY_WALL_MS,
      marginMs: QUIESCENCE_MARGIN_MS,
      inspectedAt: new Date(input.now).toISOString(),
      versionId: input.versionId,
      deployments: {
        latestDeploymentId: input.deployments.latestDeploymentId,
        soleSince: input.deployments.soleSince,
        recordedAt: input.deployments.recordedAt,
      },
      ...(policy.refs ? { refPassClean: true as const } : {}),
      ...(policy.workflows.length ? { workflows } : {}),
    },
  };
}

/** An operator's export: the provider's own lists, and where they came from. */
export interface CensusExport {
  account: string;
  worker: string;
  workflows: Record<CutoverWorkflow, { name: string; instances: CensusInstance[] }>;
  deployments: DeploymentRecord[];
}

const text = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/**
 * The deployed installation's workflow names, which a census must name
 * exactly: the CUTOVER_WORKFLOW_NAMES text binding (cloudflare.config.ts; a
 * self-hosted instance names its Workflows after itself), else production's.
 * A malformed binding fails closed.
 */
export function cutoverWorkflowNames(env: object): CutoverWorkflowNames {
  const raw = Reflect.get(env, "CUTOVER_WORKFLOW_NAMES") as unknown;
  if (raw === undefined) return PRODUCTION_WORKFLOW_NAMES;
  let parsed: unknown = null;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    // Reported below with every other malformed shape.
  }
  const names = {} as CutoverWorkflowNames;
  for (const workflow of Object.keys(CUTOVER_WORKFLOWS) as CutoverWorkflow[]) {
    const name =
      parsed && typeof parsed === "object" ? (Reflect.get(parsed, workflow) as unknown) : null;
    if (!text(name, 64)) throw new Error("The deployment's workflow names are malformed");
    names[workflow] = name;
  }
  return names;
}

/** Validates an operator's census export; malformed input is rejected, never trimmed. */
export function parseCensus(
  value: unknown,
  names: CutoverWorkflowNames = PRODUCTION_WORKFLOW_NAMES,
): CensusExport {
  if (!value || typeof value !== "object") throw new Error("Workflow census required");
  const account = Reflect.get(value, "account") as unknown;
  const worker = Reflect.get(value, "worker") as unknown;
  // An explicit account: an empty list from the wrong one must never read as settled.
  if (typeof account !== "string" || !/^[0-9a-f]{32}$/.test(account))
    throw new Error("Workflow census must name its Cloudflare account");
  if (!text(worker, 64)) throw new Error("Workflow census must name its Worker");
  const workflowsValue = Reflect.get(value, "workflows") as unknown;
  if (!workflowsValue || typeof workflowsValue !== "object")
    throw new Error("Workflow census must list every Workflow");
  const workflows = {} as CensusExport["workflows"];
  for (const workflow of Object.keys(CUTOVER_WORKFLOWS) as CutoverWorkflow[]) {
    const entry = Reflect.get(workflowsValue, workflow) as unknown;
    const name =
      entry && typeof entry === "object" ? (Reflect.get(entry, "name") as unknown) : null;
    const listed =
      entry && typeof entry === "object" ? (Reflect.get(entry, "instances") as unknown) : null;
    if (name !== names[workflow] || !Array.isArray(listed))
      throw new Error(`Workflow census must list every ${workflow} instance (${names[workflow]})`);
    if (listed.length > CENSUS_INSTANCE_LIMIT)
      throw new Error(`Workflow census lists too many ${workflow} instances`);
    const ids = new Set<string>();
    const instances = listed.map((item: unknown) => {
      const id = Reflect.get(item as object, "id") as unknown;
      const status = Reflect.get(item as object, "status") as unknown;
      const createdOn = Reflect.get(item as object, "createdOn") as unknown;
      if (!text(id) || !text(status, 32) || (createdOn !== null && typeof createdOn !== "string"))
        throw new Error("Malformed workflow census entry");
      if (ids.has(id)) throw new Error("Workflow census lists an instance twice");
      ids.add(id);
      return { id, status, createdOn: createdOn as string | null };
    });
    workflows[workflow] = { name, instances };
  }
  const deploymentsValue = Reflect.get(value, "deployments") as unknown;
  if (
    !Array.isArray(deploymentsValue) ||
    !deploymentsValue.length ||
    deploymentsValue.length > 1_000
  )
    throw new Error("Workflow census must include the Worker's deployment history");
  const deployments = deploymentsValue.map((item: unknown) => {
    const id = Reflect.get(item as object, "id") as unknown;
    const createdOn = Reflect.get(item as object, "createdOn") as unknown;
    const versions = Reflect.get(item as object, "versions") as unknown;
    if (
      !text(id) ||
      !text(createdOn, 64) ||
      !Number.isFinite(Date.parse(createdOn)) ||
      !Array.isArray(versions) ||
      !versions.length
    )
      throw new Error("Malformed deployment history entry");
    return {
      id,
      createdOn,
      versions: versions.map((version: unknown) => {
        const versionId = Reflect.get(version as object, "versionId") as unknown;
        const percentage = Reflect.get(version as object, "percentage") as unknown;
        if (
          !text(versionId) ||
          typeof percentage !== "number" ||
          percentage < 0 ||
          percentage > 100
        )
          throw new Error("Malformed deployment version");
        return { versionId, percentage };
      }),
    };
  });
  return { account, worker, workflows, deployments };
}
