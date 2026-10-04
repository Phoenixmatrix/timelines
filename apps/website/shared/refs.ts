// References in text (CORE-22): issue keys, Gitmatrix tracker issue URLs,
// commit hashes, `owner/repo` and `pkg@version`. The scanner finds candidates;
// only the server decides what they are (POST /api/refs/resolve), for the
// viewer, so nothing becomes a link that the viewer can't open, and nothing
// that might belong to someone else's tracker is guessed at.

import type { FormatId } from "./packages.ts";
import type { IssueStatus } from "./tracker.ts";

/** The bounds of one resolve request; longer lists are rejected with 400. */
export const REF_LIMITS = {
  /** Most refs in one request (the client splits bigger batches). */
  refs: 100,
  /** Longest ref, in characters. */
  length: 300,
  /** Most trackers an issue-key lookup reads. */
  trackers: 25,
  /** How much recent default-branch history a short hash is matched against. */
  history: 200,
} as const;

/** What a candidate looks like before the server says what it is. */
export type RefKind = "issue" | "issue-url" | "commit" | "repo" | "package";

/**
 * Where the text is being read, which disambiguates refs:
 * - `owner` and `repo`: the repository a page belongs to (commit hashes need it;
 *   its subscribed trackers come second for issue keys; `pkg@version` looks in
 *   `owner`'s packages);
 * - `tracker`: the tracker (owner slug) a page belongs to, first for issue keys.
 */
export interface RefContext {
  owner?: string;
  repo?: string;
  tracker?: string;
}

export interface ResolveRefsRequest {
  refs: string[];
  context?: RefContext;
}

interface TargetBase {
  /** The in-app path to open. A commit's opens the repository's commit panel. */
  path: string;
  /** What the target is, in words, for a tooltip and accessible name. */
  label: string;
}

export interface IssueTarget extends TargetBase {
  kind: "issue";
  /** The tracker (owner slug) the issue belongs to. */
  tracker: string;
  id: string;
  key: string;
  title: string;
  status: IssueStatus;
}

export interface CommitTarget extends TargetBase {
  kind: "commit";
  owner: string;
  repo: string;
  /** The full 40-character hash, also for a short one that was resolved. */
  sha: string;
}

export interface RepoTarget extends TargetBase {
  kind: "repo";
  owner: string;
  name: string;
}

export interface PackageTarget extends TargetBase {
  kind: "package";
  owner: string;
  format: FormatId;
  name: string;
  version: string;
}

export type RefTarget = IssueTarget | CommitTarget | RepoTarget | PackageTarget;

/**
 * One ref's answer:
 * - `resolved`: exactly one target the viewer can open;
 * - `ambiguous`: several equally good ones (an issue key in two trackers, a
 *   package name in two formats), best first, for a chooser;
 * - `unresolved`: nothing the viewer can open. `ours` marks a URL of this
 *   deployment's own tracker, which then reads as plain text rather than a
 *   dead link; anything else is left exactly as written.
 */
export type RefResolution =
  | { ref: string; status: "resolved"; target: RefTarget }
  | { ref: string; status: "ambiguous"; candidates: RefTarget[] }
  | { ref: string; status: "unresolved"; ours?: true };

/** One result per requested ref, in request order. */
export interface ResolveRefsResponse {
  results: RefResolution[];
}

/** A candidate ref in a text: `text.slice(start, end) === ref`. */
export interface RefSpan {
  start: number;
  end: number;
  ref: string;
  kind: RefKind;
}

/**
 * `TEAM-N`: a team key (an uppercase letter, then 1–5 uppercase letters or
 * digits) and a number without a leading zero. Things that merely look like
 * keys, such as `UTF-8`, survive scanning; resolving drops them.
 */
export const ISSUE_KEY =
  /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{1,5})-([1-9][0-9]{0,8})(?![A-Za-z0-9_])/g;
/** A tracker issue URL of any origin; the server decides whether the origin is ours. */
const ISSUE_URL =
  /\bhttps?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/tracker\/([a-z0-9][a-z0-9-]{0,38})\/issues\/([A-Za-z0-9_-]{1,100})(?![A-Za-z0-9_/-])/g;
const ISSUE_URL_EXACT = new RegExp(`^${ISSUE_URL.source}$`);
/** 7–40 hex digits standing alone. Short ones need a letter and a digit (below). */
const SHA = /(?<![A-Za-z0-9_./-])[0-9a-f]{7,40}(?![A-Za-z0-9_-])/g;
/** An account slug, a slash and a repository name, not part of a longer path. */
const REPO =
  /(?<![A-Za-z0-9_.@/:-])([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})\/((?!\.)[A-Za-z0-9._-]{1,100})(?![A-Za-z0-9_/@-])/g;
