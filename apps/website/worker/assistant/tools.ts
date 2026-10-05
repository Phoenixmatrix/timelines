// The assistant's tools. Reads go straight through; every write is its own
// tool so the web can ask for approval with a readable card (describeWrite),
// and anything not covered by a dedicated tool is reachable through the
// generic api_get / api_write pair. All of them call the real API as the
// person's assistant agent (internal.ts), so permissions are the API's own.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { issuePickup, type Issue, type Snapshot } from "../../shared/tracker.ts";
import {
  hasRequirements,
  parseRequirements,
  RequirementError,
  requirementsText,
  type IssueRequirements,
} from "../../shared/requirements.ts";
import { issueTagsInput } from "../../shared/assistant.ts";
import type { CallApi } from "./internal.ts";
import type { Group } from "./plan.ts";

const REPO = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .describe("owner/name, e.g. matrixorg/gitmatrix");
const OWNER = z
  .string()
  .regex(/^[\w-]+$/)
  .describe("Account or organization slug that owns the tracker");
const KEY = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/)
  .describe("Issue key, e.g. CORE-25");

const enc = encodeURIComponent;
const repoApi = (repo: string) => {
  const [owner, name] = repo.split("/");
  return `/repos/${enc(owner!)}/${enc(name!)}`;
};

/** Long text cut to fit a tool result, saying so. */
export function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/** JSON trimmed for a model: long strings cut, long arrays shortened, with counts. */
export function compact(value: unknown, budget = { strings: 600, items: 40 }, depth = 0): unknown {
  if (typeof value === "string") return clip(value, budget.strings);
  if (Array.isArray(value)) {
    const items = value.slice(0, budget.items).map((v) => compact(v, budget, depth + 1));
    return value.length > budget.items
      ? [...items, `… ${value.length - budget.items} more`]
      : items;
  }
  if (value && typeof value === "object") {
    if (depth > 6) return "…";
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, compact(v, budget, depth + 1)]),
    );
  }
  return value;
}

const failed = (result: { status: number; body: unknown }) => ({
  error: (result.body as { error?: string } | null)?.error ?? `The API answered ${result.status}.`,
});

/** Lines `a-b` (1-based, inclusive) of a text, numbered. */
function numbered(text: string, lines?: string): { text: string; total: number } {
  const all = text.replace(/\n$/, "").split("\n");
  let [from, to] = [1, Math.min(all.length, 400)];
  const range = lines?.match(/^(\d+)(?:-(\d+))?$/);
  if (range) {
    from = Math.max(1, Number(range[1]));
    to = Math.min(all.length, Number(range[2] ?? range[1]));
  }
  const width = String(to).length;
  return {
    text: all
      .slice(from - 1, to)
      .map((line, i) => `${String(from + i).padStart(width)}  ${line}`)
      .join("\n"),
    total: all.length,
  };
}

/** Requirements in their text form: the stored object, null for none, or what's wrong. */
function requirementsInput(text: string | undefined): IssueRequirements | null | string {
  if (text === undefined) return null;
  try {
    return parseRequirements(text);
  } catch (error) {
    if (error instanceof RequirementError) return error.message;
    throw error;
  }
}

/** A tracker snapshot, loaded once per turn and reused by every tracker tool. */
function snapshots(api: CallApi) {
  const cache = new Map<string, Promise<Snapshot | { error: string }>>();
  return (owner: string) => {
    let pending = cache.get(owner);
    if (!pending) {
      pending = api("GET", `/tracker/${enc(owner)}/snapshot`).then((r) =>
        r.ok ? (r.body as Snapshot) : failed(r),
      );
      cache.set(owner, pending);
    }
    return pending;
  };
}

function issueRow(issue: Issue, snapshot: Snapshot) {
  const team = snapshot.teams.find((t) => t.id === issue.teamId);
  return {
    key: issue.key,
    title: issue.title,
    status: issue.status,
    pickup: issuePickup(issue),
    ...(issue.doneIn ? { doneInTimeline: issue.doneIn.slug } : {}),
    type: issue.type,
    priority: `P${issue.priority}`,
    team: team?.key,
    tags: issue.labels,
    ...(hasRequirements(issue.requires) ? { requires: requirementsText(issue.requires) } : {}),
    ...(issue.claim ? { claimedBy: issue.claim.agent } : {}),
    ...(issue.assigneeId ? { assignee: issue.assigneeId } : {}),
    updatedAt: issue.updatedAt,
  };
}

