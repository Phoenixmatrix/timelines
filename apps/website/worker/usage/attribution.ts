// The usage report's costs by person, agent and timeline (CORE-222). CI is
// attributed through each sandbox job's run (who started it, the agent acting
// for them, the timeline it ran for); Workers AI through ai_usage, which
// records who asked when the work knew (worker/usage/ai.ts). Both are priced
// with the report's own catalog prices over its window. What no one person,
// agent or timeline caused is listed with the reason instead: storage, builds
// that batch several people's pushes, background work, and calls from before
// attribution was recorded. In a Space's report, people and agents without a
// live grant to it are counted together rather than named; a person's report
// names only them.

import type {
  AttributedSpend,
  UnattributedSpend,
  UsageAttribution,
  UsageLine,
  UsageScope,
} from "../../shared/usage.ts";
import { instanceSize } from "./containers.ts";
import type { SnapshotRow } from "./report.ts";

/** At most this many people, agents and timelines each, costliest first. */
export const ATTRIBUTION_LIMIT = 100;

/** The id of everyone from outside a Space or person, in its report. */
export const OUTSIDE = "outside";

/** AI work for everyone in a repository at once, never one person's. */
const BUILD_FEATURES = new Set(["knowledge", "wiki"]);
const BACKGROUND_FEATURES = new Set(["release_notes", "merge_queue"]);

const UNATTRIBUTED: Record<
  Exclude<UnattributedSpend["id"], "storage">,
  { label: string; reason: string }
> = {
  "ci-system": {
    label: "CI no one started",
    reason: "Runs Gitmatrix starts by itself have no person or agent behind them.",
  },
  "ai-builds": {
    label: "Knowledge and wiki builds",
    reason:
      "A build covers several pushes at once, often from different people, so it is nobody's in particular.",
  },
  "ai-background": {
    label: "Release notes and merge queue",
    reason: "These run by themselves after releases and pushes, for everyone in the repository.",
  },
  "ai-unknown": {
    label: "Other AI",
    reason:
      "Calls recorded before costs were attributed to people and agents, or made outside anyone's request.",
  },
};

export interface AttributionInput {
  /** The Space or person, or null for the whole Instance. */
  scope: UsageScope | null;
  /** The report's activity window (days, inclusive) and the day after it. */
  from: string;
  to: string;
  asOf: string;
  /** Storage's monthly cost in the report: the scope's, whoever wrote it. */
  storageUsd: number;
  /** The report's pricing: activity rows over the whole window, priced as lines. */
  price: (rows: SnapshotRow[]) => UsageLine[];
}

interface Tally {
  ai: Map<string, { calls: number; input: number; output: number; total: number }>;
  ciJobs: number;
  ciSeconds: number;
  vcpu: number;
  memory: number;
  disk: number;
}

const tally = (): Tally => ({
  ai: new Map(),
  ciJobs: 0,
  ciSeconds: 0,
  vcpu: 0,
  memory: 0,
  disk: 0,
});

type Kind = "person" | "agent" | "timeline";

