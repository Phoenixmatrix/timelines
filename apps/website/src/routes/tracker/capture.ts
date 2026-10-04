export interface CaptureTitle {
  title: string;
  labels: string[];
  unknown: string[];
  error: string | null;
}

/** Only leading, complete parenthesized groups are tags; later parentheses are title text. */
export function parseCaptureTitle(input: string, catalog: readonly string[]): CaptureTitle {
  const result: CaptureTitle = { title: input.trim(), labels: [], unknown: [], error: null };
  const known = new Map(catalog.map((label) => [label.toLowerCase(), label]));
  const seen = new Set<string>();
  let prefix: RegExpExecArray | null;
  while ((prefix = /^\(([^()]*)\)\s*/.exec(result.title))) {
    const label = prefix[1]!.trim();
    result.title = result.title.slice(prefix[0].length).trimStart();
    if (!label || label.length > 100 || label.includes("\0")) {
      result.error = "Tags must be 1–100 characters without NUL.";
      continue;
    }
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const defined = known.get(key);
    if (defined !== undefined) result.labels.push(defined);
    else result.unknown.push(label);
  }
  return result;
}
