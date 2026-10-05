import { ISSUE_KEY } from "../../shared/refs.ts";

/**
 * Issue keys a commit message mentions: `TEAM-N` (ISSUE_KEY, shared with the
 * autolinker). Things that merely look like keys, such as `UTF-8`, survive
 * parsing; resolving against real teams drops them.
 */
const KEY = ISSUE_KEY;

/** Distinct keys in order of first mention. */
export function issueKeys(message: string): string[] {
  const keys = new Set<string>();
  for (const match of message.matchAll(KEY)) keys.add(`${match[1]}-${match[2]}`);
  return [...keys];
}
