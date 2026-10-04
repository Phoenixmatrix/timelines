// The assistant's contract between the worker, the web panel and `gm ask`.

/** Where the person is in the app; sent with every message. */
export interface PageContext {
  path: string;
  title?: string;
  /** owner/name when on a repository page. */
  repo?: string;
  /** Tracker owner and issue key when on an issue. */
  tracker?: string;
  issue?: string;
  /** A file and its selected lines when reading code. */
  file?: string;
  ref?: string;
  lines?: string;
  /** CI run number when on a run. */
  run?: number;
}

export interface AssistantChat {
  id: string;
  title: string;
  source: "web" | "cli";
  createdAt: string;
  updatedAt: string;
  /**
   * When retention deletes it unless it's used again (CORE-204): null while
   * the account's "assistant-chats" policy is off. A chat over the policy's
   * per-person cap expires at the next cleanup (now).
   */
  expiresAt: string | null;
}

/** POST /api/assistant/ask: one turn from the CLI. */
export interface AskRequest {
  question: string;
  /** Continue this chat; a new one otherwise. */
  chatId?: string;
  /** owner/name the question is about. */
  repo?: string;
  /** Allow writes (no interactive approval from a terminal). */
  write?: boolean;
}

/** Newline-delimited JSON events streamed back to `gm ask`. */
export type AskEvent =
  | { type: "chat"; chatId: string; url: string }
  | { type: "status"; text: string }
  /** How clef routed the turn: what it is, the model, the tool groups, Code Mode. */
  | {
      type: "plan";
      intent: string;
      model: string;
      groups: string[];
      codemode: boolean;
      routedMs: number | null;
    }
  | { type: "tool"; name: string; label: string }
  | { type: "text"; delta: string }
  | { type: "done"; answer: string }
  | { type: "error"; message: string };

/** Tools that change something: the web asks before each one runs. */
export const WRITE_TOOLS = [
  "create_issue",
  "update_issue",
  "comment_on_issue",
  "link_issues",
  "rerun_ci",
  "cancel_ci",
  "api_write",
] as const;
export type WriteTool = (typeof WRITE_TOOLS)[number];

export interface WriteDescription {
  /** "Create an issue in CORE" */
  title: string;
  /** What exactly will be sent, as label/value rows. */
  fields: [string, string][];
  /** Longer text (a description or comment body) shown as Markdown. */
  body?: string;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
/** Any value as display text. */
const shown = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);

/**
 * What a write will do, in words, from the call itself rather than from the
 * model's own summary of it, so an approval card can't be talked into saying
 * something the request doesn't do.
 */
export function describeWrite(tool: string, input: Record<string, unknown>): WriteDescription {
  const owner = str(input.owner);
  switch (tool) {
    case "create_issue": {
      const fields: [string, string][] = [["Title", str(input.title)]];
      if (input.priority !== undefined) fields.push(["Priority", `P${shown(input.priority)}`]);
      if (input.type) fields.push(["Type", str(input.type)]);
      if (input.parent) fields.push(["Parent", str(input.parent)]);
      if (Array.isArray(input.labels) && input.labels.length)
        fields.push(["Labels", input.labels.join(", ")]);
      return {
        title: `Create an issue in ${str(input.team) || "a team"}${owner ? ` (${owner})` : ""}`,
        fields,
        body: str(input.description) || undefined,
      };
    }
    case "update_issue": {
      const changes = (input.changes ?? {}) as Record<string, unknown>;
      const fields = Object.entries(changes)
        .filter(([key]) => key !== "description")
        .map(([key, value]): [string, string] => [
          key[0]!.toUpperCase() + key.slice(1),
          value === null
            ? "(cleared)"
            : Array.isArray(value)
              ? value.map(shown).join(", ")
              : shown(value),
        ]);
      return {
        title: `Update ${str(input.key)}`,
        fields,
        body: typeof changes.description === "string" ? changes.description : undefined,
      };
    }
    case "comment_on_issue":
      return {
        title: `Comment on ${str(input.key)}`,
        fields: input.kind && input.kind !== "comment" ? [["Kind", str(input.kind)]] : [],
        body: str(input.body),
      };
    case "link_issues":
      return {
        title: `Link ${str(input.from)} → ${str(input.to)}`,
        fields: [
          ["Relation", `${str(input.from)} ${str(input.kind) || "blocks"} ${str(input.to)}`],
        ],
      };
    case "rerun_ci":
      return {
        title: `Rerun CI run #${String(input.number)}`,
        fields: [["Repository", str(input.repo)]],
      };
    case "cancel_ci":
      return {
        title: `Cancel CI run #${String(input.number)}`,
        fields: [["Repository", str(input.repo)]],
      };
    case "api_write":
      return {
        title: str(input.summary) || "Change something through the API",
        fields: [
          ["Request", `${str(input.method)} /api${str(input.path).replace(/^\/?(api\/)?/, "/")}`],
        ],
        body:
          input.body === undefined
            ? undefined
            : "```json\n" + JSON.stringify(input.body, null, 2) + "\n```",
      };
    default:
      return { title: tool, fields: [] };
  }
}

/** A short line for a tool call in a transcript or terminal. */
export function toolLabel(tool: string, input: Record<string, unknown> = {}): string {
  const repo = str(input.repo);
  switch (tool) {
    case "read_file":
      return `Read ${str(input.path)}${input.lines ? ` (lines ${str(input.lines)})` : ""}`;
    case "list_files":
      return `Listed ${str(input.path) || repo || "files"}`;
    case "list_commits":
      return `Read commits in ${repo}`;
    case "file_history":
      return `Read the history of ${str(input.path)}`;
    case "search_code":
      return `Searched ${repo} for “${str(input.query)}”`;
    case "read_wiki":
      return input.slug ? `Read the wiki page ${str(input.slug)}` : `Read ${repo}'s wiki`;
    case "list_repos":
      return "Listed repositories";
    case "find_issues":
      return input.query ? `Searched issues for “${str(input.query)}”` : "Listed issues";
    case "show_issue":
      return `Read ${str(input.key)}`;
    case "ci_runs":
      return `Read CI runs in ${repo}`;
    case "ci_run":
      return `Read CI run #${String(input.number)}`;
    case "ci_logs":
      return `Read logs for ${str(input.job) || "a job"}`;
    case "find_packages":
      return input.query ? `Searched packages for “${str(input.query)}”` : "Listed packages";
    case "api_get":
      return `Read ${str(input.path)}`;
    case "codemode":
      return "Ran a script over several lookups";
    case "activate_skill":
      return `Loaded the ${str(input.name)} skill`;
    case "read_skill_resource":
      return `Read ${str(input.path)} from the ${str(input.name)} skill`;
    case "navigate":
      return `Opened ${str(input.label) || str(input.path)}`;
    default:
      return (WRITE_TOOLS as readonly string[]).includes(tool)
        ? describeWrite(tool, input).title
        : tool.replaceAll("_", " ");
  }
}
