/** Replay must supply a fresh body; streaming bodies are never copied or reused. */
export type RemoteRequest = (
  path: string,
  init?: RequestInit,
  replay?: () => RequestInit,
) => Promise<Response>;
export const REMOTE_ROOT = "/workspace/repo";
export const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_SOURCE_FILES = 100_000;
export const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
export interface SourceFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}
export interface SourceManifest {
  revision: string | null;
  files: SourceFile[];
}
export interface SyncRequest {
  baseRevision: string | null;
  revision: string;
  files: SourceFile[];
  deleted: string[];
}
export interface CommandSpec {
  id: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  kind?: "foreground" | "app" | "debug";
}
export interface RemoteProcess {
  id: string;
  status: "running" | "succeeded" | "failed" | "stopped";
  kind: "foreground" | "app" | "debug";
  exitCode?: number;
  startedAt: number;
  finishedAt?: number;
}
export interface RemoteStatus {
  running: boolean;
  expiresAt: number;
  processes: RemoteProcess[];
  sourceRevision?: string | null;
}
export interface ProcessLogs {
  text: string;
  nextOffset: number;
  done: boolean;
  exitCode?: number;
}

export interface OwnershipQuota {
  authority: string;
  state: string;
}
/**
 * The ownership Durable Object's merge of a written quota onto the stored one
 * (CORE-368). State only moves forward (pending, reserved, released), and a
 * write never drops or re-pins a stored reservation: `conflict` means the write
 * named a different authority, which the caller must refuse, keeping `quota`.
 * Pure, so it is shared with tests; the Worker cannot import client modules.
 */
export function mergeOwnershipQuota(
  stored: OwnershipQuota | undefined,
  written: OwnershipQuota | undefined,
): { quota?: OwnershipQuota; conflict: boolean } {
  if (!stored) return { ...(written ? { quota: written } : {}), conflict: false };
  if (!written) return { quota: stored, conflict: false };
  if (stored.authority !== written.authority) return { quota: stored, conflict: true };
  const rank = (state: string) => ["pending", "reserved", "released"].indexOf(state);
  return { quota: rank(stored.state) > rank(written.state) ? stored : written, conflict: false };
}
