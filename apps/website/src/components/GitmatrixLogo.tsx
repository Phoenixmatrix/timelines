/** The generated mark and custom lettering share one scalable source of artwork. */
export function GitmatrixLogo({
  markOnly = false,
  className = "",
}: {
  markOnly?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${markOnly ? 287 : 1393} 315`}
      width={markOnly ? 287 : 1393}
      height={315}
      role="img"
      aria-label="Gitmatrix"
      focusable="false"
      className={`block shrink-0 ${className}`}
    >
      <use href="/brand/gitmatrix.svg#mark" className="text-signal-line" />
      {!markOnly && <use href="/brand/gitmatrix.svg#wordmark" className="text-ink" />}
    </svg>
  );
}
