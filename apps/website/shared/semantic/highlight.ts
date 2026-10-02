import { classHighlighter, highlightTree } from "@lezer/highlight";
import { languageAdapters } from "./index.ts";
import { MAX_SOURCE_BYTES } from "./limits.ts";
import type { SemanticLanguage, SemanticSource } from "./types.ts";

export type HighlightResult = {
  language: SemanticLanguage;
  lines: SemanticSource["tokens"][];
};

/** Parse syntax only, with UTF-16 token offsets relative to each original line. */
export function highlightLines(path: string, text: string): HighlightResult | null {
  const filenameStart = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  const dot = path.lastIndexOf(".");
  if (dot < filenameStart) return null;
  const extension = path.slice(dot).toLowerCase();
  const adapter = languageAdapters.find((candidate) => candidate.extensions.includes(extension));
  if (
    !adapter ||
    text.length > MAX_SOURCE_BYTES ||
    text.includes("\0") ||
    new TextEncoder().encode(text).length > MAX_SOURCE_BYTES
  ) {
    return null;
  }

  try {
    const tree = adapter.parser.parse(text);
    // Match the file viewer's text.replace(/\n$/, "").split("\n") policy without
    // copying source lines. Keep CR characters and omit only the final LF.
    const end = text.endsWith("\n") ? text.length - 1 : text.length;
    const starts = [0];
    const lines: SemanticSource["tokens"][] = [[]];
    for (let offset = 0; offset < end; offset++) {
      if (text.charCodeAt(offset) === 10) {
        starts.push(offset + 1);
        lines.push([]);
      }
    }
    let line = 0;
    highlightTree(tree, classHighlighter, (from, to, className) => {
      while (line + 1 < starts.length && starts[line + 1]! <= from) line++;
      for (let index = line; index < starts.length && starts[index]! < to; index++) {
        const start = starts[index]!;
        const lineEnd = index + 1 < starts.length ? starts[index + 1]! - 1 : end;
        const clippedFrom = Math.max(from, start);
        const clippedTo = Math.min(to, lineEnd);
        if (clippedFrom < clippedTo) {
          lines[index]!.push({ from: clippedFrom - start, to: clippedTo - start, className });
        }
      }
    });
    return { language: adapter.language, lines };
  } catch {
    return null;
  }
}
