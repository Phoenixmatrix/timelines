import { useState, type CSSProperties } from "react";

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
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  /** A person's profile picture; the initials show until it loads, or if it can't. */
  src?: string | null;
}

export function Monogram({
  name,
  shape = "person",
  size = "md",
  className = "",
  src,
}: MonogramProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const classes = [
    "mk-monogram",
    shape === "place" && "mk-monogram--squircle",
    size === "xs" && "mk-monogram--xs",
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
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          className="size-full rounded-[inherit] object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(src)}
        />
      ) : (
        monogramInitials(name)
      )}
    </span>
  );
}
