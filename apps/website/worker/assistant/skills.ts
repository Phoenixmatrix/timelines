// The assistant's skills, SKILL.md-style: a catalog line each in the system
// prompt, the body loaded when needed. clef preloads the ones a turn needs
// (plan.ts); the rest stay one activate_skill call away. A repository's own
// skills (.agents/skills/<name>/SKILL.md) join them when the chat is about it.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { CallApi } from "./internal.ts";
import type { Group } from "./plan.ts";
import type { UIMessage } from "ai";
import type {
  AssistantSkillInvocation,
  AssistantSkillSummary,
} from "../../shared/assistant-skills.ts";
import { personalSkills, SKILL_NAME } from "./personal-skills.ts";
import { WRITING_GUIDANCE } from "../release-notes/writing.ts";

interface Builtin {
  name: string;
  description: string;
  /** The tool group whose turns preload it. */
  group?: Group | "navigation";
  body: string;
}

export const BUILTIN: Builtin[] = [
  {
    name: "gitmatrix-api",
    description:
      "Every Timelines JSON API route, for api_get and api_write: repositories, collaborators, mirrors, knowledge, CI, secrets, packages and registries, tracker mutations, people.",
    body: `# Timelines JSON API

Paths are under /api; pass them to api_get (GET) or api_write (everything else) without the /api prefix. Responses are JSON; errors are {"error": "..."} with an HTTP status. You act as the person's assistant agent, with their permissions: a 403 means they can't do it either, so say so.

## Repositories (/repos)
- GET /repos — repositories you can see. POST /repos {spaceId, name, description, visibility: "public"|"private", importFrom?} — create or import into that immutable Space ID.
- GET /repos/:o/:n — detail: default branch, branches, tags, clone URL, your role.
- GET /repos/:o/:n/tree?ref=&path= — a folder. GET /repos/:o/:n/blob?ref=&path= — a file.
- GET /repos/:o/:n/commits?ref=&page= — commits. GET /repos/:o/:n/history?ref=&entries=a,b — last commit touching each path.
- GET /repos/:o/:n/semantic — meaning-level changes (functions/types added, changed, removed).
- PATCH /repos/:o/:n {description?, visibility?, defaultBranch?, name?} — settings (admin). DELETE /repos/:o/:n — delete (admin; confirm twice in words first).
- GET /repos/:o/:n/collaborators. PUT /repos/:o/:n/collaborators/:username {role: "read"|"write"|"admin"}. DELETE the same to remove.
- GET|PUT|DELETE /repos/:o/:n/mirror — GitHub mirror config (admin). POST /repos/:o/:n/mirror/sync — sync now.

## Knowledge (/repos/:o/:n/knowledge)
- GET /status — graph build state. POST /rebuild — rebuild (admin).
- GET /search?q=&kinds= — entities + code passages. GET /graph?kind=&q=&limit=, /graph/node?id= — nodes and their links.
- GET /wiki — table of contents. GET /wiki/page?slug= — a page.
- GET /repos/:o/:n/release-notes/range?from=&to= — release notes between two refs.
- GET /repos/:o/:n/release-notes — daily UTC committer-date code updates and optional tag snapshots. GET /repos/:o/:n/release-notes/release?name=day:YYYY-MM-DD (or a tag) — entries and introduction. Commits and tags are not deployment evidence.
- GET /tracker/:space/release-notes?q= — daily updates by default; kind:tag or release:<tag> selects tagged releases. Filters include kind, team, repo, project, type, tag, release, since and until. lastCommitAt is Git committer time, not tracker completion or deployment time.

These are JSON API endpoints, not browser pages. Link people to the Releases pages in the navigation skill: browser routes use /releases, never /release-notes.

## CI (/repos/:o/:n/ci)
- GET /ci — runs. POST /ci/runs {ref?, commit?} — start a run. GET /ci/runs/:number — jobs and steps.
- POST /ci/runs/:number/cancel, POST /ci/runs/:number/rerun.
- GET /ci/jobs/:job/logs?after=N — log chunks {chunks, next, done}.
- GET /ci/status?commits=a,b — status per commit.
- GET /ci/secrets — names only. PUT /ci/secrets/:NAME {value} and DELETE — never ask for or repeat secret values in chat; for a credential, tell the person to set it themselves (Settings or gm secret set).

## Packages (/packages)
- GET /packages/:space — packages and feeds. GET /packages/:space/:format/:name — one package; /publishes?q=&offset=&limit=; /contents.
- POST /packages/:space/:format/:name/actions {action: "tag"|"untag"|"deprecate"|"yank"|"delete", versions: [...], ...} — bulk version actions.
- POST|PATCH|DELETE /packages/:space/feeds[/:format/:key] — feeds and upstream proxies.

## Tracker (/tracker)
- GET /tracker — Spaces whose trackers you can use. GET /tracker/:space/snapshot — teams, projects, issues, links, comments, requests, members, agents, contractVersion, spaceId and migrationEpoch. GET /tracker/:space/view — a lighter view. GET /tracker/:space/tags — tag catalog with counts.
- POST /tracker/:space/mutate {contractVersion:4, spaceId, migrationEpoch, operationId: uuid, mutations: [...]}: use exact scope/epoch from a fresh snapshot. Kinds team.create|update, project.create|update, issue.create {id: uuid, data: {teamId, projectIds?, title, ...}} | issue.update {id, expectedVersion, data}, link.add {id, data: {fromId, toId, kind}} | link.remove, comment.add {id, data: {issueId, body, kind}}, subscription.add|remove, request.answer|cancel. Prefer dedicated issue tools; use this for Teams, Projects and bulk changes.
- GET /requests — open requests waiting on the person ("Needs you").
- GET /agent-work?since=14d[&agent=<name>][&tracker=<space>] — issues the person's agents finished lately, across trackers: {agents, trackers, items: [{tracker, issue, completion {actorId, accountableId, agent, at}, timeline, evidence}]}. Issue queries also take done-by:me|mine|<agent> and done:14d.
- Claims, leases and handoffs (issue.claim, renew, complete…) belong to agents doing the work with gm, not to this chat.

## People
- GET /session — who you act for. GET /users?q= — find people. GET /accounts/:slug — person profile. GET /organizations and /spaces — explicit directory/context; Organization membership grants no private content rights.`,
  },
  {
    name: "tracker",
    group: "tracker",
    description:
      "How the Timelines tracker works and how to plan with it: teams, statuses, priorities, PRDs and sub-issues, blockers, claims, requests to people.",
    body: `# The tracker

- Each tracker belongs to one Space, independent of repositories. Use explicit space inputs. Issues have exactly one Team (key like CORE), retain keys CORE-1, CORE-2, and may belong to multiple same-Space Projects. Project/repository associations grant no access.
- Status: backlog, todo, in_progress, done, canceled; and done_in_timeline, which the tracker sets: finished in a timeline that hasn't landed (doneIn names it). It still blocks, isn't ready and its status can't be changed (reopen it in the timeline instead); landing makes it done, abandoning the timeline makes it todo again. Priority 0 (urgent) to 4 (none); 2 is normal. Types: task, bug, prd, chore, research, remediation.
- Ready = todo, every blocker done, nobody holding a claim, no open sub-issues. find_issues with ready: true finds them.
- Links: "A blocks B" (B can't start until A is done), related, duplicates. Parent/sub-issue is structure, not blocking.
- A claim (lease) means an agent is working on it; only its holder changes its status. Don't change status on claimed issues.
- Completion evidence is the original evidence note, not a done status. show_issue returns completionEvidence separately, including original author, time and a citeable URL. When completing work, provide actual checks/results and links via gm issue complete --evidence TEXT or comment_on_issue(kind: "evidence"). Validation is optional: if nothing was verified, omit evidence rather than inventing a passing result. Historical notes remain visible after reopening.
- Queue failures create P0 remediation issues and read-only queueFailure evidence on the remediation and linked original issues: queueId, repo, commit, stage, kind, reason, runNumber, failedJobs, conflictPaths, classificationModel, repairModel and occurredAt. Never forge or edit these system fields. Monitor open remediation with type: remediation in find_issues; inspect issue detail and the actual CI run, not only the issue title.
- For independent default-branch work, gm push --queue --issue KEY explicitly submits asynchronously: save the queue ID in a checkpoint and distinguish accepted, landed, and deployed. Check gm queue show ID or gm queue wait ID --deploy at work boundaries rather than busy polling. Continue independent work only while honoring existing claims; keep/renew the original lease or complete it with honest evidence under its acceptance criteria.
- A failure does not grant ownership. Claim remediation through the normal online fenced gm issue claim/next protocol and require the returned lease token before changing status or repairing. Inspect conflict paths and run logs, push the fix, and complete only with actual recovery evidence. No ready result means stop or wait, not widen scope or steal a claim.
- Queued submission may use bounded AI for safe additive documentation conflicts; missing model evidence is not approval and required gates cannot be skipped. Ordinary gm push and native push remain recovery paths, not universally queue-protected; never silently fall back to them after failed admission. Timeline work uses checkpoint/land and its pinned approvals, not --queue.
- A PRD (type prd) is a plan, implemented through sub-issues. To break work down: create the sub-issues with parent set, then link blockers between them in execution order. Give each a crisp title and acceptance criteria.
- Requests are questions/approvals/decisions/credentials an agent asked a person; they show on the Needs you page (/needs-you).
- Write issue titles as outcomes ("Users can reset passwords"), not activities. Descriptions are Markdown.
- Link every issue you mention: [CORE-25](/tracker/<space>/issues/CORE-25).`,
  },
  {
    name: "code",
    group: "code",
    description:
      "Investigating code in a repository: finding where things are, reading the right lines, explaining and citing them.",
    body: `# Reading code

1. Find before reading: search_code (meaning search over the knowledge graph and code passages) beats listing folders. Use list_files for structure, read_file with lines for the part that matters.
2. Cite what you read with links to exact lines: [worker/app.ts:12-30](/<space>/<repo>/blob/<ref>/worker/app.ts#L12-L30).
3. Quote only the few lines that carry the point, in fenced code blocks with the language.
4. Say what you didn't check. Don't describe code you haven't read.
5. For "what changed", use list_commits and semantic_changes; for "who/when", file_history via api_get /repos/:o/:n/history?entries=path.`,
  },
  {
    name: "ci",
    group: "ci",
    description:
      "Diagnosing CI: finding the failing job and step, reading its logs, explaining the failure, rerunning.",
    body: `# CI

- ci_runs for recent runs; ci_run for a run's jobs and steps; ci_logs on the failing job (the end of the log is usually enough).
- Explain a failure as: what failed (job, step, exit code), why (quote the 3-10 decisive log lines), and the likely fix (link the code involved).
- Statuses: queued, running, succeeded, failed, cancelled, skipped. A job "skipped" as unchanged counts as passed.
- Rerun only when the failure looks transient (network, timeouts, infrastructure) or the person asks; otherwise explain first.
- Link runs: [run #44](/<space>/<repo>/ci/44).`,
  },
  {
    name: "packages",
    group: "packages",
    description:
      "Packages in the Timelines registry: formats, feeds, versions, tags, yanking and deprecating.",
    body: `# Packages

- Formats include npm, pypi, oci (containers), cargo, go, maven, nuget, rubygems, apt, rpm, brew, generic and releases. Each Space publishes into its own feeds.
- find_packages lists them; api_get /packages/:space/:format/:name for one package and its versions (publishes?q= to search versions).
- Version actions (tag, deprecate, yank, delete) go through api_write POST /packages/:space/:format/:name/actions. Yank and delete can break installs: say so before proposing them.
- Link packages: [name](/<space>/-/packages/<format>/<name>).`,
  },
  {
    name: "knowledge",
    group: "knowledge",
    description:
      "The knowledge graph and wiki: what a repository's parts are and mean, summaries, components, concepts.",
    body: `# Knowledge graph and wiki

- Every push rebuilds a graph of the repository: files, symbols, components and concepts, each summarized, with links (defines, imports, contains, uses).
- search_code searches it by meaning. read_wiki without a slug gives the table of contents; with one, the page. The wiki is generated from the graph and cites sources.
- search_code also returns completionEvidence from the repository's subscribed Projects, limited to trackers you may currently read. Search by issue key or distinctive verification words; cite each original note's URL, actorId and createdAt. Historical evidence is not current issue status. For evidence alone, api_get /repos/:o/:n/knowledge/completion-evidence?q=KEY reads the same source without a model or build.
- api_get /repos/:o/:n/knowledge/graph/node?id=... reads a node and its neighbours (ids look like file:path, sym:path#name, component:name).
- Prefer the wiki overview for "what is this repository / how does X work at a high level"; read code for exact behaviour.
- Link: [the wiki](/<space>/<repo>/wiki), [the map](/<space>/<repo>/knowledge?node=<id>).`,
  },
  {
    name: "release-notes-writer",
    group: "knowledge",
    description:
      "Writing custom, client-ready release notes (an announcement, changelog or customer email) from a repository's or Space's release notes.",
    body: `# Writing release notes

Fetch the notes first, with api_get, then write from them:
- One release of a repository: GET /repos/:o/:n/release-notes lists releases (daily updates are named @day:YYYY-MM-DD, tags by tag name); GET /repos/:o/:n/release-notes/release?name=<name> returns its entries (add &timeline=<slug> to keep one timeline's landed work).
- Many releases of a Space: GET /tracker/:space/release-notes?q=<filter> (for example since:7d, release:v1.2, repo:app, type:feature, team:CORE).
These return only what the person may read, so write from nothing else. If they return no entries, say so rather than inventing notes.

${WRITING_GUIDANCE}

Answer with the Markdown itself (a short lead-in is fine) so the person can copy it. The release-notes pages also have a "Write custom release notes" control that writes, previews and exports (Markdown, Word, PDF) the same thing without this chat; mention it when the person wants a file.`,
  },
  {
    name: "navigation",
    group: "navigation",
    description:
      "Timelines' pages and their paths: for links in answers and for opening pages with navigate.",
    body: `# Pages

- Home / ; Issue tracker /tracker and /tracker/<space> ; issue /tracker/<space>/issues/<KEY> ; Projects /tracker/<space>/projects ; Needs you /needs-you ; Agent work (what your agents finished lately; ?since=7d|14d|30d&agent=<name>&tracker=<space>&type=<type>) /agent-work ; Packages /packages
- Person /accounts/<person> ; Organization /organizations/<organization> ; Space /<space> ; packages /<space>/-/packages ; package /<space>/-/packages/<format>/<name>
- Repository /<space>/<repo> ; folder /<space>/<repo>/tree/<ref>/<path> ; file /<space>/<repo>/blob/<ref>/<path>#L10-L20 ; commits /<space>/<repo>/commits/<ref> ; changes /<space>/<repo>/changes ; CI /<space>/<repo>/ci and /<space>/<repo>/ci/<number> ; wiki /<space>/<repo>/wiki/<slug> ; knowledge map /<space>/<repo>/knowledge ; settings /<space>/<repo>/settings
- Repository release notes /<space>/<repo>/releases ; daily update or tag /<space>/<repo>/releases/<name> (URL-encode exact API name, including @day:)
- Tracker-wide release notes /tracker/<space>/releases ; preserve filters with ?q=<URL-encoded query>. Browser pages use /releases, not /release-notes.
- Person settings /settings/profile, /settings/tokens, /settings/ssh-keys, /settings/agents, /settings/invites. New repository /<space>/-/repositories/new. Instance administration is separate from Organization and Space administration.

Use navigate when the person asks to go somewhere or see something, or to show what you just made or found; it opens beside the chat. Otherwise just link.`,
  },
  {
    name: "repository",
    group: "repository",
    description:
      "Administering repositories: settings, visibility, collaborators and roles, GitHub mirrors, creating and importing.",
    body: `# Repository administration

- Roles: read, write, admin. Organization ownership grants no repository access. Explicit Space/resource grants determine rights. Settings, collaborators, mirrors and deletion need repository admin.
- Change settings with api_write PATCH /repos/:o/:n; collaborators with PUT/DELETE /repos/:o/:n/collaborators/:username; mirrors with /repos/:o/:n/mirror.
- Create: api_write POST /repos {spaceId, name, description, visibility}. Resolve the immutable Space ID explicitly; never use a person ID as a default. Import a public git URL with importFrom.
- Never delete a repository unless the person asked for exactly that in this conversation, and state that it can't be undone.`,
  },
  {
    name: "gm-cli",
    description:
      "How people and agents do things with gm, the Timelines CLI: clone, commit, push, CI, issues, packages, agents.",
    body: `# gm

gm is jj-style version control plus the Timelines client. Every edit lives in a change; operations can be undone (gm undo).
- gm clone space/repo · gm status · gm commit -m "…" · gm push (gm push --sync when trunk moved) · gm sync · gm log
- gm runs list / wait / logs --follow · gm secret set NAME
- gm issue create "Title" --team CORE [--space <space>] [--project <project>] · gm project · gm issue next · claim · checkpoint · complete [--evidence TEXT] · gm request list/answer. Provide actual completion evidence when available; gm issue show returns original attribution.
- gm pkg upload/download/install · gm agent setup (configure a coding agent for a checkout)
- gm ask "question" — ask this assistant from a terminal (read-only unless --write)
- gm cli guide (the workflow), gm cli search "<task>", gm schema <command>
Answer "how do I…" questions with the exact command.`,
  },
];

