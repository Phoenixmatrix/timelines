export interface LineSelection {
  start: number;
  end: number;
}

const validLine = (line: number) => Number.isSafeInteger(line) && line > 0;

/** Accept only complete line anchors; normalize direction and bound to visible source. */
export function parseLineAnchor(hash: string, lineCount: number): LineSelection | null {
  const match = /^#L(\d+)(?:-L(\d+))?$/.exec(hash);
  if (!match || !validLine(lineCount)) return null;
  const first = Number(match[1]);
  const last = Number(match[2] ?? match[1]);
  if (!validLine(first) || !validLine(last)) return null;
  const start = Math.min(first, last);
  if (start > lineCount) return null;
  return { start, end: Math.min(Math.max(first, last), lineCount) };
}

/** Canonical links always put the lower line first and collapse one-line ranges. */
export function lineAnchor(first: number, last = first): string {
  if (!validLine(first) || !validLine(last)) throw new RangeError("Invalid source line");
  const start = Math.min(first, last);
  const end = Math.max(first, last);
  return start === end ? `#L${start}` : `#L${start}-L${end}`;
}
