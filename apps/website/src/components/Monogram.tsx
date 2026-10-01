import type { CSSProperties } from "react";

// Ported from MatrixKit's bundle.js so React renders the same tints.
export function monogramHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

function firstGrapheme(word: string | undefined): string {
  if (!word) return "";
  const first = new Intl.Segmenter().segment(word)[Symbol.iterator]().next();
  return first.done ? "" : first.value.segment;
}

export function monogramInitials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const first = firstGrapheme(words[0]) || "?";
  const pair = first + firstGrapheme(words[1]);
  return pair.toUpperCase() === pair.toLowerCase() ? first : pair.toUpperCase();
}

interface MonogramProps {
  name: string;
  /** Circles for people, squircles for places (orgs). */
  shape?: "person" | "place";
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function Monogram({ name, shape = "person", size = "md", className = "" }: MonogramProps) {
  const classes = [
    "mk-monogram",
    shape === "place" && "mk-monogram--squircle",
    size === "sm" && "mk-monogram--sm",
    size === "lg" && "mk-monogram--lg",
    className,
  ];
  return (
    <span
      className={classes.filter(Boolean).join(" ")}
      style={{ "--hue": monogramHue(name) } as CSSProperties}
      aria-hidden="true"
    >
      {monogramInitials(name)}
    </span>
  );
}
