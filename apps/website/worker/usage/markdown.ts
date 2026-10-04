// Reading Cloudflare's published pricing pages (their `index.md` markdown) without
// AI (CORE-208): the tables, the prose around them, and the amounts and prices
// written in their cells. Everything here is deterministic text handling; the
// page-by-page knowledge of where each price lives is in pages.ts.

export interface MarkdownTable {
  /** The nearest heading above the table (without `#`), or "" before any heading. */
  heading: string;
  headers: string[];
  rows: string[][];
}

/** Markdown links, HTML and emphasis reduced to their text; `<br>` becomes a newline. */
export function plain(text: string): string {
  return text
    .replace(/<sup>.*?<\/sup>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\\([*_|\\~])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => plain(cell));

const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

/** Every pipe table on the page, with the heading it sits under. */
export function markdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split("\n");
  const tables: MarkdownTable[] = [];
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const title = /^#{1,6}\s+(.*)$/.exec(line);
    if (title) {
      heading = plain(title[1]!);
      continue;
    }
    if (!line.trim().startsWith("|") || !SEPARATOR.test(lines[i + 1]?.trim() ?? "")) continue;
    const headers = cells(line);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.trim().startsWith("|"); j++) rows.push(cells(lines[j]!));
    tables.push({ heading, headers, rows });
    i = j - 1;
  }
  return tables;
}

/** The page's prose as plain text (links reduced to their text), for sentences like billing dates. */
export function prose(markdown: string): string {
  return plain(markdown.replace(/```[\s\S]*?```/g, ""));
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** `October 14, 2026` / `August 10th, 2026` / `Oct 1, 2026` → `2026-10-14`; null if it isn't one. */
export function isoDate(text: string): string | null {
  const match = /^([A-Za-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const month = MONTHS.findIndex((m) => m === name || (name.length >= 3 && m.startsWith(name)));
  const day = Number(match[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A date written in prose, as the pattern's capture: `(Month D, YYYY)`. */
export const DATE_IN_PROSE = String.raw`([A-Z][a-z]+\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4})`;

/** When the page says it was last changed: its JSON-LD `dateModified`, else "Last updated …". */
export function lastUpdated(markdown: string): string | null {
  const modified = /"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(markdown);
  if (modified) return modified[1]!;
  const line = new RegExp(`Last updated ${DATE_IN_PROSE}`).exec(markdown);
  return line ? isoDate(line[1]!) : null;
}

const SCALE: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  million: 1e6,
  millions: 1e6,
  billion: 1e9,
  billions: 1e9,
};

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const SCALE_WORD = String.raw`(thousand|millions?|billions?|M|k)\b`;

function scaled(number: string | undefined, word: string | undefined): number | null {
  if (number === undefined && word === undefined) return null;
  const n = number === undefined ? 1 : Number(number.replace(/,/g, ""));
  const scale = word === undefined ? 1 : SCALE[word === "M" ? "m" : word.toLowerCase()];
  if (!Number.isFinite(n) || scale === undefined) return null;
  // 25 × 1e9 and 0.5 × 1e6 are exact; round off the float noise of e.g. 1.1 × 1e6.
  return Math.round(n * scale * 1e6) / 1e6;
}

/** The first amount in the text: `25 billion`, `400,000`, `1 million`, `5`. Null if there is none. */
export function amount(text: string): number | null {
  const match = new RegExp(`${NUMBER}(?:\\s*${SCALE_WORD})?`).exec(text);
  return match ? scaled(match[1], match[2]) : null;
}

export interface WrittenPrice {
  /** USD for `quantity` units. */
  usd: number;
  /** How many units the price is for: `/ million rows` is 1,000,000; `/ GB-month` is 1. */
  quantity: number;
  /** What follows the quantity, e.g. `rows`, `GB-mo`, `per month`; "" when nothing does. */
  unit: string;
}

// Within one line: a cell's next line (`<br>`) is another price or a note.
const PRICE = new RegExp(
  String.raw`\$[ \t]*` +
    NUMBER +
    String.raw`[ \t]*(?:\/|per)[ \t]*(?:additional[ \t]+)?(?:` +
    NUMBER +
    // A quantity stands alone: in `per 512x512 tile` the 512 is part of the unit.
    String.raw`(?=[ \t]|$)[ \t]*)?(?:` +
    SCALE_WORD +
    String.raw`)?[ \t]*([^\n]*)`,
  "m",
);

/** The first `$X / [quantity] unit` price in the text, or null. */
export function writtenPrice(text: string): WrittenPrice | null {
  const match = PRICE.exec(text);
  if (!match) return null;
  const usd = Number(match[1]!.replace(/,/g, ""));
  const quantity = scaled(match[2], match[3]) ?? 1;
  return { usd, quantity, unit: match[4]!.trim() };
}