export interface Skill extends AssistantSkillSummary {
  body: string;
  repo?: string;
}

/** Where skills come from: built in, or a repository's .agents/skills. */
export interface SkillSource {
  list(): Promise<Skill[]>;
}

/** name and description from a SKILL.md's frontmatter, and the body after it. */
export function parseSkill(markdown: string): Pick<Skill, "name" | "description" | "body"> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) return null;
  const field = (key: string) => {
    const line = new RegExp(`^${key}:[\\t ]*([^\\r\\n]*)$`, "m").exec(match[1]!)?.[1]?.trim();
    return line?.replace(/^(["'])(.*)\1$/, "$2") ?? null;
  };
  const name = field("name");
  const description = field("description") ?? "";
  return name && SKILL_NAME.test(name) ? { name, description, body: match[2]!.trim() } : null;
}

/**
 * The skills a turn can use: a catalog line each in the instructions, bodies
 * preloaded when clef says the turn needs them, the rest one activate_skill
 * call away. The same model as Agent Skills (SKILL.md), without a script runner.
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private sources: SkillSource[];
  constructor(sources: SkillSource[]) {
    this.sources = sources;
  }

  async load() {
    const lists = await Promise.all(this.sources.map((s) => s.list().catch(() => [])));
    for (const skill of lists.flat())
      if (!this.skills.has(skill.name)) this.skills.set(skill.name, skill);
  }

  get(name: string): Skill | null {
    return this.skills.get(name) ?? null;
  }

  restore(receipt: AssistantSkillInvocation): Skill | null {
    for (const skill of this.skills.values())
      if (skill.id === receipt.id && skill.source === receipt.source) return skill;
    return null;
  }

  summaries(): AssistantSkillSummary[] {
    return [...this.skills.values()].map(({ id, name, description, source }) => ({
      id,
      name,
      description,
      source,
    }));
  }

  catalog(except: readonly string[] = []): string {
    const rest = [...this.skills.values()].filter((s) => !except.includes(s.name));
    if (!rest.length) return "";
    return `## Skills\n\nWhen a task matches one of these, call activate_skill with its name first:\n${rest
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n")}`;
  }

  tools(): ToolSet {
    if (!this.skills.size) return {};
    return {
      activate_skill: tool({
        description: "Load a skill's full instructions by name (see the Skills list).",
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          const skill = this.get(name);
          return skill
            ? { name: skill.name, instructions: skill.body }
            : { error: `No skill ${name}. Skills: ${[...this.skills.keys()].join(", ")}` };
        },
      }),
    };
  }
}

/** The built-in skills. */
export function builtinSkills(): SkillSource {
  return {
    list: async () =>
      BUILTIN.map(({ name, description, body }) => ({
        id: `builtin:${name}`,
        source: "builtin",
        name,
        description,
        body,
      })),
  };
}

/**
 * A tool-using turn needs both the API catalog and browser routes: answers
 * cite pages too, even when they don't call navigate. Also load its tool groups.
 */
export function preloaded(groups: readonly string[], navigate: boolean): string[] {
  if (!groups.length && !navigate) return [];
  return BUILTIN.filter(
    (skill) =>
      skill.name === "gitmatrix-api" ||
      skill.name === "navigation" ||
      (skill.group !== undefined && groups.includes(skill.group)),
  ).map((skill) => skill.name);
}

/**
 * A repository's own skills: .agents/skills/<name>/SKILL.md, read through the
 * API as the assistant (so a private repository's skills need access to it).
 */
export function repositorySkills(api: CallApi, repo: string): SkillSource {
  const [space, name] = repo.split("/");
  const base = `/repos/${encodeURIComponent(space!)}/${encodeURIComponent(name!)}`;
  return {
    async list() {
      const tree = await api("GET", `${base}/tree?path=.agents/skills`);
      if (!tree.ok) return [];
      const dirs = (tree.body as { entries: { path: string; type: string }[] }).entries
        .filter((e) => e.type === "tree")
        .slice(0, 20);
      const skills = await Promise.all(
        dirs.map(async (dir) => {
          const file = await api(
            "GET",
            `${base}/blob?path=${encodeURIComponent(`${dir.path}/SKILL.md`)}`,
          );
          const text = file.ok ? (file.body as { text: string | null }).text : null;
          const skill = text ? parseSkill(text) : null;
          return skill
            ? { ...skill, id: `repo:${repo}:${dir.path}`, source: "repository" as const, repo }
            : null;
        }),
      );
      return skills.filter((s) => s !== null);
    },
  };
}

/** One authorized catalog for both suggestions and model turns; first source wins. */
export async function buildSkillRegistry(
  d1: D1Database,
  userId: string,
  api: CallApi,
  repo: string | null,
) {
  const registry = new SkillRegistry([
    builtinSkills(),
    {
      list: async () =>
        (await personalSkills(d1, userId))
          .filter((skill) => skill.enabled)
          .map(({ id, name, description, body }) => ({
            id,
            name,
            description,
            body,
            source: "personal" as const,
          })),
    },
    ...(repo ? [repositorySkills(api, repo)] : []),
  ]);
  await registry.load();
  return registry;
}

/** Receipts contain identity and provenance, never executable instructions. */
export function skillReceipt(message: UIMessage | undefined): AssistantSkillInvocation | null {
  const part = message?.parts.find((part) => part.type === "data-skill");
  if (!part || !("data" in part) || !part.data || typeof part.data !== "object") return null;
  const data = part.data as Partial<AssistantSkillInvocation>;
  return typeof data.id === "string" &&
    typeof data.name === "string" &&
    typeof data.description === "string" &&
    (data.source === "builtin" || data.source === "personal" || data.source === "repository") &&
    (data.repo === undefined || typeof data.repo === "string")
    ? (data as AssistantSkillInvocation)
    : null;
}

/** A continuation can only restore its recorded identity, never a same-name replacement. */
export function resolveSkillInvocation(
  registry: SkillRegistry,
  message: string,
  continuation: boolean,
  receipt: AssistantSkillInvocation | null,
): Skill | null {
  if (continuation) {
    return receipt ? registry.restore(receipt) : null;
  }
  const command = /^\/([a-z0-9][a-z0-9-]{0,63})(?=\s|$)/.exec(message);
  return command ? registry.get(command[1]!) : null;
}
