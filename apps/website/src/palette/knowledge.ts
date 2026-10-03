// The palette's code and wiki search (CORE-97): one repository at a time, and
// only when the person submits. Typing, choosing a repository or closing never
// reaches a model; each submission supersedes the last.

import type { KnowledgeSearchResults } from "../../shared/api.ts";
import { ApiError, api } from "../lib/api.ts";
import { knowledgeSearchNotes } from "../lib/knowledgeSearch.ts";
import { blobUrl, repoPath } from "../lib/refs.ts";

/** A repository the palette is scoped to. */
export interface ScopedRepo {
  owner: string;
  name: string;
  defaultBranch: string;
}

/** Choosing a repository first, or searching one's code and wiki. */
export type PaletteScope = { kind: "pick" } | ({ kind: "repo" } & ScopedRepo);

export type KnowledgeState =
  | { status: "idle" }
  | { status: "loading"; repo: string; query: string }
  | { status: "done"; repo: string; query: string; results: KnowledgeSearchResults }
  | { status: "failed"; repo: string; query: string; message: string };

export const repoKey = (repo: ScopedRepo) => `${repo.owner}/${repo.name}`;

/** Why a search failed, in words: AI off here, no access, or anything else. */
function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) return "Code and wiki search is off on this server (no AI).";
    if (error.status === 404 || error.status === 403) return "You can't search this repository.";
    return error.message;
  }
  return "Couldn't reach the server.";
}

/** Explicit, cancellable searches whose answers only land while still current. */
export function knowledgeSearch(onState: (state: KnowledgeState) => void) {
  let inflight: AbortController | undefined;
  let latest = "";
  return {
    submit(repo: ScopedRepo, query: string) {
      const q = query.trim();
      inflight?.abort();
      if (!q) {
        latest = "";
        onState({ status: "idle" });
        return;
      }
      const key = `${repoKey(repo)}\n${q}`;
      latest = key;
      const controller = new AbortController();
      inflight = controller;
      onState({ status: "loading", repo: repoKey(repo), query: q });
      const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
      api<KnowledgeSearchResults>(`${path}/knowledge/search?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      }).then(
        (results) => {
          if (controller.signal.aborted || latest !== key) return;
          onState({ status: "done", repo: repoKey(repo), query: q, results });
        },
        (error: unknown) => {
          if (controller.signal.aborted || latest !== key) return;
          onState({ status: "failed", repo: repoKey(repo), query: q, message: failure(error) });
        },
      );
    },
    /** Forget any answer: the scope or the query changed. */
    reset() {
      inflight?.abort();
      latest = "";
      onState({ status: "idle" });
    },
  };
}

const PER_GROUP = 6;

export interface KnowledgeOption {
  id: string;
  title: string;
  detail: string;
  to: string;
}

export interface KnowledgeGroup {
  key: "entities" | "code" | "wiki";
  label: string;
  options: KnowledgeOption[];
}

/** Labelled groups with their destinations, and what the results can't show. */
export function knowledgeResults(
  repo: ScopedRepo,
  results: KnowledgeSearchResults,
): { groups: KnowledgeGroup[]; notes: string[] } {
  const where = repoKey(repo);
  const entities = results.entities.map((entity): KnowledgeOption => ({
    id: `entity:${where}:${entity.id}`,
    title: entity.name,
    detail: [entity.kind, entity.path].filter(Boolean).join(" · "),
    to: `${repoPath(repo.owner, repo.name, "knowledge")}?node=${encodeURIComponent(entity.id)}`,
  }));
  const passages = (kind: "code" | "wiki") =>
    results.passages
      .filter((passage) => passage.kind === kind)
      .map((passage, index): KnowledgeOption => ({
        id: `${kind}:${where}:${passage.path}:${index}`,
        title: passage.path,
        detail: passage.text.replace(/\s+/g, " ").slice(0, 120),
        to:
          kind === "wiki"
            ? repoPath(repo.owner, repo.name, "wiki", passage.path)
            : blobUrl(repo.owner, repo.name, repo.defaultBranch, passage.path),
      }));
  // A few of each, so Code and Wiki aren't pushed below a long list of
  // entities; the repository's Knowledge page shows everything.
  const groups: KnowledgeGroup[] = [
    { key: "entities" as const, label: "Entities", options: entities.slice(0, PER_GROUP) },
    { key: "code" as const, label: "Code", options: passages("code").slice(0, PER_GROUP) },
    { key: "wiki" as const, label: "Wiki", options: passages("wiki").slice(0, PER_GROUP) },
  ].filter((group) => group.options.length);
  return { groups, notes: knowledgeSearchNotes(results) };
}
