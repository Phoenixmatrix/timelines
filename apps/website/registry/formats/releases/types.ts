/** Wire shapes of the releases API (`/releases/…` and `/api/registry/releases/…`). */

export interface ReleaseAssetDto {
  name: string;
  label: string;
  size: number;
  sha256: string;
  contentType: string;
  downloads: number;
  createdBy: string | null;
  createdAt: string;
  /** Absolute URL: `<registry>/releases/<repo>/<project>/<tag>/download/<name>`. */
  browserDownloadUrl: string;
}

export interface ReleaseDto {
  id: string;
  repo: string;
  project: string;
  tag: string;
  title: string;
  /** Markdown source; the web UI renders it. */
  notes: string;
  draft: boolean;
  prerelease: boolean;
  /** Whether this is the project's current "latest" release. */
  latest: boolean;
  createdBy: string | null;
  createdAt: string;
  /** Null while the release is a draft. */
  publishedAt: string | null;
  assets: ReleaseAssetDto[];
  /** Absolute URL of the generated SHA256SUMS file. */
  checksumsUrl: string;
}

export interface ReleaseProjectDto {
  name: string;
  /** Releases the caller can see (drafts only count for writers). */
  releaseCount: number;
  latest: ReleaseDto | null;
  updatedAt: string;
}

export interface ReleaseListDto {
  releases: ReleaseDto[];
  total: number;
  page: number;
  perPage: number;
}

export interface CreateReleaseInput {
  tag: string;
  title?: string;
  notes?: string;
  draft?: boolean;
  prerelease?: boolean;
}

export interface UpdateReleaseInput {
  title?: string;
  notes?: string;
  /** Setting false publishes a draft (sets publishedAt). */
  draft?: boolean;
  prerelease?: boolean;
}
