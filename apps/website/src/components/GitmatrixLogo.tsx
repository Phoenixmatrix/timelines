/** The approved Pounce cat and outlined wordmark share one scalable master. */
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
      aria-label="Gitmatrix"
      focusable="false"
      className={`block shrink-0 ${className}`}
    >
      <use href="/brand/gitmatrix.svg?v=pounce#mark" className="text-brand" />
      {!markOnly && <use href="/brand/gitmatrix.svg?v=pounce#wordmark" className="text-ink" />}
    </svg>
  );
}