export async function attributionReport(
  d1: D1Database,
  input: AttributionInput,
): Promise<UsageAttribution> {
  const buckets = new Map<string, Tally>();
  const bucket = (key: string) => {
    let found = buckets.get(key);
    if (!found) buckets.set(key, (found = tally()));
    return found;
  };
  const scope = input.scope?.kind === "instance" ? null : input.scope;
  // Who a scope's people are: the person, or a Space's live explicit grants.
  const members = scope ? await membersOf(d1, scope) : null;
  const who = (actor: string | null, agent: string | null) => {
    if (!actor && !agent) return null;
    const outside = members !== null && !(actor && members.has(actor));
    if (agent) return `agent:${outside ? OUTSIDE : agent}`;
    return `person:${outside ? OUTSIDE : actor}`;
  };
  // A timeline is its Space's: slugs repeat across Spaces.
  const timeline = (space: string, slug: string | null) =>
    slug ? [`timeline:${space}/${slug}`] : [];

  const ai = await d1
    .prepare(
      `SELECT scope_id, actor_id, agent_id, timeline, feature, model, SUM(calls) AS calls,
              SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(total_tokens) AS total
         FROM ai_usage
        WHERE day >= ?1 AND day <= ?2 AND (?3 IS NULL OR (scope_kind = ?3 AND scope_id = ?4))
          -- A Space's own provider (CORE-294) bills its key, not Workers AI.
          AND model NOT LIKE 'openrouter:%' AND model NOT LIKE 'typesafe:%'
        GROUP BY scope_kind, scope_id, actor_id, agent_id, timeline, feature, model`,
    )
    .bind(input.from, input.to, scope?.kind ?? null, scope?.id ?? null)
    .all<{
      scope_id: string;
      actor_id: string;
      agent_id: string;
      timeline: string;
      feature: string;
      model: string;
      calls: number;
      input: number;
      output: number;
      total: number;
    }>();
  for (const r of ai.results) {
    const keys = [
      who(r.actor_id || null, r.agent_id || null) ??
        (BUILD_FEATURES.has(r.feature)
          ? "ai-builds"
          : BACKGROUND_FEATURES.has(r.feature)
            ? "ai-background"
            : "ai-unknown"),
      ...timeline(r.scope_id, r.timeline || null),
    ];
    for (const key of keys) {
      const models = bucket(key).ai;
      const sum = models.get(r.model) ?? { calls: 0, input: 0, output: 0, total: 0 };
      sum.calls += Number(r.calls);
      sum.input += Number(r.input);
      sum.output += Number(r.output);
      sum.total += Number(r.total);
      models.set(r.model, sum);
    }
  }

  // A run's timeline: a preview's, its work source's, or the one it lands
  // (one integration receipt per landing and repository).
  const ci = await d1
    .prepare(
      `SELECT r.actor_id AS actor_id, r.agent_id AS agent_id,
              COALESCE(r.timeline_slug, s.timeline_slug, w.timeline_slug) AS timeline,
              COALESCE(s.space_id, w.space_id, o.space_id) AS space,
              json_extract(j.spec, '$.instance') AS instance, COUNT(*) AS jobs,
              COALESCE(SUM((julianday(j.finished_at) - julianday(j.started_at)) * 86400), 0) AS seconds
         FROM ci_jobs j
         JOIN ci_runs r ON r.id = j.run_id
         JOIN repos o ON o.id = j.repo_id
         LEFT JOIN timeline_work_sources s ON s.source_id = r.source_id
         LEFT JOIN source_integration_receipts i
           ON i.landing_id = r.landing_id AND i.repo_id = r.repo_id
         LEFT JOIN timeline_work_sources w ON w.source_id = i.source_id
        -- Repositories are Space content: a person's report has no CI of its own.
        WHERE (?3 IS NULL OR (?3 = 'space' AND o.space_id = ?4))
          AND j.runner = 'sandbox' AND j.started_at IS NOT NULL
          AND j.finished_at >= ?1 AND j.finished_at < ?2
        GROUP BY 1, 2, 3, 4, 5`,
    )
    .bind(input.from, input.asOf, scope?.kind ?? null, scope?.id ?? null)
    .all<{
      actor_id: string | null;
      agent_id: string | null;
      timeline: string | null;
      space: string;
      instance: string | null;
      jobs: number;
      seconds: number;
    }>();
  for (const r of ci.results) {
    const seconds = Math.max(0, Number(r.seconds));
    const size = instanceSize(r.instance);
    const keys = [who(r.actor_id, r.agent_id) ?? "ci-system", ...timeline(r.space, r.timeline)];
    for (const key of keys) {
      const t = bucket(key);
      t.ciJobs += Number(r.jobs);
      t.ciSeconds += seconds;
      t.vcpu += seconds * size.vcpu;
      t.memory += seconds * size.memoryGib;
      t.disk += seconds * size.diskGb;
    }
  }

  const priced = (t: Tally) => {
    const row = (
      construct: SnapshotRow["construct"],
      item: string,
      metric: string,
      quantity: number,
    ) =>
      ({
        day: input.from,
        construct,
        item,
        metric,
        kind: "activity",
        quantity,
        estimated: false,
        method: "",
        collected_at: input.asOf,
      }) satisfies SnapshotRow;
    const rows: SnapshotRow[] = [];
    for (const [model, sum] of t.ai)
      rows.push(
        row("workers_ai", model, "input_tokens", sum.input),
        row("workers_ai", model, "output_tokens", sum.output),
        row("workers_ai", model, "total_tokens", sum.total),
      );
    if (t.ciJobs)
      rows.push(
        row("ci", "sandbox", "vcpu_seconds", t.vcpu),
        row("ci", "sandbox", "memory_gib_seconds", t.memory),
        row("ci", "sandbox", "disk_gb_seconds", t.disk),
      );
    const lines = rows.length ? input.price(rows) : [];
    const usd = (construct: string) =>
      lines.filter((l) => l.construct === construct).reduce((sum, l) => sum + l.monthlyUsd, 0);
    return { aiUsd: usd("workers_ai"), ciUsd: usd("ci") };
  };

  const spends: Record<Kind, AttributedSpend[]> = { person: [], agent: [], timeline: [] };
  const unattributed: UnattributedSpend[] = [
    {
      id: "storage",
      label: "Storage",
      costUsd: input.storageUsd,
      reason:
        "Repositories, databases, search indexes and files belong to the Space, whoever wrote them.",
    },
  ];
  for (const [key, t] of buckets) {
    const { aiUsd, ciUsd } = priced(t);
    const colon = key.indexOf(":");
    if (colon < 0) {
      const id = key as Exclude<UnattributedSpend["id"], "storage">;
      unattributed.push({ id, ...UNATTRIBUTED[id], costUsd: aiUsd + ciUsd });
      continue;
    }
    const id = key.slice(colon + 1);
    spends[key.slice(0, colon) as Kind].push({
      id,
      name: id,
      accountable: null,
      ciUsd,
      aiUsd,
      totalUsd: ciUsd + aiUsd,
      ciJobs: t.ciJobs,
      ciMinutes: Math.round((t.ciSeconds / 60) * 10) / 10,
      aiCalls: [...t.ai.values()].reduce((sum, m) => sum + m.calls, 0),
    });
  }
  const sum = (list: { costUsd?: number; totalUsd?: number }[]) =>
    list.reduce((total, s) => total + (s.totalUsd ?? s.costUsd ?? 0), 0);
  const attributedUsd = sum(spends.person) + sum(spends.agent);
  // Names for what is shown: the costliest of each.
  const ranked = (list: AttributedSpend[]) =>
    list
      .toSorted((a, b) => b.totalUsd - a.totalUsd || a.id.localeCompare(b.id))
      .slice(0, ATTRIBUTION_LIMIT);
  const shown = {
    people: ranked(spends.person),
    agents: ranked(spends.agent),
    timelines: ranked(spends.timeline),
  };
  await name(d1, shown, scope);
  const order: UnattributedSpend["id"][] = [
    "storage",
    "ci-system",
    "ai-builds",
    "ai-background",
    "ai-unknown",
  ];
  return {
    from: input.from,
    to: input.to,
    ...shown,
    attributedUsd,
    activityUsd: attributedUsd + sum(unattributed.filter((u) => u.id !== "storage")),
    unattributed: unattributed.toSorted((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
  };
}

/**
 * A scope's people: the person, or a Space's live explicit grants (joined to
 * current Organization membership). Organization roles alone name no one.
 */
async function membersOf(d1: D1Database, scope: UsageScope): Promise<Set<string>> {
  if (scope.kind !== "space") return new Set([scope.id]);
  const { results } = await d1
    .prepare(
      `SELECT g.account_id AS id FROM space_grants g
         JOIN spaces s ON s.id = g.space_id
         JOIN organization_members m
           ON m.organization_id = s.organization_id AND m.account_id = g.account_id
        WHERE g.space_id = ?1`,
    )
    .bind(scope.id)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/**
 * Names in place: people's, agents' with their accountable person, and
 * timelines' (with their Space on the Instance's report).
 */
async function name(
  d1: D1Database,
  shown: { people: AttributedSpend[]; agents: AttributedSpend[]; timelines: AttributedSpend[] },
  scope: UsageScope | null,
): Promise<void> {
  const agentIds = shown.agents.map((a) => a.id).filter((id) => id !== OUTSIDE);
  const agents = agentIds.length
    ? (
        await d1
          .prepare(
            `SELECT id, name, accountable_id FROM agents WHERE id IN (SELECT value FROM json_each(?1))`,
          )
          .bind(JSON.stringify(agentIds))
          .all<{ id: string; name: string; accountable_id: string }>()
      ).results
    : [];
  const accountIds = new Set([
    ...shown.people.map((p) => p.id),
    ...agents.map((a) => a.accountable_id),
  ]);
  accountIds.delete(OUTSIDE);
  const accounts = accountIds.size
    ? (
        await d1
          .prepare(
            `SELECT id, slug, display_name FROM accounts WHERE id IN (SELECT value FROM json_each(?1))`,
          )
          .bind(JSON.stringify([...accountIds]))
          .all<{ id: string; slug: string; display_name: string }>()
      ).results
    : [];
  const account = new Map(accounts.map((a) => [a.id, a]));
  const spaceIds = [...new Set(shown.timelines.map((t) => t.id.slice(0, t.id.indexOf("/"))))];
  const spaces = new Map(
    (spaceIds.length && !scope
      ? (
          await d1
            .prepare(`SELECT id, slug FROM spaces WHERE id IN (SELECT value FROM json_each(?1))`)
            .bind(JSON.stringify(spaceIds))
            .all<{ id: string; slug: string }>()
        ).results
      : []
    ).map((s) => [s.id, s.slug]),
  );
  const outside = scope?.kind === "space" ? "this Space" : "this person";
  const personName = (id: string) => {
    const a = account.get(id);
    return a ? a.display_name || a.slug : "Deleted account";
  };
  for (const p of shown.people)
    p.name = p.id === OUTSIDE ? `People outside ${outside}` : personName(p.id);
  const agentRow = new Map(agents.map((a) => [a.id, a]));
  for (const a of shown.agents) {
    if (a.id === OUTSIDE) {
      a.name = `Agents outside ${outside}`;
      continue;
    }
    const row = agentRow.get(a.id);
    a.name = row?.name ?? "Deleted agent";
    a.accountable = row ? { id: row.accountable_id, name: personName(row.accountable_id) } : null;
  }
  for (const t of shown.timelines) {
    const slash = t.id.indexOf("/");
    const slug = t.id.slice(slash + 1);
    const space = spaces.get(t.id.slice(0, slash));
    t.name = space ? `${slug} (@${space})` : slug;
  }
}
