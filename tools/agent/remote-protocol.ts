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
