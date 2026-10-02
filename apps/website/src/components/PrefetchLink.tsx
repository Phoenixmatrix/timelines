import type { Ref } from "react";
import { Link, type LinkProps } from "react-router";
import { prefetchRoute } from "../lib/repoData.ts";

/** A Link that starts loading its page's data as soon as it is pointed at. */
export function PrefetchLink({
  onPointerEnter,
  onFocus,
  onTouchStart,
  ...props
}: LinkProps & { ref?: Ref<HTMLAnchorElement> }) {
  const warm = () =>
    prefetchRoute(typeof props.to === "string" ? props.to : (props.to.pathname ?? ""));
  return (
    <Link
      {...props}
      onPointerEnter={(event) => {
        warm();
        onPointerEnter?.(event);
      }}
      onFocus={(event) => {
        warm();
        onFocus?.(event);
      }}
      onTouchStart={(event) => {
        warm();
        onTouchStart?.(event);
      }}
    />
  );
}
