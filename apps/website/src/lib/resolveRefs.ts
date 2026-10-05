// Turning what someone typed or wrote (an issue key, a SHA, `#12`,
// `pkg@1.2.0`, a timeline) into the place it names (CORE-22). The palette's
// direct jumps and the commit panel go through this module: issue keys,
// SHAs and `pkg@version` through the reference resolver
// (`POST /api/refs/resolve`, batched and cached by src/refs/resolver.ts), CI
// runs through this repository's CI API, timelines from the tracker's list.

import type { CiRunDetail, RepoDetail } from "../../shared/api.ts";
import {
  scanRefs,
  type RefContext,
  type RefResolution,
  type RefTarget,
} from "../../shared/refs.ts";
import { resolveRef } from "../refs/resolver.ts";
import { ApiError, api } from "./api.ts";
import { SHA_PATTERN, commitHref } from "./commitPanel.ts";
import { repoPath } from "./refs.ts";

export type RefKind = "issue" | "commit" | "run" | "package" | "timeline";

export type ParsedRef =
  | { kind: "issue"; key: string }
  | { kind: "commit"; sha: string }
  | { kind: "run"; number: number }
  | { kind: "package"; name: string; version: string }
  | { kind: "timeline"; slug: string };

const ISSUE_KEY = /^([a-z][a-z0-9]{0,9})-(\d{1,9})$/i;
const RUN = /^(?:#|run\s*#?)(\d{1,9})$/i;
const PACKAGE = /^(@?[^@\s]+)@([^@\s]+)$/;
const TIMELINE = /^(?:timeline\/|tl:)([a-z0-9][a-z0-9-]{0,62})$/i;

/** What kind of reference `text` is, or null for anything else (words to search). */
export function parseRef(text: string): ParsedRef | null {
  const raw = text.trim();
  if (!raw || /\s/.test(raw.replace(/^run\s+/i, "run"))) return null;
  const run = RUN.exec(raw);
  if (run) return { kind: "run", number: Number(run[1]) };
  const timeline = TIMELINE.exec(raw);
  if (timeline) return { kind: "timeline", slug: timeline[1]!.toLowerCase() };
  // Hex before keys: `deadbeef` is a SHA, and no key is all hex without a dash.
  if (SHA_PATTERN.test(raw)) return { kind: "commit", sha: raw.toLowerCase() };
  const key = ISSUE_KEY.exec(raw);
  if (key) return { kind: "issue", key: `${key[1]!.toUpperCase()}-${key[2]}` };
  const pkg = PACKAGE.exec(raw);
  if (pkg && !pkg[1]!.endsWith("/")) return { kind: "package", name: pkg[1]!, version: pkg[2]! };
  return null;
}

/** Issue keys a commit message cites, in order, each once (the autolinker's scanner). */
export function issueKeysIn(message: string): string[] {
  return [...new Set(scanRefs(message, { kinds: ["issue"] }).map((span) => span.ref))];
}

/** A place a reference resolved to. */
export interface Jump {
  /** Stable for the same place: `jump:<kind>:<canonical>`. */
  id: string;
  kind: RefKind;
  title: string;
  detail: string;
  /** An in-app address. */
  to: string;
  /** Router state to navigate with (a commit opened over the page goes Back to it). */
  state?: unknown;
}

/** Where the reference is being resolved from. */
export interface JumpContext {
  /** The page it was typed on, so a commit opens over it in its repository. */
  here: { pathname: string; search: string; state: unknown };
  /** The repository being viewed: SHAs and run numbers are its own. */
  repo: Pick<RepoDetail, "owner" | "name"> | null;
  /** The tracker in view (or the repository owner's), whose matches come first. */
  tracker: string | null;
  /** The account the page belongs to, whose packages `pkg@version` names. */
  owner: string | null;
  /** Repositories visited recently: where a SHA typed outside a repository may be. */
  recentRepos: { owner: string; name: string }[];
  /** Timelines the viewer can see in the tracker in view, when loaded. */
  timelines: { slug: string; name: string; owner: string }[];
}

const short = (sha: string) => sha.slice(0, 7);

/** A resolution's targets, best first: one when resolved, several when ambiguous. */
function targetsOf(resolution: RefResolution | null | undefined): RefTarget[] {
  if (resolution?.status === "resolved") return [resolution.target];
  if (resolution?.status === "ambiguous") return resolution.candidates;
  return [];
}

/** Rejects once `signal` aborts, so a stale answer is never used. */
function resolveFor(
  ref: string,
  context: RefContext,
  signal: AbortSignal,
): Promise<RefResolution | null> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("The request was aborted.", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    void resolveRef(ref, context).then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    });
  });
}

function commitJump(context: JumpContext, target: RefTarget): Jump[] {
  if (target.kind !== "commit") return [];
  return [
    {
      id: `jump:commit:${target.owner}/${target.repo}@${target.sha}`,
      kind: "commit",
      title: `Commit ${short(target.sha)}`,
      detail: `in ${target.owner}/${target.repo}`,
      ...commitHref(context.here, target.owner, target.repo, target.sha),
    },
  ];
}

