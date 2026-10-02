import type { ReactNode } from "react";
import type { SemanticSource } from "../../shared/semantic/types.ts";

const tokenColors: Record<string, string> = {
  "tok-keyword": "text-data-violet",
  "tok-string": "text-online",
  "tok-string2": "text-online",
  "tok-number": "text-signal",
  "tok-bool": "text-signal",
  "tok-null": "text-signal",
  "tok-comment": "text-ink-faint",
  "tok-typeName": "text-data-violet",
  "tok-className": "text-data-violet",
  "tok-tagName": "text-data-violet",
  "tok-propertyName": "text-signal",
  "tok-attributeName": "text-signal",
  "tok-heading": "text-signal font-semibold",
  "tok-link": "text-signal underline",
  "tok-invalid": "text-danger-text",
};

/** Render only text and allowlisted styles, never server-provided markup. */
export function HighlightedSource({
  text,
  tokens,
}: {
  text: string;
  tokens: SemanticSource["tokens"];
}): ReactNode {
  const parts: ReactNode[] = [];
  let position = 0;
  for (const token of tokens) {
    if (
      !Number.isInteger(token.from) ||
      !Number.isInteger(token.to) ||
      token.from < position ||
      token.to <= token.from ||
      token.to > text.length
    )
      continue;
    if (token.from > position) parts.push(text.slice(position, token.from));
    const className = token.className
      .split(/\s+/)
      .map((name) => (Object.hasOwn(tokenColors, name) ? tokenColors[name] : ""))
      .filter(Boolean)
      .join(" ");
    parts.push(
      <span key={`${token.from}:${token.to}`} className={className || undefined}>
        {text.slice(token.from, token.to)}
      </span>,
    );
    position = token.to;
  }
  parts.push(text.slice(position));
  return parts;
}