/** `name@version` (npm scopes included): the version starts with a digit. */
const PACKAGE =
  /(?<![A-Za-z0-9_.@/-])((?:@[a-z0-9][a-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,213})@(v?[0-9][A-Za-z0-9.+_-]{0,63})/g;

/** Any web address, so refs inside one are left alone. */
const ANY_URL = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/g;

/** Which kinds a text may contain: hashes only mean something inside a repository. */
export interface ScanOptions {
  commits?: boolean;
  /** Look for these kinds alone (CI logs link hashes and nothing else). */
  kinds?: readonly RefKind[];
}

const PRIORITY: Record<RefKind, number> = {
  "issue-url": 0,
  package: 1,
  repo: 2,
  issue: 3,
  commit: 4,
};

/** Sentence punctuation that ends a name rather than belonging to it. */
function trimEnd(text: string): string {
  return text.replace(/[._+-]+$/, "");
}

/** Every candidate ref in `text`, in order, never overlapping. */
export function scanRefs(text: string, options: ScanOptions = {}): RefSpan[] {
  if (!text) return [];
  const found: RefSpan[] = [];
  const add = (start: number, ref: string, kind: RefKind) => {
    if (ref) found.push({ start, end: start + ref.length, ref, kind });
  };
  const wants = (kind: RefKind) => !options.kinds || options.kinds.includes(kind);
  if (wants("issue-url")) for (const m of text.matchAll(ISSUE_URL)) add(m.index, m[0], "issue-url");
  if (wants("issue")) for (const m of text.matchAll(ISSUE_KEY)) add(m.index, m[0], "issue");
  if (wants("package"))
    for (const m of text.matchAll(PACKAGE)) {
      const version = trimEnd(m[2]!);
      if (/^v?[0-9]/.test(version)) add(m.index, `${m[1]}@${version}`, "package");
    }
  if (wants("repo"))
    for (const m of text.matchAll(REPO)) {
      const name = trimEnd(m[2]!);
      if (name && !/^\.+$/.test(name)) add(m.index, `${m[1]}/${name}`, "repo");
    }
  if (options.commits && wants("commit"))
    for (const m of text.matchAll(SHA)) {
      const sha = m[0];
      // A short hash needs a letter and a digit, so words ("defaced") and
      // numbers (dates, counts) aren't asked about. Full hashes always count.
      if (sha.length === 40 || (/[a-f]/.test(sha) && /[0-9]/.test(sha)))
        add(m.index, sha, "commit");
    }
  // Nothing inside another address is a ref: ENG-1 in someone else's tracker
  // URL is theirs. Only a whole tracker issue URL is a candidate.
  const urls = [...text.matchAll(ANY_URL)].map((m) => [m.index, m.index + m[0].length] as const);
  const inUrl = (span: RefSpan) =>
    span.kind !== "issue-url" && urls.some(([start, end]) => span.start < end && span.end > start);
  for (let i = found.length - 1; i >= 0; i--) if (inUrl(found[i]!)) found.splice(i, 1);
  found.sort((a, b) => a.start - b.start || PRIORITY[a.kind] - PRIORITY[b.kind]);
  const spans: RefSpan[] = [];
  for (const span of found) {
    const last = spans.at(-1);
    if (!last || span.start >= last.end) {
      spans.push(span);
      continue;
    }
    // Overlapping: the higher-priority kind wins.
    if (PRIORITY[span.kind] < PRIORITY[last.kind]) spans[spans.length - 1] = span;
  }
  return spans;
}

/** What kind of ref a whole string is, or null when it isn't one. */
export function refKind(ref: string): RefKind | null {
  const spans = scanRefs(ref, { commits: true });
  return spans.length === 1 && spans[0]!.start === 0 && spans[0]!.end === ref.length
    ? spans[0]!.kind
    : null;
}

/** Text split around its candidate refs. */
export type RefPiece = { text: string; span?: RefSpan };

export function splitRefs(text: string, options: ScanOptions = {}): RefPiece[] {
  const pieces: RefPiece[] = [];
  let at = 0;
  for (const span of scanRefs(text, options)) {
    if (span.start > at) pieces.push({ text: text.slice(at, span.start) });
    pieces.push({ text: span.ref, span });
    at = span.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

/** The path a tracker issue URL names, or null when it isn't one. */
export function issueUrlParts(
  ref: string,
): { origin: string; tracker: string; issue: string } | null {
  const match = ISSUE_URL_EXACT.exec(ref);
  if (!match) return null;
  return { origin: new URL(ref).origin, tracker: match[1]!, issue: match[2]! };
}

/** The in-app path a commit opens: the repository with its commit panel (`?commit=`). */
export function commitPath(owner: string, repo: string, sha: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?commit=${sha}`;
}

/**
 * The app page that answers for one ref (`/-/go/<ref>`): it opens the target,
 * or offers a chooser when the ref is ambiguous, or says nothing matched.
 */
export function goPath(ref: string, context: RefContext = {}): string {
  const params = new URLSearchParams(
    Object.entries(context).filter((entry): entry is [string, string] => !!entry[1]),
  ).toString();
  return `/-/go/${encodeURIComponent(ref)}${params ? `?${params}` : ""}`;
}
