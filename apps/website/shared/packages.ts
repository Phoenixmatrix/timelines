// The artifact store as the web app and gm see it: owners' packages, each
// package's publish history (the console), sources, feeds and proxies.

import type { FormatId, RepoKind, Visibility as FeedVisibility } from "@gitmatrix/formats/info";

export type { FeedVisibility, FormatId, RepoKind };
export type PublishStatus = "active" | "yanked" | "deprecated" | "deleted";
export type PackageAccess = "read" | "write" | "admin";

export function packagesPath(owner: string): string {
  return `/${owner}/-/packages`;
}

/** Package names keep their slashes in the page URL (`@scope/name`, `team/image`). */
export function packagePath(owner: string, format: FormatId, name: string): string {
  return `${packagesPath(owner)}/${format}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

export interface PackageSummary {
  id: string;
  format: FormatId;
  name: string;
  /** The feed's key (the owner's slug for their own registry). */
  feed: string;
  latest: string | null;
  lastPublishedAt: string | null;
  /** Versions that are still installable. */
  versions: number;
  /** Publishes in the last 24 hours, and per hour over them (oldest first). */
  publishes24h: number;
  spark: number[];
  /** Repositories that publish it (`owner/name`). */
  sources: string[];
}

export interface FeedSummary {
  id: string;
  key: string;
  format: FormatId;
  kind: RepoKind;
  visibility: FeedVisibility;
  description: string;
  upstream: string | null;
  /** Virtual feeds: member keys, in resolution order. */
  members: string[];
  retention: Retention;
  packages: number;
}

export interface Retention {
  keepLatest?: number;
  maxAgeDays?: number;
  deleteUntagged?: boolean;
}

export interface OwnerPackages {
  owner: { id: string; slug: string; displayName: string; kind: "user" | "org" };
  access: PackageAccess | null;
  /** Where clients reach the registry (the site's public URL). */
  registryUrl: string;
  packages: PackageSummary[];
  feeds: FeedSummary[];
}

export interface PackageSource {
  repoId: string;
  /** `owner/name`, or null when the repository is gone. */
  repo: string | null;
  grantedBy: string | null;
  grantedAt: string;
  /** Publishes from it, and the last one. */
  publishes: number;
  lastPublishedAt: string | null;
}

export interface PackageDetail {
  package: PackageSummary;
  feed: FeedSummary;
  owner: OwnerPackages["owner"];
  registryUrl: string;
  access: PackageAccess;
  /** npm dist-tags and friends: tag → version. */
  tags: Record<string, string>;
  sources: PackageSource[];
  /** Bulk actions this format supports. */
  actions: BulkActionKind[];
  totals: { publishes: number; active: number; firstPublishedAt: string | null };
}

export interface PublishRow {
  id: string;
  version: string;
  status: PublishStatus;
  digest: string | null;
  size: number | null;
  at: string;
  /** Where it came from; null for a person publishing by hand. */
  repo: string | null;
  ref: string | null;
  commit: string | null;
  runNumber: number | null;
  actor: string;
  via: string;
  tags: string[];
}

export interface Facet {
  /** `null` is "none" (published by hand, no branch). */
  value: string | null;
  count: number;
}

export interface Histogram {
  /** ISO time of the first bucket, and each bucket's width. */
  start: string;
  bucketMs: number;
  /** Per bucket: installable, and yanked/deprecated/deleted. */
  active: number[];
  removed: number[];
}

export interface PublishPage {
  query: string;
  /** Matching publishes, and this window of them (newest first). */
  total: number;
  offset: number;
  rows: PublishRow[];
  /** Counts for each facet under every other filter (only with offset 0). */
  facets?: { source: Facet[]; branch: Facet[]; status: Facet[] };
  histogram?: Histogram;
}

export type BulkActionKind = "delete" | "yank" | "unyank" | "deprecate" | "tag";

export interface BulkActionRequest {
  action: BulkActionKind;
  /** Either explicit versions or everything a query matches. */
  versions?: string[];
  query?: string;
  /** For `tag`: the tag to point at the (single) version. */
  tag?: string;
  reason?: string;
}

export interface BulkActionResult {
  done: string[];
  failed: { version: string; error: string }[];
  /** For query actions: matches left over the per-call limit. */
  remaining: number;
}

export interface CreateFeedRequest {
  format: FormatId;
  kind: "remote" | "virtual";
  /** Becomes `<owner>.<name>`. */
  name: string;
  visibility?: FeedVisibility;
  description?: string;
  upstream?: string;
  upstreamUsername?: string;
  upstreamPassword?: string;
  members?: string[];
}

export interface UpdateFeedRequest {
  visibility?: FeedVisibility;
  description?: string;
  retention?: Retention;
  upstream?: string;
  upstreamUsername?: string;
  upstreamPassword?: string;
  members?: string[];
}

/** Publishes from a commit or a CI run, for the commit and run pages. */
export interface Published {
  rows: (PublishRow & { format: FormatId; package: string; feed: string })[];
}

export interface NpmLoginRequest {
  publicId: string;
  hostname: string | null;
  registry: string;
  status: "pending" | "done" | "expired";
}

// ── The console's query language ───────────────────────────────────────────
//
//   1.4            versions containing "1.4"
//   source:web     from a repository (`web` or `owner/web`); `source:none` by hand
//   branch:main    built from a branch (`ref:` works too); globs: `release/*`
//   status:active  active, yanked, deprecated or deleted
//   since:7d       published in the last 7 days (m, h, d, w), or since a date
//   until:2026-09-01
//   commit:4f2a    from a commit (prefix)
//   run:128        from CI run #128
//   by:alice       published by someone (slug or `owner/repo` for CI)
//   tag:latest     a version a tag points at
//
// Prefix a filter or a word with `-` to exclude it. Filters on the same key are ORed,
// different keys ANDed.

export const QUERY_KEYS = [
  "source",
  "branch",
  "status",
  "since",
  "until",
  "commit",
  "run",
  "by",
  "tag",
] as const;
export type QueryKey = (typeof QUERY_KEYS)[number];

const ALIASES: Record<string, QueryKey> = { ref: "branch", repo: "source", is: "status" };

export interface QueryFilter {
  key: QueryKey;
  value: string;
  negated: boolean;
}

export interface ParsedQuery {
  filters: QueryFilter[];
  /** Free text (matched against versions), and `-text` (excluded). */
  text: string[];
  excluded: string[];
  /** Tokens that look like filters but aren't. */
  unknown: string[];
}

