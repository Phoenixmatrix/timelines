// Release notes (CORE-29): turn each release's commits and the tracker
// issues they cite into stored entries, plus a short introduction per
// release. Entries whose inputs are unchanged are reused, wherever in the
// repository they were written, so a push only pays for what is new and a
// tag push freezes unreleased entries without another model call.

import type {
  LinkedIssue,
  ReleaseCategory,
  ReleaseNoteChange,
} from "../../shared/release-notes.ts";
import { UNRELEASED } from "../../shared/release-notes.ts";
import type { RepoRefs } from "../artifacts.ts";
import { chatJson, chatText } from "../knowledge/models.ts";
import { batch, db } from "../schema.ts";
import { issueKeys } from "./keys.ts";
import { walkRange } from "./range.ts";

/** Bump when prompts change, so entries are rewritten. */
const PROMPT_VERSION = 1;
/** Tags with notes kept current; older releases keep what they have. */
export const MAX_TAGS = 10;
/** Model calls per run; the rest continue in a follow-up run. */
export const MAX_MODEL_CALLS = 40;
const CATEGORIES: ReleaseCategory[] = ["feature", "fix", "improvement", "internal"];

export interface GeneratorSource {
  refs(): Promise<RepoRefs>;
  log(oid: string, limit: number, offset: number): Promise<ArtifactsCommitMetadata[]>;
  /** Issues cited by key, from the trackers subscribed to the repository. */
  issues(keys: string[]): Promise<LinkedIssue[]>;
  /** Syntax-level code changes a commit made. */
  changes(oid: string): Promise<ReleaseNoteChange[]>;
}

export interface GenerateResult {
  releases: number;
  modelCalls: number;
  /** The model budget ran out; run again to finish. */
  more: boolean;
}

interface Draft {
  release: string;
  subject: string;
  kind: "issue" | "commit";
  issue: LinkedIssue | null;
  commits: ArtifactsCommitMetadata[];
  inputsHash: string;
}

