/**
 * Issue keys a commit message mentions: `TEAM-N`, where TEAM is a team key
 * (an uppercase letter, then 1–5 uppercase letters or digits) and N has no
 * leading zero. Things that merely look like keys, such as `UTF-8`, survive
 * parsing; resolving against real teams drops them.
 */
const KEY = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{1,5})-([1-9][0-9]{0,8})(?![A-Za-z0-9_])/g;

/** Distinct keys in order of first mention. */
export function issueKeys(message: string): string[] {
  const keys = new Set<string>();
  for (const match of message.matchAll(KEY)) keys.add(`${match[1]}-${match[2]}`);
  return [...keys];
}
