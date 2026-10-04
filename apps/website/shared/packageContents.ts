import type { FormatId } from "@gitmatrix/formats/info";

export interface PackageContentEntry {
  /** Opaque identity within this version; never an unscoped blob storage key. */
  id: string;
  name: string;
  path: string;
  kind: "file" | "directory" | "manifest" | "layer" | "config";
  size: number | null;
  digest: string | null;
  /** Same-origin, authorization-checked attachment endpoint; null for directories. */
  downloadUrl: string | null;
  contentType?: string;
  checksums?: Record<string, string>;
  metadata?: Record<string, unknown>;
  /** Directories of distribution files: how many files sit anywhere below. */
  fileCount?: number;
  /** OCI child manifest selection; scoped to this version's manifest graph. */
  manifestDigest?: string;
  platform?: string;
}

export interface PackageContents {
  format: FormatId;
  version: string;
  /** Current directory (npm archive or distribution files), empty at the root. */
  path: string;
  files: PackageContentEntry[];
  total: number;
  offset: number;
  limit: number;
  metadata: Record<string, unknown>;
  /** Format-specific parsed JSON, or null when not present. */
  manifest: unknown;
  config: unknown;
}