interface Written {
  category: ReleaseCategory;
  title: string;
  summary: string;
  changes: ReleaseNoteChange[];
  model: string | null;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const firstLine = (message: string) => message.split("\n", 1)[0]!.trim();

function issueInputs(issue: LinkedIssue) {
  return {
    key: issue.key,
    title: issue.title,
    description: issue.description.slice(0, 4000),
    type: issue.type,
    status: issue.status,
    labels: issue.labels,
    evidence: issue.evidence.slice(-3).map((e) => e.body.slice(0, 2000)),
  };
}

export const ENTRY_SYSTEM = `You write one entry of a software project's release notes.
You get a tracker issue (when there is one), the commits that shipped it and
the code changes they made. Reply with JSON only:
{"category": "feature" | "fix" | "improvement" | "internal",
 "title": "<at most 80 characters, plain words a user of the project would recognize>",
 "summary": "<1-2 sentences on what changed for users and why it matters>"}
Use "fix" for corrected defects, "feature" for new capabilities, "improvement"
for better existing behavior, "internal" for chores, refactors, tests, docs and
tooling with no user-visible effect. Describe the change itself; never mention
commit hashes, issue keys, agents or the people involved. Do not invent details
the inputs do not support.`;

export const INTRO_SYSTEM = `You write the short introduction to a release of a
software project, from its release-note entries. Two to four sentences of plain
prose: the main themes and the most important changes, most significant first.
No headings, lists, issue keys or commit hashes. Do not invent details.`;

function entryPrompt(draft: Draft, changes: ReleaseNoteChange[]): string {
  const parts: string[] = [];
  if (draft.issue) {
    const i = issueInputs(draft.issue);
    parts.push(
      `## Issue ${i.key} (${i.type}, ${i.status})\n${i.title}\n\n${i.description || "(no description)"}`,
    );
    if (i.labels.length) parts.push(`Labels: ${i.labels.join(", ")}`);
    for (const evidence of i.evidence) parts.push(`### Completion evidence\n${evidence}`);
  }
  parts.push(
    "## Commits\n" +
      draft.commits
        .slice(0, 20)
        .map((c) => `- ${c.message.slice(0, 2000).trim()}`)
        .join("\n"),
  );
  if (changes.length)
    parts.push(
      "## Code changes\n" +
        changes.map((c) => `- ${c.kind} ${c.name} in ${c.path}: ${c.summary}`).join("\n"),
    );
  return parts.join("\n\n");
}

async function write(env: Env, source: GeneratorSource, draft: Draft): Promise<Written> {
  const changes: ReleaseNoteChange[] = [];
  for (const commit of draft.commits.slice(0, 10)) {
    if (changes.length >= 30) break;
    changes.push(...(await source.changes(commit.hash)).slice(0, 30 - changes.length));
  }
  const { value, usage } = await chatJson<{ category?: string; title?: string; summary?: string }>(
    env,
    "fast",
    ENTRY_SYSTEM,
    entryPrompt(draft, changes),
    { maxTokens: 500 },
  );
  const fallback = draft.issue?.title ?? firstLine(draft.commits[0]!.message);
  return {
    category: CATEGORIES.includes(value.category as ReleaseCategory)
      ? (value.category as ReleaseCategory)
      : "improvement",
    title: (value.title?.trim() || fallback).slice(0, 120),
    summary: (value.summary?.trim() ?? "").slice(0, 600),
    changes,
    model: usage.model,
  };
}

/** Each release's range: the newest tags, then the default branch's unreleased work. */
async function ranges(source: GeneratorSource, refs: RepoRefs) {
  const tagged = new Map<string, string>();
  // Tags sort newest first; a commit with several tags is released once, as the newest.
  for (const tag of refs.tags) if (!tagged.has(tag.oid)) tagged.set(tag.oid, tag.shortName);
  const isTagged = (oid: string) => tagged.has(oid);
  const result: {
    release: string;
    toOid: string;
    commits: ArtifactsCommitMetadata[];
    base: string | null;
    truncated: boolean;
  }[] = [];
  if (refs.head) {
    const walk = await walkRange(source, refs.head, isTagged);
    result.push({ release: UNRELEASED, toOid: refs.head, ...walk });
  }
  for (const [oid, tag] of [...tagged].slice(0, MAX_TAGS)) {
    const walk = await walkRange(source, oid, isTagged, { includeStart: true });
    result.push({ release: tag, toOid: oid, ...walk });
  }
  return { result, tagged };
}

export async function generateReleaseNotes(
  env: Env,
  repoId: string,
  source: GeneratorSource,
  { maxModelCalls = MAX_MODEL_CALLS, now = () => new Date().toISOString() } = {},
): Promise<GenerateResult> {
  const d = db(env.DB);
  const refs = await source.refs();
  const { result: releases, tagged } = await ranges(source, refs);

  // Every key any release cites, resolved once.
  const keys = [
    ...new Set(releases.flatMap((r) => r.commits.flatMap((c) => issueKeys(c.message)))),
  ];
  const issues = await source.issues(keys);
  const byKey = new Map<string, LinkedIssue[]>();
  for (const issue of issues) byKey.set(issue.key, [...(byKey.get(issue.key) ?? []), issue]);

  await batch(env.DB, [
    d.deleteFrom("release_note_mentions").where("repo_id", "=", repoId),
    ...keys.map((key) =>
      d.insertInto("release_note_mentions").values({ repo_id: repoId, issue_key: key }),
    ),
  ]);

  // Drafts: an issue gathers the release's commits citing it; other commits stand alone.
  const drafts: Draft[] = [];
  for (const release of releases) {
    const bySubject = new Map<string, Omit<Draft, "inputsHash">>();
    for (const commit of release.commits) {
      const cited = issueKeys(commit.message).flatMap((key) => byKey.get(key) ?? []);
      if (!cited.length) {
        bySubject.set(`commit:${commit.hash}`, {
          release: release.release,
          subject: `commit:${commit.hash}`,
          kind: "commit",
          issue: null,
          commits: [commit],
        });
        continue;
      }
      for (const issue of cited) {
        const subject = `issue:${issue.trackerOwnerId}:${issue.key}`;
        const draft = bySubject.get(subject) ?? {
          release: release.release,
          subject,
          kind: "issue" as const,
          issue,
          commits: [],
        };
        draft.commits.push(commit);
        bySubject.set(subject, draft);
      }
    }
    for (const draft of bySubject.values())
      drafts.push({
        ...draft,
        inputsHash: await sha256({
          v: PROMPT_VERSION,
          kind: draft.kind,
          issue: draft.issue && issueInputs(draft.issue),
          commits: draft.commits.map((c) => [c.hash, c.message.slice(0, 2000)]),
        }),
      });
  }

  // Reuse anything already written from the same inputs.
  const reusable = new Map<string, Written>();
  const hashes = [...new Set(drafts.map((draft) => draft.inputsHash))];
  for (let start = 0; start < hashes.length; start += 90) {
    const rows = await d
      .selectFrom("release_note_entries")
      .select(["inputs_hash", "category", "title", "summary", "changes", "model"])
      .where("repo_id", "=", repoId)
      .where("inputs_hash", "in", hashes.slice(start, start + 90))
      .execute();
    for (const row of rows)
      reusable.set(row.inputs_hash, {
        category: row.category,
        title: row.title,
        summary: row.summary,
        changes: JSON.parse(row.changes) as ReleaseNoteChange[],
        model: row.model,
      });
  }

  let modelCalls = 0;
  let more = false;
  const stamp = now();
  for (const release of releases) {
    const head = release.commits[0];
    const releasedAt = head ? iso(head.authoredAt) : stamp;
    await d
      .insertInto("release_notes")
      .values({
        repo_id: repoId,
        release: release.release,
        to_oid: release.toOid,
        from_tag: release.base ? (tagged.get(release.base) ?? null) : null,
        from_oid: release.base,
        truncated: release.truncated ? 1 : 0,
        released_at: releasedAt,
        updated_at: stamp,
      })
      .onConflict((oc) =>
        oc.columns(["repo_id", "release"]).doUpdateSet({
          to_oid: release.toOid,
          from_tag: release.base ? (tagged.get(release.base) ?? null) : null,
          from_oid: release.base,
          truncated: release.truncated ? 1 : 0,
          released_at: releasedAt,
          updated_at: stamp,
        }),
      )
      .execute();

    const mine = drafts.filter((draft) => draft.release === release.release);
    const complete: string[] = [];
    const pending: string[] = [];
    for (const draft of mine) {
      let written = reusable.get(draft.inputsHash);
      if (!written) {
        if (modelCalls >= maxModelCalls) {
          more = true;
          pending.push(draft.subject);
          continue;
        }
        modelCalls++;
        written = await write(env, source, draft);
        reusable.set(draft.inputsHash, written);
      }
      const issue = draft.issue;
      const newest = draft.commits[0]!;
      const values = {
        kind: draft.kind,
        category: written.category,
        title: written.title,
        summary: written.summary,
        tracker_owner_id: issue?.trackerOwnerId ?? null,
        issue_id: issue?.id ?? null,
        issue_key: issue?.key ?? null,
        team_id: issue?.team.id ?? null,
        team_key: issue?.team.key ?? null,
        issue_type: issue?.type ?? null,
        labels: JSON.stringify(issue?.labels ?? []),
        workspace_ids: JSON.stringify(issue?.workspaceIds ?? []),
        commits: JSON.stringify(draft.commits.map((c) => c.hash)),
        changes: JSON.stringify(written.changes),
        shipped_at: issue?.completedAt ?? iso(newest.authoredAt),
        model: written.model,
        inputs_hash: draft.inputsHash,
        updated_at: stamp,
      };
      await d
        .insertInto("release_note_entries")
        .values({
          id: crypto.randomUUID(),
          repo_id: repoId,
          release: release.release,
          subject: draft.subject,
          ...values,
        })
        .onConflict((oc) => oc.columns(["repo_id", "release", "subject"]).doUpdateSet(values))
        .execute();
      complete.push(draft.subject);
    }
    // Drop entries no longer in the release; unfinished ones keep their last version.
    const keep = [...complete, ...pending];
    let stale = d
      .deleteFrom("release_note_entries")
      .where("repo_id", "=", repoId)
      .where("release", "=", release.release);
    if (keep.length) stale = stale.where("subject", "not in", keep);
    await stale.execute();

    if (pending.length) continue;
    const shown = await d
      .selectFrom("release_note_entries")
      .select(["title", "summary", "category", "tracker_owner_id"])
      .where("repo_id", "=", repoId)
      .where("release", "=", release.release)
      .where("category", "!=", "internal")
      .orderBy("subject")
      .execute();
    const introHash = await sha256({
      v: PROMPT_VERSION,
      entries: shown.map((e) => [e.category, e.title, e.summary]),
    });
    const current = await d
      .selectFrom("release_notes")
      .select("intro_inputs_hash")
      .where("repo_id", "=", repoId)
      .where("release", "=", release.release)
      .executeTakeFirstOrThrow();
    if (current.intro_inputs_hash === introHash) continue;
    let intro = "";
    let introModel: string | null = null;
    if (shown.length) {
      if (modelCalls >= maxModelCalls) {
        more = true;
        continue;
      }
      modelCalls++;
      const prompt = shown.map((e) => `- [${e.category}] ${e.title}: ${e.summary}`).join("\n");
      const { text, usage } = await chatText(env, "reason", INTRO_SYSTEM, prompt, {
        maxTokens: 600,
      });
      intro = text.trim().slice(0, 2000);
      introModel = usage.model;
    }
    await d
      .updateTable("release_notes")
      .set({
        intro,
        intro_model: introModel,
        intro_inputs_hash: introHash,
        intro_trackers: JSON.stringify(
          [
            ...new Set(shown.flatMap((e) => (e.tracker_owner_id ? [e.tracker_owner_id] : []))),
          ].sort(),
        ),
      })
      .where("repo_id", "=", repoId)
      .where("release", "=", release.release)
      .execute();
  }

  // Tags that no longer exist lose their notes; older tags beyond the window keep theirs.
  const live = new Set([UNRELEASED, ...refs.tags.map((tag) => tag.shortName)]);
  const existing = await d
    .selectFrom("release_notes")
    .select("release")
    .where("repo_id", "=", repoId)
    .execute();
  for (const row of existing)
    if (!live.has(row.release))
      await batch(env.DB, [
        d
          .deleteFrom("release_note_entries")
          .where("repo_id", "=", repoId)
          .where("release", "=", row.release),
        d
          .deleteFrom("release_notes")
          .where("repo_id", "=", repoId)
          .where("release", "=", row.release),
      ]);

  return { releases: releases.length, modelCalls, more };
}
