// A person's name as a link to their profile (/accounts/<slug>). Agents are never
// linked: callers pass only person accounts, and the name stays text when no
// slug is known.

import type { ReactNode } from "react";
import { Link } from "react-router";
import { link } from "./ui.tsx";

/** In metadata rows names keep the surrounding tone and brighten on hover; in running text they take the link underline. */
export const personLink = "no-underline hover:text-ink";

export function PersonLink({
  slug,
  children,
  prose = false,
  className = "",
}: {
  /** The person's account slug; without one the name renders as text. */
  slug: string | null | undefined;
  children: ReactNode;
  /** Running text: the design system's underlined link style. */
  prose?: boolean;
  className?: string;
}) {
  if (!slug) return <>{children}</>;
  return (
    <Link
      to={`/accounts/${encodeURIComponent(slug)}`}
      className={`${prose ? link : personLink} ${className}`.trim()}
    >
      {children}
    </Link>
  );
}
