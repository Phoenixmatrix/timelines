/** The approved Pounce cat and Timelines wordmark share one scalable master. */
export function GitmatrixLogo({
  markOnly = false,
  className = "",
}: {
  markOnly?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${markOnly ? 315 : 1494} 315`}
      width={markOnly ? 315 : 1494}
      height={315}
      role="img"
      aria-label="Timelines"
      focusable="false"
      className={`block shrink-0 ${className}`}
    >
      <use href="/brand/gitmatrix.svg?v=timelines#mark" className="text-brand" />
      {!markOnly && <use href="/brand/gitmatrix.svg?v=timelines#wordmark" className="text-ink" />}
    </svg>
  );
}

/** The Timelines mark: full color, from the same brand file family. */
export function TimelinesMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="14 3 1227 1227"
      role="img"
      aria-label="Timelines"
      focusable="false"
      className={`block shrink-0 ${className}`}
    >
      <use href="/brand/timelines.svg?v=1#mark" />
    </svg>
  );
}
