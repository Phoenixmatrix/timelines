// The side rail that repository pages grow from xl up: a quiet column of
// titled sections on the page surface, divided by hairlines, never a card.

import { FileIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { PrefetchLink } from "./PrefetchLink.tsx";

/** Sticky from xl, scrolling on its own when taller than the window. */
export const railClass =
  "min-w-0 xl:sticky xl:top-6 xl:max-h-[calc(100dvh-3rem)] xl:self-start xl:overflow-y-auto xl:[scrollbar-width:thin]";

export function RailSection({
  title,
  count,
  action,
  children,
  className = "",
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`border-t border-line-soft py-4 first:border-t-0 first:pt-0 ${className}`}>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="m-0 text-body-sm font-semibold text-ink">{title}</h2>
        {count !== undefined && (
          <span className="font-mono text-micro text-ink-faint tabular-nums">{count}</span>
        )}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

/** One file as a compact link row: name in ink, its folder faint after it. */
export function FileRow({ to, path }: { to: string; path: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <li>
      <PrefetchLink
        to={to}
        title={path}
        className="-mx-2 flex h-8 min-w-0 items-center gap-2 rounded-plate px-2 font-mono text-mono text-ink no-underline transition-colors hover:bg-raised"
      >
        <FileIcon className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        <span className="shrink-0">{path.slice(slash + 1)}</span>
        {slash > 0 && <span className="truncate text-ink-faint">{path.slice(0, slash)}</span>}
      </PrefetchLink>
    </li>
  );
}
