// Refs in rendered text (CORE-22): a resolved ref is a link, an ambiguous one
// a small chooser, and anything else stays exactly as written. The text shows
// at once; links arrive with the batch's answer, without moving anything.

import { Popover } from "@base-ui/react/popover";
import { Fragment, useMemo, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import {
  splitRefs,
  type RefContext,
  type RefKind,
  type RefResolution,
  type RefTarget,
  type ScanOptions,
} from "../../shared/refs.ts";
import { link, popMotion } from "../components/ui.tsx";
import { refHref, useRefContext } from "./context.ts";
import { useRefResolution, useRefResolutions } from "./resolver.ts";

const KIND_LABEL: Record<RefTarget["kind"], string> = {
  issue: "Issue",
  commit: "Commit",
  repo: "Repository",
  package: "Package",
};

/** A link to a resolved target, named by the text it replaces. */
export function RefAnchor({
  target,
  children,
  className = link,
}: {
  target: RefTarget;
  children: ReactNode;
  className?: string;
}) {
  const location = useLocation();
  return (
    <Link
      to={refHref(target, location)}
      className={className}
      title={target.label}
      data-ref-kind={target.kind}
    >
      {children}
    </Link>
  );
}

/** An ambiguous ref: the text opens a short list of what it could be. */
export function RefChooser({
  text,
  candidates,
  className = link,
}: {
  text: string;
  candidates: RefTarget[];
  className?: string;
}) {
  const location = useLocation();
  return (
    <Popover.Root>
      <Popover.Trigger
        className={`${className} decoration-dotted cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] leading-[inherit]`}
        aria-label={`${text}: ${candidates.length} matches, choose one`}
      >
        {text}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <Popover.Popup className={`mk-popup ${popMotion} w-[min(22rem,calc(100vw-2rem))] p-1.5`}>
            <Popover.Title className="m-0 px-2.5 pt-1.5 pb-1 text-label text-ink-faint">
              {text} could be
            </Popover.Title>
            <ul className="m-0 list-none p-0">
              {candidates.map((target) => (
                <li key={target.path}>
                  <Link
                    to={refHref(target, location)}
                    className="flex min-h-9 flex-col justify-center rounded-plate px-2.5 py-1.5 text-body-sm text-ink no-underline hover:bg-raised focus-visible:bg-raised max-sm:min-h-11"
                  >
                    <span className="truncate">{target.label}</span>
                    <span className="text-micro text-ink-faint">
                      {KIND_LABEL[target.kind]}
                      {target.kind === "issue" ? ` in ${target.tracker}` : ""}
                      {target.kind === "package" ? ` in ${target.owner}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * One candidate as its answer says: a link, a chooser, plain text for a URL
 * of our own tracker the viewer can't open, and otherwise `fallback` (the
 * text as written) — also while the answer is on its way.
 */
export function ResolvedRef({
  text,
  resolution,
  fallback,
  className,
}: {
  text: string;
  resolution: RefResolution | null;
  fallback?: ReactNode;
  className?: string;
}) {
  if (resolution?.status === "resolved")
    return (
      <RefAnchor target={resolution.target} className={className}>
        {text}
      </RefAnchor>
    );
  if (resolution?.status === "ambiguous")
    return <RefChooser text={text} candidates={resolution.candidates} className={className} />;
  if (resolution?.status === "unresolved" && resolution.ours) return <>{text}</>;
  return <>{fallback ?? text}</>;
}

/** One candidate that resolves itself (Markdown renders these one by one). */
export function RefNode({
  text,
  fallback,
  context,
}: {
  text: string;
  fallback?: ReactNode;
  context?: RefContext;
}) {
  const where = useRefContext(context);
  const resolution = useRefResolution(text, where);
  return <ResolvedRef text={text} resolution={resolution} fallback={fallback} />;
}

/**
 * Plain text with its refs linked: commit titles, CI run titles, release
 * notes. `plain` renders the text between refs (and refs that didn't
 * resolve), e.g. as the row's own link; consecutive plain text is one piece,
 * so before the answer arrives this renders exactly what `plain(text)` would.
 */
export function LinkedText({
  text,
  context,
  plain,
  only,
  linkClassName,
}: {
  text: string;
  context?: RefContext;
  plain?: (text: string) => ReactNode;
  /** Link only these kinds (CI logs link hashes alone). */
  only?: RefKind[];
  linkClassName?: string;
}) {
  const where = useRefContext(context);
  const commits = !!where.repo;
  const kinds = only?.join(",") ?? "";
  const pieces = useMemo(() => {
    const options: ScanOptions = { commits };
    if (kinds) options.kinds = kinds.split(",") as RefKind[];
    return splitRefs(text, options);
  }, [text, commits, kinds]);
  const refs = pieces.flatMap((piece) => (piece.span ? [piece.span.ref] : []));
  const answers = useRefResolutions(refs, where);
  const byRef = new Map(refs.map((ref, i) => [ref, answers[i] ?? null]));
  // Runs of text that stay text, joined, and the refs that became something.
  const runs: ({ text: string } | { text: string; resolution: RefResolution })[] = [];
  for (const piece of pieces) {
    const resolution = piece.span ? byRef.get(piece.span.ref) : null;
    // Unresolved refs, our own tracker's URLs included, read as the text around them.
    const shown = resolution && resolution.status !== "unresolved" ? resolution : null;
    const last = runs.at(-1);
    if (shown) runs.push({ text: piece.text, resolution: shown });
    else if (last && !("resolution" in last)) last.text += piece.text;
    else runs.push({ text: piece.text });
  }
  return (
    <>
      {runs.map((run, i) => (
        <Fragment key={i}>
          {"resolution" in run ? (
            <ResolvedRef
              text={run.text}
              resolution={run.resolution}
              fallback={plain ? plain(run.text) : run.text}
              className={linkClassName}
            />
          ) : plain ? (
            plain(run.text)
          ) : (
            run.text
          )}
        </Fragment>
      ))}
    </>
  );
}
