// Landing merges (CORE-72): timelines land as real git merges into the
// default branch. Git doesn't remember which branch a merge's other parent
// was; the merge message often names it.

/** Branch names timelines push to. */
const TIMELINE_BRANCH = /(?<![\w.-])(timeline\/[\w.-]+(?:\/[\w.-]+)*)/;
/** `Merge branch 'x'`, `Merge remote-tracking branch 'origin/x'`, gm's `Merge x`. */
const MERGE_SUBJECT =
  /^Merge (?:(?:remote-tracking )?branch '([^']+)'|(?!branch\b|remote-tracking\b|commit\b|tag\b|pull request\b)([\w./-]+)(?:\s|$))/;

/** The branch a merge's message says it merged, when it names one. */
export function mergedBranch(message: string): string | null {
  const timeline = TIMELINE_BRANCH.exec(message);
  if (timeline) return timeline[1]!.replace(/\.+$/, "");
  const subject = MERGE_SUBJECT.exec(message.split("\n", 1)[0]!.trim());
  const named = subject?.[1] ?? subject?.[2];
  return named ? named.replace(/^origin\//, "") : null;
}