export interface ToolContext {
  api: CallApi;
  /** Writes are allowed at all (the CLI is read-only without --write). */
  writes: boolean;
  /** Each write waits for the person (the web); false runs them directly. */
  approve: boolean;
  /** Offer `navigate` (the web, where the browser carries it out). */
  navigate: boolean;
}

/** Every tool, by group. `codemode` wraps the read-only ones (agent.ts). */
export function buildTools(context: ToolContext) {
  const { api } = context;
  const snapshot = snapshots(api);
  const needsApproval = context.approve;

  const code = {
    list_repos: tool({
      description:
        'List repositories you can see. Returns {repos: [{repo: "owner/name", description, defaultBranch, visibility, url}]}.',
      inputSchema: z.object({}),
      execute: async () => {
        const r = await api("GET", "/repos");
        if (!r.ok) return failed(r);
        const repos = (
          r.body as {
            repos: {
              owner: { slug: string };
              name: string;
              description: string;
              defaultBranch: string;
              visibility: string;
            }[];
          }
        ).repos;
        return {
          repos: repos.map((repo) => ({
            repo: `${repo.owner.slug}/${repo.name}`,
            description: repo.description,
            defaultBranch: repo.defaultBranch,
            visibility: repo.visibility,
            url: `/${repo.owner.slug}/${repo.name}`,
          })),
        };
      },
    }),
    list_files: tool({
      description:
        'List a folder of a repository (the root by default), with its README if it has one. Returns {ref, entries: ["dir path" | "file path"], readme?, url}.',
      inputSchema: z.object({
        repo: REPO,
        path: z.string().optional().describe("Folder path; empty for the root"),
        ref: z.string().optional().describe("Branch, tag or commit; the default branch otherwise"),
      }),
      execute: async ({ repo, path = "", ref }) => {
        const query = new URLSearchParams({ ref: ref ?? "", path });
        const r = await api("GET", `${repoApi(repo)}/tree?${query.toString()}`);
        if (!r.ok) return failed(r);
        const body = r.body as {
          ref: string;
          entries: { name: string; path: string; type: string }[];
          readme: { name: string; text: string } | null;
        };
        return {
          ref: body.ref,
          entries: body.entries.map((e) => `${e.type === "tree" ? "dir " : "file"} ${e.path}`),
          ...(body.readme ? { readme: clip(body.readme.text, 3000) } : {}),
          url: `/${repo}/tree/${body.ref}/${path}`.replace(/\/$/, ""),
        };
      },
    }),
    read_file: tool({
      description:
        "Read a file from a repository, with line numbers. Use lines (e.g. 120-180) for part of a long file; otherwise the first 400 lines. Returns {ref, commit, totalLines, content, url}.",
      inputSchema: z.object({
        repo: REPO,
        path: z.string().min(1),
        ref: z.string().optional(),
        lines: z
          .string()
          .regex(/^\d+(-\d+)?$/)
          .optional(),
      }),
      execute: async ({ repo, path, ref, lines }) => {
        const query = new URLSearchParams({ ref: ref ?? "", path });
        const r = await api("GET", `${repoApi(repo)}/blob?${query.toString()}`);
        if (!r.ok) return failed(r);
        const blob = r.body as {
          ref: string;
          commitOid: string;
          text: string | null;
          binary: boolean;
          size: number;
        };
        if (blob.binary || blob.text === null) return { binary: true, size: blob.size };
        const { text, total } = numbered(blob.text, lines);
        return {
          ref: blob.ref,
          commit: blob.commitOid.slice(0, 12),
          totalLines: total,
          content: clip(text, 24_000),
          url: `/${repo}/blob/${blob.ref}/${path}${lines ? `#L${lines.replace("-", "-L")}` : ""}`,
        };
      },
    }),
    list_commits: tool({
      description:
        "Recent commits on a branch (newest first), 30 per page. Returns {ref, hasMore, commits: [{commit, title, author, at}], url}.",
      inputSchema: z.object({
        repo: REPO,
        ref: z.string().optional(),
        page: z.number().int().min(1).optional(),
      }),
      execute: async ({ repo, ref, page }) => {
        const query = new URLSearchParams({
          ...(ref ? { ref } : {}),
          ...(page ? { page: String(page) } : {}),
        });
        const r = await api("GET", `${repoApi(repo)}/commits?${query.toString()}`);
        if (!r.ok) return failed(r);
        const body = r.body as {
          ref: string;
          hasMore: boolean;
          commits: { oid: string; message: string; authorName: string; authoredAt: number }[];
        };
        return {
          ref: body.ref,
          hasMore: body.hasMore,
          commits: body.commits.map((c) => ({
            commit: c.oid.slice(0, 12),
            title: c.message.split("\n")[0],
            author: c.authorName,
            at: new Date(c.authoredAt * 1000).toISOString(),
          })),
          url: `/${repo}/commits/${body.ref}`,
        };
      },
    }),
    semantic_changes: tool({
      description:
        "What recently changed in a repository at the level of code meaning (functions, types, exports added, changed or removed), newest first.",
      inputSchema: z.object({ repo: REPO }),
      execute: async ({ repo }) => {
        const r = await api("GET", `${repoApi(repo)}/semantic`);
        return r.ok
          ? { ...(compact(r.body, { strings: 300, items: 30 }) as object), url: `/${repo}/changes` }
          : failed(r);
      },
    }),
  } satisfies ToolSet;

  const knowledge = {
    search_code: tool({
      description:
        "Search a repository by meaning: matching files, symbols and components from the knowledge graph, plus the most relevant code passages. Start here to find where something is implemented.",
      inputSchema: z.object({ repo: REPO, query: z.string().min(2) }),
      execute: async ({ repo, query }) => {
        const r = await api("GET", `${repoApi(repo)}/knowledge/search?q=${enc(query)}`);
        return r.ok ? compact(r.body, { strings: 1200, items: 12 }) : failed(r);
      },
    }),
    read_wiki: tool({
      description:
        "Read a repository's generated wiki: without a slug, its table of contents; with one, that page.",
      inputSchema: z.object({ repo: REPO, slug: z.string().optional() }),
      execute: async ({ repo, slug }) => {
        const r = await api(
          "GET",
          `${repoApi(repo)}/knowledge/wiki${slug ? `/page?slug=${enc(slug)}` : ""}`,
        );
        return r.ok
          ? {
              ...(compact(r.body, { strings: 16_000, items: 80 }) as object),
              url: `/${repo}/wiki${slug ? `/${slug}` : ""}`,
            }
          : failed(r);
      },
    }),
  } satisfies ToolSet;

  const tracker = {
    find_issues: tool({
      description:
        'Find issues in a tracker (owner = the account or organization, e.g. "priya" for "priya\'s tracker"). Filters combine; with none, open issues by priority. Returns {total, issues: [{key, title, status, type, priority: "P2", team, tags, requires? (what an agent must report to claim it), blocked, claimedBy?, assignee?, updatedAt}], teams: [key], url}, at most `limit` issues (default 25). Use this for any question about issues or teams.',
      inputSchema: z.object({
        owner: OWNER,
        query: z.string().optional().describe("Words to match in titles, descriptions and keys"),
        status: z
          .enum([
            "open",
            "backlog",
            "todo",
            "in_progress",
            "done",
            "done_in_timeline",
            "canceled",
            "any",
          ])
          .optional(),
        team: z.string().optional().describe("Team key, e.g. CORE"),
        type: z.enum(["task", "bug", "prd", "chore", "research", "remediation"]).optional(),
        tag: z.string().optional().describe("Only issues with this tag, e.g. ux"),
        label: z.string().optional().describe("Old name of tag"),
        ready: z
          .boolean()
          .optional()
          .describe("Only issues ready to start: todo, unblocked, unclaimed"),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({
        owner,
        query,
        status = "open",
        team,
        type,
        tag: tagged,
        label,
        ready,
        limit = 25,
      }) => {
        const tag = (tagged ?? label)?.toLowerCase();
        const snap = await snapshot(owner);
        if ("error" in snap) return snap;
        const teamId = team
          ? snap.teams.find((t) => t.key.toLowerCase() === team.toLowerCase())?.id
          : undefined;
        if (team && !teamId)
          return { error: `No team ${team}. Teams: ${snap.teams.map((t) => t.key).join(", ")}` };
        const blocked = new Set(
          snap.links
            .filter((l) => l.kind === "blocks")
            .filter((l) => {
              const from = snap.issues.find((i) => i.id === l.fromId);
              return from && from.status !== "done" && from.status !== "canceled";
            })
            .map((l) => l.toId),
        );
        const words = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
        const matches = snap.issues
          .filter((i) =>
            status === "any"
              ? true
              : status === "open"
                ? i.status !== "done" && i.status !== "canceled"
                : i.status === status,
          )
          .filter((i) => !teamId || i.teamId === teamId)
          .filter((i) => !type || i.type === type)
          .filter((i) => !tag || i.labels.some((l) => l.toLowerCase() === tag))
          .filter(
            (i) =>
              !ready ||
              (issuePickup(i) === "anyone" &&
                i.status === "todo" &&
                !blocked.has(i.id) &&
                !i.claim),
          )
          .filter((i) => {
            const text = `${i.key} ${i.title} ${i.description}`.toLowerCase();
            return words.every((w) => text.includes(w));
          })
          .sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt));
        return {
          total: matches.length,
          issues: matches
            .slice(0, limit)
            .map((i) => ({ ...issueRow(i, snap), blocked: blocked.has(i.id) })),
          teams: snap.teams.map((t) => t.key),
          url: `/tracker/${owner}`,
        };
      },
    }),
    show_issue: tool({
      description:
        "Everything about one issue. Returns {key, title, status, priority, team, description, acceptance, queueFailure: read-only system failure evidence or null, parent, children: [string], blockedBy: [string], blocks: [key], related: [string], comments: [{kind, by, at, body}], url}.",
      inputSchema: z.object({ owner: OWNER, key: KEY }),
      execute: async ({ owner, key }) => {
        const snap = await snapshot(owner);
        if ("error" in snap) return snap;
        const issue = snap.issues.find((i) => i.key.toLowerCase() === key.toLowerCase());
        if (!issue) return { error: `No issue ${key} in ${owner}'s tracker.` };
        const byId = new Map(snap.issues.map((i) => [i.id, i]));
        const keyOf = (id: string) => byId.get(id)?.key ?? id;
        return {
          ...issueRow(issue, snap),
          description: clip(issue.description, 8000),
          acceptance: clip(issue.acceptance, 3000),
          queueFailure: issue.queueFailure ?? null,
          parent: issue.parentId ? keyOf(issue.parentId) : null,
          children: snap.issues
            .filter((i) => i.parentId === issue.id)
            .map((i) => `${i.key} ${i.status} ${i.title}`),
          blockedBy: snap.links
            .filter((l) => l.kind === "blocks" && l.toId === issue.id)
            .map((l) => `${keyOf(l.fromId)} ${byId.get(l.fromId)?.status}`),
          blocks: snap.links
            .filter((l) => l.kind === "blocks" && l.fromId === issue.id)
            .map((l) => keyOf(l.toId)),
          related: snap.links
            .filter((l) => l.kind !== "blocks" && (l.fromId === issue.id || l.toId === issue.id))
            .map((l) => `${l.kind} ${keyOf(l.fromId === issue.id ? l.toId : l.fromId)}`),
          comments: snap.comments
            .filter((c) => c.issueId === issue.id)
            .slice(-20)
            .map((c) => ({
              kind: c.kind,
              by: c.actorId,
              at: c.createdAt,
              body: clip(c.body, 2000),
            })),
          url: `/tracker/${owner}/issues/${issue.key}`,
        };
      },
    }),
  } satisfies ToolSet;

  const ci = {
    ci_runs: tool({
      description:
        "Recent CI runs of a repository, newest first. Returns {runs: [{number, status, title, commit, ref, createdAt, finishedAt, url}]}.",
      inputSchema: z.object({ repo: REPO }),
      execute: async ({ repo }) => {
        const r = await api("GET", `${repoApi(repo)}/ci`);
        if (!r.ok) return failed(r);
        const runs = (
          r.body as {
            runs: {
              number: number;
              status: string;
              title: string;
              commit: string;
              ref: string;
              createdAt: string;
              finishedAt: string | null;
            }[];
          }
        ).runs;
        return {
          runs: runs.slice(0, 30).map((run) => ({
            ...run,
            commit: run.commit.slice(0, 12),
            url: `/${repo}/ci/${run.number}`,
          })),
        };
      },
    }),
    ci_run: tool({
      description:
        "One CI run: its jobs (with ids for ci_logs), steps, exit codes and errors. Returns {number, status, title, commit, jobs: [{id, name, status, exitCode, error, steps}], url}.",
      inputSchema: z.object({ repo: REPO, number: z.number().int().min(1) }),
      execute: async ({ repo, number }) => {
        const r = await api("GET", `${repoApi(repo)}/ci/runs/${number}`);
        return r.ok
          ? {
              ...(compact(r.body, { strings: 800, items: 40 }) as object),
              url: `/${repo}/ci/${number}`,
            }
          : failed(r);
      },
    }),
    ci_logs: tool({
      description:
        "A CI job's log output (the end of it, where failures usually are). Get job ids from ci_run.",
      inputSchema: z.object({
        repo: REPO,
        job: z.string().min(1),
        tail: z.number().int().min(20).max(2000).optional(),
      }),
      execute: async ({ repo, job, tail = 300 }) => {
        let after = 0;
        let text = "";
        for (let page = 0; page < 20; page++) {
          const r = await api("GET", `${repoApi(repo)}/ci/jobs/${enc(job)}/logs?after=${after}`);
          if (!r.ok) return failed(r);
          const body = r.body as {
            chunks: { text: string }[];
            next: number;
            done: boolean;
            removedAt?: string | null;
          };
          if (body.removedAt) return { removedByRetentionAt: body.removedAt, output: "" };
          text += body.chunks.map((c) => c.text).join("");
          if (!body.chunks.length || body.next === after) break;
          after = body.next;
        }
        const lines = text.split("\n");
        return { lines: lines.length, output: clip(lines.slice(-tail).join("\n"), 30_000) };
      },
    }),
  } satisfies ToolSet;

  const packages = {
    find_packages: tool({
      description: "Packages an account or organization publishes, optionally filtered by name.",
      inputSchema: z.object({ owner: OWNER, query: z.string().optional() }),
      execute: async ({ owner, query }) => {
        const r = await api("GET", `/packages/${enc(owner)}`);
        if (!r.ok) return failed(r);
        const body = compact(r.body, { strings: 300, items: 200 }) as {
          packages?: { name: string }[];
        };
        if (query && Array.isArray(body.packages))
          body.packages = body.packages.filter((p) =>
            JSON.stringify(p).toLowerCase().includes(query.toLowerCase()),
          );
        return { ...body, url: `/${owner}/-/packages` };
      },
    }),
  } satisfies ToolSet;

  const general = {
    api_get: tool({
      description:
        "Last resort for reads the other tools don't cover: GET a Gitmatrix JSON API path exactly as listed in the gitmatrix-api skill (e.g. /repos/o/n/collaborators). Never guess paths; issues, CI, code and packages have their own tools.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path under /api, with any query string"),
      }),
      execute: async ({ path }) => {
        const r = await api("GET", path);
        return r.ok ? compact(r.body) : failed(r);
      },
    }),
  } satisfies ToolSet;

  const writes = {
    create_issue: tool({
      description: "Create an issue. The person approves it first on the web.",
      inputSchema: z.object({
        owner: OWNER,
        team: z.string().describe("Team key, e.g. CORE"),
        title: z.string().min(1).max(300),
        description: z.string().optional().describe("Markdown"),
        acceptance: z.string().optional().describe("Markdown acceptance criteria"),
        type: z.enum(["task", "bug", "prd", "chore", "research", "remediation"]).optional(),
        pickup: z.enum(["anyone", "not_ready", "human_only"]).optional(),
        priority: z.number().int().min(0).max(4).optional().describe("0 is most urgent"),
        parent: KEY.optional(),
        tags: z
          .array(z.string())
          .optional()
          .describe("Work-area tags from the tracker's tag catalog, e.g. ux, frontend"),
        labels: z.array(z.string()).optional().describe("Old name of tags"),
        requires: z
          .string()
          .max(1000)
          .optional()
          .describe(
            'What an agent must report to claim it (people always can), e.g. "tag:ux model:claude-opus-* memory>=16GiB": tag:/skill: (all of), model:/harness:/os:/arch:/runtime: (any of, * wildcards), memory>=, cpus>=. Empty for any agent.',
          ),
      }),
      needsApproval,
      execute: async ({
        owner,
        team,
        title,
        description,
        acceptance,
        type,
        priority,
        parent,
        tags: tagList,
        labels,
        requires,
        pickup,
      }) => {
        const tags = issueTagsInput({ tags: tagList, labels });
        const required = requirementsInput(requires);
        if (typeof required === "string") return { error: required };
        const snap = await snapshot(owner);
        if ("error" in snap) return snap;
        const teamId = snap.teams.find((t) => t.key.toLowerCase() === team.toLowerCase())?.id;
        if (!teamId)
          return { error: `No team ${team}. Teams: ${snap.teams.map((t) => t.key).join(", ")}` };
        const parentId = parent
          ? snap.issues.find((i) => i.key.toLowerCase() === parent.toLowerCase())?.id
          : undefined;
        if (parent && !parentId) return { error: `No issue ${parent}.` };
        const id = crypto.randomUUID();
        const r = await api("POST", `/tracker/${enc(owner)}/mutate`, {
          operationId: crypto.randomUUID(),
          mutations: [
            {
              kind: "issue.create",
              id,
              data: {
                teamId,
                title,
                description: description ?? "",
                acceptance: acceptance ?? "",
                ...(type ? { type } : {}),
                ...(priority === undefined ? {} : { priority }),
                ...(parentId ? { parentId } : {}),
                ...(tags ? { labels: tags } : {}),
                ...(required ? { requires: required } : {}),
                ...(pickup ? { pickup } : {}),
              },
            },
          ],
        });
        if (!r.ok) return failed(r);
        const created = (
          r.body as { events: { entity: { id: string; key?: string } }[] }
        ).events.find((e) => e.entity.id === id)?.entity;
        return {
          created: created?.key ?? id,
          url: created?.key ? `/tracker/${owner}/issues/${created.key}` : `/tracker/${owner}`,
        };
      },
    }),
    update_issue: tool({
      description:
        "Change an issue's fields. Status changes on issues someone holds a lease on are refused by the tracker.",
      inputSchema: z.object({
        owner: OWNER,
        key: KEY,
        changes: z
          .object({
            title: z.string().optional(),
            description: z.string().optional(),
            acceptance: z.string().optional(),
            status: z.enum(["backlog", "todo", "in_progress", "done", "canceled"]).optional(),
            priority: z.number().int().min(0).max(4).optional(),
            pickup: z.enum(["anyone", "not_ready", "human_only"]).optional(),
            type: z.enum(["task", "bug", "prd", "chore", "research", "remediation"]).optional(),
            tags: z
              .array(z.string())
              .optional()
              .describe("Replaces the issue's tags (from the tracker's tag catalog)"),
            labels: z.array(z.string()).optional().describe("Old name of tags"),
            requires: z
              .string()
              .max(1000)
              .optional()
              .describe(
                'What an agent must report to claim it (people always can), e.g. "tag:ux model:claude-opus-* memory>=16GiB": tag:/skill: (all of), model:/harness:/os:/arch:/runtime: (any of, * wildcards), memory>=, cpus>=. An empty string removes them.',
              ),
          })
          .refine((c) => Object.keys(c).length > 0, "Change at least one field."),
      }),
      needsApproval,
      execute: async ({ owner, key, changes }) => {
        const snap = await snapshot(owner);
        if ("error" in snap) return snap;
        const issue = snap.issues.find((i) => i.key.toLowerCase() === key.toLowerCase());
        if (!issue) return { error: `No issue ${key}.` };
        const { requires, tags: tagList, labels, ...rest } = changes;
        const required = requirementsInput(requires);
        if (typeof required === "string") return { error: required };
        const tags = issueTagsInput({ tags: tagList, labels });
        const fields = tags ? { ...rest, labels: tags } : rest;
        const data = requires === undefined ? fields : { ...fields, requires: required ?? null };
        const r = await api("POST", `/tracker/${enc(owner)}/mutate`, {
          operationId: crypto.randomUUID(),
          mutations: [{ kind: "issue.update", id: issue.id, expectedVersion: issue.version, data }],
        });
        return r.ok
          ? { updated: issue.key, url: `/tracker/${owner}/issues/${issue.key}` }
          : failed(r);
      },
    }),
    comment_on_issue: tool({
      description: "Add a comment (or a checkpoint or evidence note) to an issue.",
      inputSchema: z.object({
        owner: OWNER,
        key: KEY,
        body: z.string().min(1).describe("Markdown"),
        kind: z.enum(["comment", "checkpoint", "evidence"]).optional(),
      }),
      needsApproval,
      execute: async ({ owner, key, body, kind = "comment" }) => {
        const snap = await snapshot(owner);
        if ("error" in snap) return snap;
        const issue = snap.issues.find((i) => i.key.toLowerCase() === key.toLowerCase());
        if (!issue) return { error: `No issue ${key}.` };
        const r = await api("POST", `/tracker/${enc(owner)}/mutate`, {
          operationId: crypto.randomUUID(),
          mutations: [
            {
              kind: "comment.add",
              id: crypto.randomUUID(),
              data: { issueId: issue.id, body, kind },
            },
          ],
        });
        return r.ok
          ? { commented: issue.key, url: `/tracker/${owner}/issues/${issue.key}` }
          : failed(r);
      },
    }),
    link_issues: tool({
      description: "Relate two issues: `from` blocks `to`, is related to it, or duplicates it.",
      inputSchema: z.object({
        owner: OWNER,
        from: KEY,
        to: KEY,
        kind: z.enum(["blocks", "related", "duplicates"]),
      }),
      needsApproval,
      execute: async ({ owner, from, to, kind }) => {
        const snap = await snapshot(owner);
        if ("error" in snap) return snap;
        const find = (k: string) =>
          snap.issues.find((i) => i.key.toLowerCase() === k.toLowerCase());
        const [a, b] = [find(from), find(to)];
        if (!a || !b) return { error: `No issue ${a ? to : from}.` };
        const r = await api("POST", `/tracker/${enc(owner)}/mutate`, {
          operationId: crypto.randomUUID(),
          mutations: [
            { kind: "link.add", id: crypto.randomUUID(), data: { fromId: a.id, toId: b.id, kind } },
          ],
        });
        return r.ok
          ? { linked: `${a.key} ${kind} ${b.key}`, url: `/tracker/${owner}/issues/${a.key}` }
          : failed(r);
      },
    }),
    rerun_ci: tool({
      description: "Rerun a CI run (same commit and configuration).",
      inputSchema: z.object({ repo: REPO, number: z.number().int().min(1) }),
      needsApproval,
      execute: async ({ repo, number }) => {
        const r = await api("POST", `${repoApi(repo)}/ci/runs/${number}/rerun`);
        if (!r.ok) return failed(r);
        const run = r.body as { number: number };
        return { rerun: run.number, url: `/${repo}/ci/${run.number}` };
      },
    }),
    cancel_ci: tool({
      description: "Cancel a queued or running CI run.",
      inputSchema: z.object({ repo: REPO, number: z.number().int().min(1) }),
      needsApproval,
      execute: async ({ repo, number }) => {
        const r = await api("POST", `${repoApi(repo)}/ci/runs/${number}/cancel`);
        return r.ok ? { cancelled: number, url: `/${repo}/ci/${number}` } : failed(r);
      },
    }),
    api_write: tool({
      description:
        "Any other change through the Gitmatrix JSON API (see the gitmatrix-api skill): POST, PUT, PATCH or DELETE. Give a one-line summary of the effect; the person sees the exact request before it runs.",
      inputSchema: z.object({
        summary: z.string().min(3).max(200),
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        path: z.string().min(1),
        body: z.unknown().optional(),
      }),
      needsApproval,
      execute: async ({ method, path, body }) => {
        const r = await api(method, path, body);
        return r.ok ? { ok: true, response: compact(r.body) } : failed(r);
      },
    }),
  } satisfies ToolSet;

  const navigate = {
    navigate: tool({
      description:
        "Open a page of Gitmatrix in the person's browser, beside this chat. Use when they ask to see or go somewhere, or when showing beats describing (a file at the lines you mean, the issue you created). Paths are app paths like /matrixorg/gitmatrix/blob/main/README.md#L10-L20 or /tracker/matrixorg/issues/CORE-25.",
      inputSchema: z.object({
        path: z
          .string()
          .regex(/^\/[^\s]*$/)
          .describe("App path starting with /"),
        label: z.string().max(80).describe("What it is, e.g. 'CORE-25' or 'run #44'"),
      }),
      // No execute: the browser navigates and reports back.
    }),
  } satisfies ToolSet;

  const groups: Record<Group, ToolSet> = {
    code,
    knowledge,
    tracker,
    ci,
    packages,
    repository: {},
  };
  return {
    groups,
    general,
    /** Read tools, for Code Mode. */
    reads: { ...code, ...knowledge, ...tracker, ...ci, ...packages, ...general } as ToolSet,
    writes: context.writes ? (writes as ToolSet) : {},
    navigate: context.navigate ? (navigate as ToolSet) : {},
  };
}