/** The place `ref` names, from here; empty when it names nothing the viewer can open. */
export async function resolveJump(
  ref: ParsedRef,
  context: JumpContext,
  signal: AbortSignal,
): Promise<Jump[]> {
  const repo = context.repo ? { owner: context.repo.owner.slug, repo: context.repo.name } : null;
  switch (ref.kind) {
    case "issue": {
      const resolution = await resolveFor(
        ref.key,
        { ...repo, ...(context.tracker ? { tracker: context.tracker } : {}) },
        signal,
      );
      return targetsOf(resolution).flatMap((target) =>
        target.kind === "issue"
          ? [
              {
                id: `jump:issue:${target.tracker}:${target.id}`,
                kind: "issue" as const,
                title: target.key,
                detail: `${target.title} · ${target.tracker}`,
                to: target.path,
              },
            ]
          : [],
      );
    }
    case "commit": {
      // A hash means something only in a repository: this one, else the
      // ones visited recently, each asked whether it has the commit.
      const repos = repo
        ? [repo]
        : context.recentRepos.slice(0, 3).map((r) => ({ owner: r.owner, repo: r.name }));
      const answers = await Promise.all(repos.map((r) => resolveFor(ref.sha, r, signal)));
      return answers.flatMap((answer) => targetsOf(answer).flatMap((t) => commitJump(context, t)));
    }
    case "run": {
      if (!repo) return [];
      try {
        const run = await api<CiRunDetail>(
          `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/ci/runs/${ref.number}`,
          { signal },
        );
        return [
          {
            id: `jump:run:${repo.owner}/${repo.repo}#${run.number}`,
            kind: "run",
            title: `#${run.number} ${run.title}`,
            detail: `CI run in ${repo.owner}/${repo.repo}`,
            to: repoPath(repo.owner, repo.repo, "ci", String(run.number)),
          },
        ];
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return [];
        throw error;
      }
    }
    case "package": {
      // Packages are an owner's: the page's, else those of repositories visited recently.
      const owners = [
        ...new Set(
          context.owner ? [context.owner] : context.recentRepos.slice(0, 3).map((r) => r.owner),
        ),
      ];
      const raw = `${ref.name}@${ref.version}`;
      const answers = await Promise.all(owners.map((owner) => resolveFor(raw, { owner }, signal)));
      return answers.flatMap((answer) =>
        targetsOf(answer).flatMap((target) =>
          target.kind === "package"
            ? [
                {
                  id: `jump:package:${target.owner}/${target.format}/${target.name}@${target.version}`,
                  kind: "package" as const,
                  title: `${target.name}@${target.version}`,
                  detail: `${target.format} · ${target.owner}`,
                  to: target.path,
                },
              ]
            : [],
        ),
      );
    }
    case "timeline":
      return context.timelines
        .filter((timeline) => timeline.slug === ref.slug)
        .map((timeline) => timelineJump(timeline));
  }
}

export function timelineJump(timeline: { slug: string; name: string; owner: string }): Jump {
  return {
    id: `jump:timeline:${timeline.owner}/${timeline.slug}`,
    kind: "timeline",
    title: timeline.name,
    detail: `timeline/${timeline.slug} · ${timeline.owner}`,
    to: `/tracker/${encodeURIComponent(timeline.owner)}/timelines?tl=${encodeURIComponent(timeline.slug)}`,
  };
}

/** An issue a key resolved to. */
export interface ConfirmedIssue {
  key: string;
  title: string;
  to: string;
}

/**
 * Which of `keys` are Gitmatrix issues the viewer can open from `owner/repo`,
 * and where. Keys that aren't (or are ambiguous) come back absent, so callers
 * show them as plain text, never a guessed link.
 */
export async function confirmIssueKeys(
  keys: string[],
  repo: { owner: string; name: string },
  signal: AbortSignal,
): Promise<Map<string, ConfirmedIssue>> {
  const context: RefContext = { owner: repo.owner, repo: repo.name, tracker: repo.owner };
  const answers = await Promise.all(keys.map((key) => resolveFor(key, context, signal)));
  const found = new Map<string, ConfirmedIssue>();
  keys.forEach((key, i) => {
    const answer = answers[i];
    if (answer?.status === "resolved" && answer.target.kind === "issue")
      found.set(key, { key, title: answer.target.title, to: answer.target.path });
  });
  return found;
}

/**
 * The full id of `sha` in `owner/name`, or null when the repository has no
 * such commit (a short hash must match exactly one recent commit).
 */
export async function resolveCommit(
  owner: string,
  name: string,
  sha: string,
  signal: AbortSignal,
): Promise<string | null> {
  const wanted = sha.toLowerCase();
  if (/^[0-9a-f]{40}$/.test(wanted)) return wanted;
  if (!SHA_PATTERN.test(wanted)) return null;
  const answer = await resolveFor(wanted, { owner, repo: name }, signal);
  const target = targetsOf(answer).find((t) => t.kind === "commit");
  return target?.kind === "commit" ? target.sha : null;
}
