import type { Services } from "./context.ts";
import { virtualMembers, type Repository, type VirtualMember } from "./repos.ts";

/**
 * Resolution for virtual repositories. For every name, local members are
 * consulted before remote ones (a local package always wins and blocks the
 * same name upstream: automatic dependency-confusion protection), pinned
 * namespaces never reach remotes, and per-member include/exclude globs apply.
 */

export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(name: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(name));
}

export function memberAllows(
  member: Pick<VirtualMember, "include" | "exclude">,
  name: string,
): boolean {
  if (member.include.length > 0 && !matchesAny(name, member.include)) return false;
  return !matchesAny(name, member.exclude);
}

export function isPinned(repo: Repository, name: string): boolean {
  return matchesAny(name, repo.config.pinnedNamespaces ?? []);
}

const memberCache = new Map<string, { members: VirtualMember[]; until: number }>();

export async function members(services: Services, repo: Repository): Promise<VirtualMember[]> {
  const hit = memberCache.get(repo.id);
  if (hit && hit.until > Date.now()) return hit.members;
  const list = await virtualMembers(services.db, repo.id);
  memberCache.set(repo.id, { members: list, until: Date.now() + 10_000 });
  return list;
}

export function invalidateMembers(): void {
  memberCache.clear();
}

/**
 * The members that may serve `name`, in resolution order: readable locals
 * first, then (unless the name is pinned) readable remotes.
 */
export async function candidates(
  services: Services,
  repo: Repository,
  name: string,
): Promise<Repository[]> {
  const access = await services.access();
  const eligible: VirtualMember[] = [];
  for (const member of await members(services, repo)) {
    if (!memberAllows(member, name)) continue;
    if (!(await access.can(member.repo, "read"))) continue;
    eligible.push(member);
  }
  const locals = eligible.filter((m) => m.repo.kind === "local").map((m) => m.repo);
  const remotes = isPinned(repo, name)
    ? []
    : eligible.filter((m) => m.repo.kind === "remote").map((m) => m.repo);
  return [...locals, ...remotes];
}

/** First member (in resolution order) for which `probe` returns a value. */
export async function firstMatch<T>(
  services: Services,
  repo: Repository,
  name: string,
  probe: (member: Repository) => Promise<T | null>,
): Promise<{ member: Repository; value: T } | null> {
  for (const member of await candidates(services, repo, name)) {
    const value = await probe(member);
    if (value !== null) return { member, value };
  }
  return null;
}

/** Every member's value, for formats that merge (with `mergeVersions`). */
export async function allMatches<T>(
  services: Services,
  repo: Repository,
  name: string,
  probe: (member: Repository) => Promise<T | null>,
): Promise<{ member: Repository; value: T }[]> {
  const out: { member: Repository; value: T }[] = [];
  for (const member of await candidates(services, repo, name)) {
    const value = await probe(member);
    if (value !== null) out.push({ member, value });
  }
  return out;
}

/** The local repository that receives publishes sent to a virtual repository. */
export async function deployTarget(
  services: Services,
  repo: Repository,
): Promise<Repository | null> {
  const key = repo.config.defaultDeployRepo;
  if (!key) return null;
  const member = (await members(services, repo)).find(
    (m) => m.repo.key === key && m.repo.kind === "local",
  );
  return member?.repo ?? null;
}
