import type { CodeSource, SourceSnapshot, SourceDependency } from "../../shared/code-source.ts";

/** Original pre-Space payloads. Owner locators are evidence, never active authority. */
export interface LegacyTimelineRepo {
  id: string;
  owner: string;
  name: string;
  bookmark: string;
  source?: CodeSource;
  logicalBase?: SourceSnapshot;
  dependencies?: SourceDependency[];
}
export interface LegacyCheckpointRepo {
  id: string;
  owner: string;
  name: string;
  commit: string;
  base: string | null;
  changes: { changeId: string; commit: string }[];
  source?: SourceSnapshot;
  logicalBase?: SourceSnapshot;
  dependencies?: SourceDependency[];
}
export interface LegacyLandingRepo {
  id: string;
  owner: string;
  name: string;
  commit: string;
  base: string | null;
  merge: string | null;
  attempt: number;
  state:
    | "merging"
    | "testing"
    | "tested"
    | "advanced"
    | "conflict"
    | "failed"
    | "blocked_dependency";
  mergeRun: { id: string; number: number } | null;
  gateRun: { id: string; number: number } | null;
  reason: string | null;
  source?: SourceSnapshot;
  logicalBase?: SourceSnapshot;
  dependencies?: SourceDependency[];
  casIntent?: { base: string; candidate: string; tree: string };
  resultTree?: string;
  noop?: boolean;
}
export interface LegacyTimeline {
  id: string;
  slug: string;
  name: string;
  policy: "auto" | "approval";
  experimental: boolean;
  parentId: string | null;
  forkPoint: { commits: Record<string, string>; trackerCursor: number };
  repos: LegacyTimelineRepo[];
  status: "active" | "idle" | "waiting" | "landing" | "partly_landed" | "landed" | "abandoned";
  accountableId: string;
  startedBy: string;
  agentIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  endedAt?: string | null;
  migrationState?: "frozen" | "ready";
}
export interface LegacyCheckpoint {
  id: string;
  timelineId: string;
  number: number;
  repos: LegacyCheckpointRepo[];
  summary: string;
  actorId: string;
  accountableId: string;
  createdAt: string;
}
export interface LegacyLanding {
  id: string;
  timelineId: string;
  slug: string;
  checkpointId: string;
  checkpointNumber: number;
  state:
    | "merging"
    | "testing"
    | "advancing"
    | "conflict"
    | "failed"
    | "blocked_dependency"
    | "landed";
  repos: LegacyLandingRepo[];
  reason: string | null;
  trigger: "auto" | "approval" | "request";
  requestedBy: { actorId: string; accountableId: string };
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface LegacySourceFixtureInput {
  timeline: LegacyTimeline;
  checkpoint: LegacyCheckpoint | null;
  landing: LegacyLanding | null;
  approved?: boolean;
}