export function tokenize(query: string): string[] {
  const tokens: string[] = [];
  const pattern = /(-?[A-Za-z]+:)?"([^"]*)"|\S+/g;
  for (const match of query.matchAll(pattern)) {
    tokens.push(match[2] !== undefined ? `${match[1] ?? ""}${match[2]}` : match[0]);
  }
  return tokens;
}

export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { filters: [], text: [], excluded: [], unknown: [] };
  for (const token of tokenize(query)) {
    const match = /^(-?)([A-Za-z]+):(.*)$/.exec(token);
    if (!match) {
      if (token.length > 1 && token.startsWith("-")) parsed.excluded.push(token.slice(1));
      else parsed.text.push(token);
      continue;
    }
    const name = (match[2] as string).toLowerCase();
    const key = (QUERY_KEYS as readonly string[]).includes(name)
      ? (name as QueryKey)
      : ALIASES[name];
    const value = match[3] as string;
    if (!key || !value) {
      parsed.unknown.push(token);
      continue;
    }
    parsed.filters.push({ key, value, negated: match[1] === "-" });
  }
  return parsed;
}

/** Quotes a value when it needs it. */
export function filterToken(key: QueryKey, value: string, negated = false): string {
  const quoted = /\s/.test(value) ? `"${value}"` : value;
  return `${negated ? "-" : ""}${key}:${quoted}`;
}

/** Adds, replaces or removes `key:value` in a query string. */
export function toggleFilter(query: string, key: QueryKey, value: string): string {
  const tokens = tokenize(query);
  const token = filterToken(key, value);
  const index = tokens.indexOf(token);
  if (index !== -1) tokens.splice(index, 1);
  else tokens.push(token);
  return tokens.map((t) => (/\s/.test(t) && !t.includes('"') ? `"${t}"` : t)).join(" ");
}

const DURATION = /^(\d+)(m|h|d|w)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** `7d` → seven days before `now`; a date or ISO time → itself. Null if neither. */
export function parseWhen(value: string, now = Date.now()): Date | null {
  const duration = DURATION.exec(value);
  if (duration) {
    const unit = duration[2] as keyof typeof UNIT_MS;
    return new Date(now - Number(duration[1]) * UNIT_MS[unit]);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The default console query: what's installable. */
export const DEFAULT_QUERY = "status:active";
