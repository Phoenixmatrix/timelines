import { analyzeFile, ANALYSIS_VERSION, MAX_SOURCE_BYTES } from "../../shared/semantic/index.ts";
import type {
  FileAnalysis,
  SemanticFeedEntry,
  SemanticFeedResponse,
} from "../../shared/semantic/types.ts";
import { isCommitId, type RepoReader } from "../objects.ts";
import { isArtifactsError } from "../artifacts.ts";

const LANGUAGES: Record<string, true> = {
  typescript: true,
  tsx: true,
  rust: true,
  python: true,
  go: true,
  markdown: true,
  xml: true,
  json: true,
  html: true,
  css: true,
};
const KIND =
  /^(symbol|parameter|call|argument|import|section|link|element|attribute|property|rule|declaration|text)\.(added|removed|changed|renamed)$|^symbol\.signature_changed$/;
const MAX_TREE_ENTRIES = 20_000;
const MAX_DEPTH = 128;
export class SemanticRequestError extends Error {
  status: 400 | 404;
  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.status = status;
  }
}
export interface FeedQuery {
  ref: string;
  path: string;
  kind: string;
  language: string;
  limit: number;
  cursor?: string;
}
interface Frame {
  before: string | null;
  after: string | null;
  path: string;
  index: number;
}
interface Cursor {
  version: number;
  repo: string;
  ref: string;
  path: string;
  kind: string;
  language: string;
  head: string;
  commit: string;
  started: boolean;
  frames: Frame[];
  entry: number;
}
interface Task {
  path: string;
  before: ArtifactsTreeEntry | null;
  after: ArtifactsTreeEntry | null;
  tree: boolean;
}
export interface AnalysisCache {
  get(key: string): Promise<FileAnalysis | undefined>;
  put(key: string, value: FileAnalysis): Promise<void>;
}
export type FeedReader = Pick<RepoReader, "resolve" | "commit" | "tree" | "blobLimited">;
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32) return true;
  }
  return false;
}
export function parseFeedQuery(query: Record<string, string>): FeedQuery {
  const ref = query.ref || "HEAD";
  const path = query.path || "";
  const kind = query.kind || "";
  const language = query.language || "";
  const limit = query.limit === undefined ? 30 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new SemanticRequestError("limit must be an integer from 1 to 100.");
  if (ref.length > 1024 || hasControlCharacters(ref))
    throw new SemanticRequestError("Invalid ref.");
  if (
    path.length > 4096 ||
    (path && path.split("/").some((part) => !part || part === "." || part === "..")) ||
    hasControlCharacters(path)
  )
    throw new SemanticRequestError("Invalid exact file path.");
  if (kind && !KIND.test(kind)) throw new SemanticRequestError("Unknown semantic change kind.");
  if (language && !Object.hasOwn(LANGUAGES, language))
    throw new SemanticRequestError("Unknown semantic language.");
  return { ref, path, kind, language, limit, cursor: query.cursor };
}

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decodeCursor(raw: string, repo: string, query: FeedQuery): Cursor {
  try {
    if (raw.length > 100_000 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const bytes = Uint8Array.from(atob(raw.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    );
    const value: Cursor = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (
      value.version !== ANALYSIS_VERSION ||
      value.repo !== repo ||
      value.ref !== query.ref ||
      value.path !== query.path ||
      value.kind !== query.kind ||
      value.language !== query.language ||
      !isCommitId(value.head) ||
      !isCommitId(value.commit) ||
      typeof value.started !== "boolean" ||
      !Number.isSafeInteger(value.entry) ||
      value.entry < 0 ||
      !Array.isArray(value.frames) ||
      value.frames.length > MAX_DEPTH
    )
      throw new Error();
    for (const frame of value.frames) {
      if (
        !frame ||
        (frame.before !== null && !isCommitId(frame.before)) ||
        (frame.after !== null && !isCommitId(frame.after)) ||
        typeof frame.path !== "string" ||
        frame.path.length > 4096 ||
        !Number.isSafeInteger(frame.index) ||
        frame.index < 0 ||
        frame.index > MAX_TREE_ENTRIES * 2
      )
        throw new Error();
    }
    return value;
  } catch {
    throw new SemanticRequestError(
      "Invalid cursor, or its repository, ref, filters, or analysis version changed.",
    );
  }
}

/** Files and directories are separate tasks so file/directory replacements retain both sides. */
export function diffTree(
  before: ArtifactsTreeEntry[],
  after: ArtifactsTreeEntry[],
  prefix: string,
): Task[] {
  const old = new Map(before.map((entry) => [entry.name, entry]));
  const next = new Map(after.map((entry) => [entry.name, entry]));
  const tasks: Task[] = [];
  for (const name of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const a = old.get(name) ?? null;
    const b = next.get(name) ?? null;
    if (a?.hash === b?.hash && a?.type === b?.type) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const fileBefore = a?.type !== "tree" ? a : null;
    const fileAfter = b?.type !== "tree" ? b : null;
    if (fileBefore || fileAfter)
      tasks.push({ path, before: fileBefore, after: fileAfter, tree: false });
    const treeBefore = a?.type === "tree" ? a : null;
    const treeAfter = b?.type === "tree" ? b : null;
    if (treeBefore || treeAfter)
      tasks.push({ path, before: treeBefore, after: treeAfter, tree: true });
  }
  return tasks;
}
function warning(path: string, status: FileAnalysis["status"], message: string): FileAnalysis {
  return { path, status, language: null, changes: [], diagnostics: [{ message, from: 0, to: 0 }] };
}
async function analyzeTask(objects: FeedReader, task: Task): Promise<FileAnalysis> {
  if (
    [task.before, task.after].some(
      (entry) => entry && entry.type !== "blob" && entry.type !== "exec",
    )
  )
    return warning(task.path, "unsupported", "Symlinks and Git submodules are not source files.");
  const sources: (string | null)[] = [];
  for (const entry of [task.before, task.after]) {
    if (!entry) {
      sources.push(null);
      continue;
    }
    let blob;
    try {
      blob = await objects.blobLimited(entry.hash, MAX_SOURCE_BYTES);
    } catch (error) {
      if (isArtifactsError(error, "MEMORY_LIMIT"))
        return warning(task.path, "too_large", "Source exceeds the Git service memory limit.");
      throw error;
    }
    if (!blob) throw new Error(`Missing Git blob ${entry.hash} for ${task.path}.`);
    if (blob.size > MAX_SOURCE_BYTES || blob.bytes.byteLength > MAX_SOURCE_BYTES)
      return warning(
        task.path,
        "too_large",
        `Source exceeds the ${MAX_SOURCE_BYTES}-byte analysis limit.`,
      );
    if (blob.bytes.includes(0))
      return warning(task.path, "binary", "Binary content cannot be analyzed as source.");
    try {
      sources.push(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(blob.bytes));
    } catch {
      return warning(task.path, "binary", "Source is not valid UTF-8.");
    }
  }
  return analyzeFile(task.path, sources[0] ?? null, sources[1] ?? null);
}

/** Authorization belongs to the route, before constructing or consulting the cache. */
export async function semanticFeed(
  objects: FeedReader,
  cache: AnalysisCache,
  repo: string,
  base: string,
  query: FeedQuery,
): Promise<SemanticFeedResponse> {
  let cursor = query.cursor ? decodeCursor(query.cursor, repo, query) : null;
  const head = cursor?.head ?? (await objects.resolve(query.ref));
  const response: SemanticFeedResponse = {
    version: ANALYSIS_VERSION,
    ref: query.ref,
    head,
    entries: [],
    coverage: [],
    nextCursor: null,
  };
  if (!head) {
    if (query.ref !== "HEAD") throw new SemanticRequestError("Reference not found.", 404);
    return response;
  }
  cursor ??= {
    version: ANALYSIS_VERSION,
    repo,
    ref: query.ref,
    path: query.path,
    kind: query.kind,
    language: query.language,
    head,
    commit: head,
    started: false,
    frames: [],
    entry: 0,
  };
  let commits = 0;
  let trees = 0;
  let files = 0;
  let steps = 0;
  const taskCache = new Map<string, Task[] | "oversized">();
  let finished = false;
  while (
    commits < 12 &&
    trees < 24 &&
    files < 8 &&
    steps < 512 &&
    response.entries.length < query.limit
  ) {
    const commit = await objects.commit(cursor.commit);
    if (!commit) throw new Error(`Missing Git commit ${cursor.commit}.`);
    const parentId = commit.parents[0] ?? null;
    if (!cursor.started) {
      const parent = parentId ? await objects.commit(parentId) : null;
      if (parentId && !parent) throw new Error(`Missing first-parent commit ${parentId}.`);
      cursor.frames =
        parent?.treeHash === commit.treeHash
          ? []
          : [{ before: parent?.treeHash ?? null, after: commit.treeHash, path: "", index: 0 }];
      cursor.started = true;
    }
    const frame = cursor.frames.at(-1);
    if (!frame) {
      if (!parentId) {
        finished = true;
        break;
      }
      cursor.commit = parentId;
      cursor.started = false;
      cursor.entry = 0;
      commits++;
      continue;
    }
    const treeKey = `${frame.before}:${frame.after}:${frame.path}`;
    let tasks = taskCache.get(treeKey);
    if (!tasks) {
      const sides: ArtifactsTreeEntry[][] = [];
      for (const oid of [frame.before, frame.after]) {
        if (!oid) {
          sides.push([]);
          continue;
        }
        const entries = await objects.tree(oid);
        trees++;
        if (!entries) throw new Error(`Missing Git tree ${oid}.`);
        sides.push(entries);
      }
      tasks = sides.some((side) => side.length > MAX_TREE_ENTRIES)
        ? "oversized"
        : diffTree(sides[0] ?? [], sides[1] ?? [], frame.path);
      taskCache.set(treeKey, tasks);
    }
    if (tasks === "oversized") {
      response.coverage.push({
        commit: commit.hash,
        ...warning(
          frame.path,
          "too_large",
          `Directory exceeds ${MAX_TREE_ENTRIES} entries; its subtree was not analyzed.`,
        ),
      });
      cursor.frames.pop();
      continue;
    }
    const task = tasks[frame.index];
    if (!task) {
      cursor.frames.pop();
      continue;
    }
    steps++;
    if (
      query.path &&
      task.path !== query.path &&
      !(task.tree && query.path.startsWith(`${task.path}/`))
    ) {
      frame.index++;
      continue;
    }
    if (task.tree) {
      frame.index++;
      if (cursor.frames.length >= MAX_DEPTH || task.path.length > 4096) {
        response.coverage.push({
          commit: commit.hash,
          ...warning(
            task.path,
            "too_large",
            "Directory nesting or path exceeds the analysis limit; its subtree was not analyzed.",
          ),
        });
      } else {
        cursor.frames.push({
          before: task.before?.hash ?? null,
          after: task.after?.hash ?? null,
          path: task.path,
          index: 0,
        });
        if (encodeCursor(cursor).length > 60_000) {
          cursor.frames.pop();
          response.coverage.push({
            commit: commit.hash,
            ...warning(
              task.path,
              "too_large",
              "Directory traversal exceeds the cursor size limit; its subtree was not analyzed.",
            ),
          });
        }
      }
      continue;
    }
    files++;
    const key = `${repo}/${ANALYSIS_VERSION}/${commit.hash}/${encodeURIComponent(task.path)}/${task.before?.hash ?? "-"}/${task.after?.hash ?? "-"}`;
    let analysis = await cache.get(key);
    if (!analysis) {
      analysis = await analyzeTask(objects, task);
      await cache.put(key, analysis);
    }
    if (cursor.entry === 0)
      response.coverage.push({
        commit: commit.hash,
        path: task.path,
        status: analysis.status,
        diagnostics: analysis.diagnostics,
      });
    while (cursor.entry < analysis.changes.length && response.entries.length < query.limit) {
      const change = analysis.changes[cursor.entry++]!;
      if (
        (query.kind && change.kind !== query.kind) ||
        (query.language && change.language !== query.language)
      )
        continue;
      const sourceLink = (oid: string | null, source: typeof change.before) =>
        oid && source
          ? `${base}/blob/${oid}/${source.path.split("/").map(encodeURIComponent).join("/")}#L${source.start.line}`
          : null;
      const entry: SemanticFeedEntry = {
        ...change,
        id: `${commit.hash}:${encodeURIComponent(task.path)}:${change.id}`,
        commit: {
          oid: commit.hash,
          parent: parentId,
          message: commit.message,
          authorName: commit.author.name,
          authoredAt: new Date(commit.authoredAt * 1000).toISOString(),
        },
        links: {
          commit: `${base}/commits/${commit.hash}`,
          before: sourceLink(parentId, change.before),
          after: sourceLink(commit.hash, change.after),
        },
      };
      response.entries.push(entry);
    }
    if (cursor.entry >= analysis.changes.length) {
      frame.index++;
      cursor.entry = 0;
    }
  }
  if (!finished) response.nextCursor = encodeCursor(cursor);
  return response;
}
