// Deleting Cloudflare resources through `cf`, shared by tools/preview (CI
// preview runs) and tools/agent (environment destroy and the remote cleanup).
// It imports nothing: tools/agent/maintenance.ts copies it beside
// environment.ts and remote.ts for the hourly janitors, which run outside the
// checkout and can resolve only the files those lists copy.

import { setTimeout as delay } from "node:timers/promises";

/** Runs one `cf` argv and returns its stdout; rejects with an error carrying cf's stderr. */
export type CfRun = (args: string[]) => Promise<string>;

/** An SGR escape (ESC [ … m), written without a literal control character. */
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Only an explicit "this resource is not there" is idempotent; permission,
 * network and CLI failures must fail. Two forms count:
 *
 * - `404 Not Found`: the status line cf prints under every API error
 *   (`APIError … [code] message … 404 Not Found · HTTP /accounts/…`), whatever
 *   the product's own code or wording (D1, R2, Artifacts). The phrase, not a
 *   bare 404: the same error prints the request path, and a slug such as
 *   `fix-404` there would make a 403 look like absence.
 * - a resource-qualified "<kind> not found", as AI Search, Vectorize and AI
 *   Gateway word it in tools/agent/environment.ts's destroy path.
 *
 * Not bare "not found", "does not exist" or "no such": they match
 * `cf: command not found`, a missing `--profile` and spawn's ENOENT ("no such
 * file or directory"), turning a broken cf into a teardown that reports success.
 * Not Cloudflare error codes 10007/10025 either: those are the Workers API's
 * Worker and Preview not-found codes (tools/preview/preview.ts reads them from
 * API bodies itself), not D1, R2 or Artifacts codes, and a real 404 from those
 * products already carries the status line.
 */
export function absent(error: unknown): boolean {
  // cf colours its output when it may (`\x1b[38;2;127;127;127m404 Not Found`),
  // and `\b` fails after an escape's `m`: match the text without them.
  const text = String(error).replace(COLOUR, "");
  return (
    /\b404 Not Found\b/.test(text) ||
    /\b(?:resource|namespace|index|instance|gateway) not found\b/i.test(text)
  );
}

/** Cloudflare's refusal to delete a namespace that still counts a repository (CORE-302). */
export function refusedNotEmpty(error: unknown): boolean {
  return /namespace is not empty/i.test(String(error));
}

/** Await some work, treating an explicit absence (by `isAbsent`) as done. */
export async function ignoringAbsent(
  work: Promise<unknown>,
  isAbsent: (error: unknown) => boolean = absent,
): Promise<void> {
  try {
    await work;
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
}

/** How many deletes one repository gets before a namespace that keeps listing it is an error. */
export const REPO_DELETE_ATTEMPTS = 3;

export interface NamespaceDeletion {
  /** What counts as "not there"; defaults to {@link absent}. */
  absent?: (error: unknown) => boolean;
  /**
   * Called (and awaited) with Cloudflare's refusal when it won't delete a
   * namespace that lists no repositories (CORE-302); the deletion then returns
   * "orphaned". Without it, that refusal is thrown.
   */
  onOrphan?: (error: unknown) => unknown;
  /** Deletes per repository before giving up; defaults to {@link REPO_DELETE_ATTEMPTS}. */
  attempts?: number;
  /**
   * Pauses before deleting repositories a list shows again (a list may lag
   * its deletes): `ms` grows with each repeat. Defaults to a real delay.
   */
  wait?: (ms: number) => Promise<unknown>;
  /**
   * A time (by `clock`) after which no further `cf` call starts: the deletion
   * throws instead, leaving the namespace for a later run. Default: none.
   */
  deadline?: number;
  /** The time `deadline` is measured by; defaults to Date.now. */
  clock?: () => number;
}

/** The pause before a list's repeated repositories are deleted again, per earlier delete. */
const REPEAT_PAUSE_MS = 2_000;

/** A namespace's first page of repositories (up to 100), or null when the namespace doesn't exist. */
export async function listArtifactsRepos(
  run: CfRun,
  namespace: string,
  isAbsent: (error: unknown) => boolean = absent,
): Promise<{ name: string }[] | null> {
  try {
    return JSON.parse(
      await run([
        "artifacts",
        "namespaces",
        "repos",
        "list",
        "--namespace",
        namespace,
        "--limit",
        "100",
      ]),
    ) as { name: string }[];
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

/**
 * Delete an Artifacts namespace: its repositories a page at a time (each
 * relisted after its deletes, so no cursor goes stale), then the namespace.
 *
 * - "absent": the namespace wasn't there, or a concurrent delete removed it.
 * - "deleted": it was there and now isn't.
 * - "orphaned": Cloudflare refuses to delete it as not empty although a fresh
 *   list shows no repositories (a known Artifacts bug), and `onOrphan` took it.
 *
 * A repository that is still listed after {@link NamespaceDeletion.attempts}
 * deletes (each succeeding or answering "absent") throws rather than spinning,
 * and so does reaching {@link NamespaceDeletion.deadline}.
 */
export async function deleteArtifactsNamespace(
  run: CfRun,
  namespace: string,
  options: NamespaceDeletion = {},
): Promise<"deleted" | "absent" | "orphaned"> {
  const isAbsent = options.absent ?? absent;
  const attempts = options.attempts ?? REPO_DELETE_ATTEMPTS;
  const deletes = new Map<string, number>();
  const clock = options.clock ?? Date.now;
  const due = () => {
    if (options.deadline !== undefined && clock() >= options.deadline)
      throw new Error(`Deleting Artifacts namespace ${namespace} ran out of time.`);
  };
  for (;;) {
    due();
    const repos = await listArtifactsRepos(run, namespace, isAbsent);
    if (!repos) return "absent";
    if (!repos.length) break;
    // A repository listed again after its delete succeeded or answered
    // "absent": wait for the list to catch up, then give up rather than spin.
    let repeats = 0;
    for (const repo of repos) {
      const earlier = deletes.get(repo.name) ?? 0;
      if (earlier >= attempts)
        throw new Error(
          `Artifacts namespace ${namespace} still lists repository ${repo.name} after ${attempts} deletes.`,
        );
      repeats = Math.max(repeats, earlier);
    }
    if (repeats) await (options.wait ?? delay)(REPEAT_PAUSE_MS * repeats);
    for (const repo of repos) {
      due();
      deletes.set(repo.name, (deletes.get(repo.name) ?? 0) + 1);
      await ignoringAbsent(
        run([
          "artifacts",
          "namespaces",
          "repos",
          "delete",
          repo.name,
          "--namespace",
          namespace,
          "--force",
        ]),
        isAbsent,
      );
    }
  }
  due();
  try {
    await run(["artifacts", "namespaces", "delete", namespace, "--force"]);
    return "deleted";
  } catch (error) {
    if (isAbsent(error)) return "absent";
    if (!refusedNotEmpty(error)) throw error;
    const listed = await listArtifactsRepos(run, namespace, isAbsent);
    if (!listed) return "absent";
    if (listed.length || !options.onOrphan) throw error;
    await options.onOrphan(error);
    return "orphaned";
  }
}
