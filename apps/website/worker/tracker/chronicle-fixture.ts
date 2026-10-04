// A synthetic tracker history for the Chronicle (CORE-251), for development
// and E2E only (POST /api/dev/chronicle). It is made of real mutations,
// applied in time order through the tracker's own store under a controlled
// clock: people and agents claim, renew, park on questions, checkpoint,
// release, let leases lapse, complete and cancel, across `days`. Everything
// is deterministic in `seed`, so a run is reproducible.
//
// Issue 0 is the showcase: an agent's two-hour span on a known day, which
// E2E links to real work (a commit, its CI run, a release-note entry).

import type { Mutation, MutationRequest, MutationResult } from "../../shared/tracker.ts";
import type { Access } from "./store.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface ChronicleFixtureOptions {
  /** Issues to make, 1–2000. */
  issues: number;
  days: number;
  /** The history ends here (ms); nothing is dated after it. */
  end: number;
  seed: number;
  /** A new team's key; its issues are the fixture's. */
  team: string;
}

export interface ChronicleFixtureResult {
  team: string;
  issues: number;
  /** Mutations applied, and those the tracker refused (skipped with the rest of their issue's plan). */
  applied: number;
  skipped: number;
  from: string;
  to: string;
  showcase: { id: string; key: string; holder: string; claimedAt: string; completedAt: string };
}

