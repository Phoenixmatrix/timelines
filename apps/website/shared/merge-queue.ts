export type QueueStatus =
  | "queued"
  | "merging"
  | "testing"
  | "advancing"
  | "landed"
  | "failed"
  | "cancelled"
  | "covered";
export type QueueFailureKind =
  | "build_failed"
  | "conflict"
  | "unsafe_conflict"
  | "repair_failed"
  | "infrastructure"
  | "configuration";
export interface QueueDecision {
  action: "combine" | "separate" | "repair" | "manual";
  reason: string;
  model: string | null;
  confidence: number | null;
}
export interface QueueFailure {
  queueId: string;
  repo: string;
  attempt?: number;
  commit: string;
  stage: "merge" | "gates" | "deployment";
  kind: QueueFailureKind;
  reason: string;
  runNumber: number | null;
  failedJobs: string[];
  conflictPaths: string[];
  classificationModel: string | null;
  repairModel: string | null;
  occurredAt: string;
}
export interface QueueEntry {
  id: string;
  repo: { id: string; space: string; name: string };
  commit: string;
  branch: string;
  sourceBranch: string;
  candidateBranch: string;
  status: QueueStatus;
  base: string | null;
  candidate: string | null;
  mergeRun: number | null;
  gateRun: number | null;
  deployRun: number | null;
  deployStatus: "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;
  coveredBy: string | null;
  issueIds: string[];
  remediationIssueId: string | null;
  failure: QueueFailure | null;
  decision: QueueDecision | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}
export interface ConflictFile {
  path: string;
  base: string;
  ours: string;
  theirs: string;
}
export interface QueueResolution {
  decision: QueueDecision;
  files: { path: string; content: string }[];
  repairModel: string | null;
}
export const queueSourceBranch = (commit: string): string => `gitmatrix/queue/${commit}`;
export const queueCandidateBranch = (commit: string, attempt = 0): string =>
  `gitmatrix/landing/queue-${commit}-${attempt}`;
export const isQueueSourceBranch = (branch: string): boolean =>
  /^gitmatrix\/queue\/[0-9a-f]{40}$/.test(branch);