/** mulberry32: small, fast, deterministic. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const VERBS = [
  "Cache",
  "Index",
  "Retry",
  "Paginate",
  "Stream",
  "Validate",
  "Shard",
  "Debounce",
  "Profile",
  "Document",
  "Migrate",
  "Audit",
];
const THINGS = [
  "CI logs by job",
  "the release feed",
  "webhook deliveries",
  "search results",
  "package uploads",
  "preview teardown",
  "lease renewals",
  "the merge queue",
  "atlas snapshots",
  "token rotation",
  "mirror syncs",
  "issue history",
  "avatar uploads",
  "the timeline graph",
];

type Action = { at: number; issue: number; run: () => void };

export function runChronicleFixture(
  apply: (access: Access, at: number, request: MutationRequest) => MutationResult,
  people: Access[],
  agents: Access[],
  options: ChronicleFixtureOptions,
): ChronicleFixtureResult {
  if (!people.length) throw new Error("The fixture needs at least one person.");
  const rand = random(options.seed);
  const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)]!;
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const end = options.end;
  const start = end - options.days * DAY;
  const owner = people[0]!;
  const workers = [...agents, ...agents, ...people];
  let operation = 0;
  let applied = 0;
  let skipped = 0;
  const versions = new Map<string, number>();
  const keys = new Map<string, string>();
  const tokens = new Map<number, string>();
  const failed = new Set<number>();
  const send = (who: Access, at: number, ...mutations: Mutation[]) => {
    const result = apply(who, at, {
      operationId: `chronicle-${options.team}-${options.seed}-${++operation}`,
      mutations,
    });
    applied++;
    for (const event of result.events)
      if (event.entityType === "issue" && event.entity && "version" in event.entity) {
        versions.set(event.entityId, event.entity.version);
        if ("key" in event.entity) keys.set(event.entityId, event.entity.key);
      }
    return result;
  };

  const teamId = `chronicle-${options.team}-team`;
  send(owner, start, {
    kind: "team.create",
    id: teamId,
    data: { key: options.team, name: "Chronicle fixture" },
  });

  const actions: Action[] = [];
  const at = (issue: number, time: number, run: () => void) => {
    if (time < end) actions.push({ at: Math.round(time), issue, run });
  };
  const ids = Array.from(
    { length: options.issues },
    (_, i) => `chronicle-${options.team.toLowerCase()}-${i}`,
  );
  const created: number[] = [];
  let showcase: ChronicleFixtureResult["showcase"] | null = null;

  // Every 15th issue (from the second) is a PRD; the three after it are its sub-issues.
  const parentOf = (i: number) => (i % 15 >= 2 && i % 15 <= 4 ? i - (i % 15) + 1 : -1);
  for (let i = 0; i < options.issues; i++) {
    const own = i === 0 ? start + MINUTE : start + HOUR + between(0, 0.97) * (end - start - HOUR);
    const parent = parentOf(i);
    created[i] = Math.min(
      parent >= 0 ? Math.max(own, created[parent]! + 5 * MINUTE) : own,
      end - 2 * HOUR,
    );
  }
  for (let i = 0; i < options.issues; i++) {
    const id = ids[i]!;
    const parent = parentOf(i);
    const isParent = i % 15 === 1;
    const createdAt = created[i]!;
    const backlog = i > 0 && !isParent && rand() < 0.12;
    at(i, createdAt, () =>
      send(owner, createdAt, {
        kind: "issue.create",
        id,
        data: {
          teamId,
          title: `${pick(VERBS)} ${pick(THINGS)}`,
          type: isParent ? "prd" : rand() < 0.25 ? "bug" : "task",
          priority: Math.floor(rand() * 4) as 0 | 1 | 2 | 3,
          ...(backlog ? { status: "backlog" as const } : {}),
          ...(parent >= 0 ? { parentId: ids[parent]! } : {}),
        },
      }),
    );
    // A related or blocking link to an earlier issue, now and then.
    if (i > 2 && rand() < 0.12) {
      // Never the showcase: its history stays exactly as planned.
      const other = 1 + Math.floor(rand() * (i - 1));
      const when = Math.max(createdAt, created[other]!) + between(5, 120) * MINUTE;
      const kind = backlog ? "blocks" : "related";
      at(i, when, () =>
        send(owner, when, {
          kind: "link.add",
          id: `${id}-link`,
          data: { fromId: ids[other]!, toId: id, kind },
        }),
      );
    }
    if (backlog || isParent) continue;

    const update = (who: Access, time: number, data: Record<string, unknown>) =>
      send(who, time, {
        kind: "issue.update",
        id,
        expectedVersion: versions.get(id) ?? 1,
        data,
      } as Mutation);
    if (i > 0 && rand() < 0.06) {
      const when = createdAt + between(2, 72) * HOUR;
      at(i, when, () => update(owner, when, { status: "canceled", closeReason: "not_planned" }));
      continue;
    }

    // Work: one to three attempts, each a span of renewals with an outcome.
    let t =
      i === 0
        ? Math.floor((end - 5 * DAY) / DAY) * DAY + 10 * HOUR
        : createdAt + between(10, 20 * 60) * MINUTE;
    const attempts = i === 0 ? 1 : 1 + Math.floor(rand() * rand() * 3);
    for (let attempt = 0; attempt < attempts && t < end; attempt++) {
      const holder = i === 0 ? (agents[0] ?? owner) : pick(workers);
      const last = attempt === attempts - 1;
      // The last attempt of recent work may still be going on at the end.
      const ongoing = i !== 0 && last && t > end - 2 * DAY && rand() < 0.35;
      const length = i === 0 ? 2 * HOUR : ongoing ? end - t : between(20, 300) * MINUTE;
      const claimAt = t;
      at(i, claimAt, () => {
        const result = send(holder, claimAt, {
          kind: "issue.claim",
          id,
          data: { agent: holder.actorId === holder.principalId ? "laptop" : "session" },
        });
        tokens.set(i, String(result.results[0]!.leaseToken));
      });
      // Park on a question in some spans: a person answers hours later.
      const park = i !== 0 && rand() < 0.1 ? claimAt + length / 2 : null;
      const answer = park ? park + between(1, 20) * HOUR : null;
      let renew = claimAt + between(10, 14) * MINUTE;
      const stop = claimAt + length;
      while (renew < stop) {
        const time = renew;
        if (park && time > park) {
          if (time < answer!) {
            renew = answer! + between(2, 20) * MINUTE;
            const resume = renew;
            at(i, park, () =>
              send(holder, park, {
                kind: "request.open",
                id: `${id}-ask-${attempt}`,
                data: {
                  issueId: id,
                  kind: "question",
                  prompt: "Which retention window should this use?",
                  leaseToken: tokens.get(i)!,
                },
              }),
            );
            at(i, answer!, () =>
              send(owner, answer!, {
                kind: "request.answer",
                id: `${id}-ask-${attempt}`,
                data: { answer: "Thirty days, like the rest." },
              }),
            );
            at(i, resume, () => {
              const result = send(holder, resume, { kind: "issue.resume", id, data: {} });
              tokens.set(i, String(result.results[0]!.leaseToken));
            });
            continue;
          }
        }
        at(i, time, () =>
          send(holder, time, { kind: "issue.renew", id, data: { leaseToken: tokens.get(i)! } }),
        );
        renew += between(10, 14) * MINUTE;
      }
      const checkpoint = claimAt + (i === 0 ? HOUR : length * between(0.3, 0.8));
      if (i === 0 || rand() < 0.5)
        at(i, checkpoint, () =>
          send(holder, checkpoint, {
            kind: "comment.add",
            id: `${id}-checkpoint-${attempt}`,
            data: { issueId: id, kind: "checkpoint", body: `Halfway: ${pick(THINGS)} done.` },
          }),
        );
      const outcome =
        i === 0 || (last && !ongoing)
          ? "complete"
          : ongoing
            ? "hold"
            : rand() < 0.5
              ? "release"
              : "lapse";
      const finish = Math.max(stop, renew - 10 * MINUTE);
      if (outcome === "complete")
        at(i, finish, () =>
          send(holder, finish, {
            kind: "issue.complete",
            id,
            data: { leaseToken: tokens.get(i)!, evidence: `Shipped; ${pick(THINGS)} verified.` },
          }),
        );
      else if (outcome === "release")
        at(i, finish, () =>
          send(holder, finish, { kind: "issue.release", id, data: { leaseToken: tokens.get(i)! } }),
        );
      if (i === 0)
        showcase = {
          id,
          key: "",
          holder: holder.actorId,
          claimedAt: new Date(claimAt).toISOString(),
          completedAt: new Date(finish).toISOString(),
        };
      // The next attempt comes after this lease is over (lapsed ones expire 15 minutes on).
      t = finish + 15 * MINUTE + between(30, 48 * 60) * MINUTE;
    }
  }

  actions.sort((a, b) => a.at - b.at || a.issue - b.issue);
  for (const action of actions) {
    if (failed.has(action.issue)) continue;
    try {
      action.run();
    } catch {
      // The tracker refused it (a blocker, a lease the plan didn't foresee):
      // the rest of this issue's plan would build on it, so it stops here.
      failed.add(action.issue);
      skipped++;
    }
  }
  const shown = showcase as ChronicleFixtureResult["showcase"] | null;
  if (!shown) throw new Error("The showcase issue wasn't planned.");
  return {
    team: options.team,
    issues: options.issues,
    applied,
    skipped,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    showcase: { ...shown, key: keys.get(shown.id) ?? "" },
  };
}
