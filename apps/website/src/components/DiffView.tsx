// A change as a person reads it (CORE-382): a summary, a list of the files to
// jump between, and each file's hunks with line numbers and best-effort syntax
// colour. Used for a commit's diff (the story's steps, the commit panel) and
// for whatever else carries DiffFile[], such as a whole timeline's compare.

import { FileMinusIcon, FilePlusIcon, FileTextIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { DiffFile, DiffHunk } from "../../shared/diff.ts";
import type { HighlightResult } from "../../shared/semantic/highlight.ts";
import { startHighlight, type HighlightJob } from "../lib/highlightWorker.ts";
import { HighlightedSource } from "./HighlightedSource.tsx";
import { link } from "./ui.tsx";

/**
 * Files start expanded unless the diff is large: past this many files or
 * changed lines only the first EXPANDED_OF_LARGE files (and the selected
 * one) start open, and the rest are one click away in the file list.
 */
export const LARGE_FILES = 15;
export const LARGE_LINES = 1500;
export const EXPANDED_OF_LARGE = 3;

/** Highlighting stops asking after this many bytes of hunk text per file. */
const MAX_HIGHLIGHT_BYTES = 200_000;

type Tokens = HighlightResult["lines"];

const STATUS_ICON: Record<DiffFile["status"], ReactNode> = {
  added: <FilePlusIcon weight="bold" className="shrink-0 text-online" aria-label="Added" />,
  deleted: (
    <FileMinusIcon weight="bold" className="shrink-0 text-danger-text" aria-label="Deleted" />
  ),
  modified: (
    <FileTextIcon weight="bold" className="shrink-0 text-ink-faint" aria-label="Modified" />
  ),
};

/** The paths that start open for these files. */
export function initiallyOpen(files: DiffFile[], selected: string | null): Set<string> {
  const lines = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const large = files.length > LARGE_FILES || lines > LARGE_LINES;
  const open = new Set(
    (large ? files.slice(0, EXPANDED_OF_LARGE) : files).map((file) => file.path),
  );
  if (selected && files.some((f) => f.path === selected)) open.add(selected);
  return open;
}

/** A hunk's text for the highlighter: the code of each line, signs stripped. */
const hunkText = (hunk: DiffHunk) => hunk.lines.map((line) => line.slice(1)).join("\n");

/**
 * Tokens by `path#hunk`, for the files wanted, parsed in one background
 * worker. They belong to `scope`, the diff's files: another diff may have the
 * same path with other content (CORE-382).
 */
function useDiffHighlight(files: DiffFile[], scope: DiffFile[]): Map<string, Tokens> {
  const [held, setHeld] = useState(() => ({ scope, tokens: new Map<string, Tokens>() }));
  let tokens = held.tokens;
  if (held.scope !== scope) {
    tokens = new Map();
    setHeld({ scope, tokens });
  }
  const wanted = useMemo(() => {
    const jobs: HighlightJob[] = [];
    for (const file of files) {
      if (file.binary || file.omitted) continue;
      let bytes = 0;
      file.hunks.forEach((hunk, h) => {
        const text = hunkText(hunk);
        bytes += text.length;
        if (bytes <= MAX_HIGHLIGHT_BYTES)
          jobs.push({ key: `${file.path}#${h}`, path: file.path, text });
      });
    }
    return jobs;
  }, [files]);
  useEffect(() => {
    const missing = wanted.filter((job) => !tokens.has(job.key));
    if (!missing.length) return;
    return startHighlight(missing, (key, lines) =>
      setHeld((prev) =>
        prev.scope === scope ? { scope, tokens: new Map(prev.tokens).set(key, lines) } : prev,
      ),
    );
    // Results accumulate; only a change in what is wanted asks for more.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  return tokens;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function Counts({ file }: { file: DiffFile }) {
  if (file.binary) return <span className="text-micro text-ink-faint">binary</span>;
  if (file.omitted) return <span className="text-micro text-ink-faint">not counted</span>;
  return (
    <span className="mk-mono text-micro mk-tabular">
      <span className="text-online">+{file.additions}</span>{" "}
      <span className="text-danger-text">−{file.deletions}</span>
    </span>
  );
}

export function DiffView({
  files,
  truncated,
  blobHref,
  selectedPath,
  onSelectPath,
  idPrefix = "diff",
  label = "Diff",
}: {
  files: DiffFile[];
  /** More files changed than were listed. */
  truncated: boolean;
  /** Where "View file" goes for a path, if anywhere. */
  blobHref?: (path: string) => string;
  /** The chosen file, when the owner keeps it (in the address); otherwise kept here. */
  selectedPath?: string | null;
  onSelectPath?: (path: string) => void;
  /** Distinguishes the ids when more than one diff is on a page. */
  idPrefix?: string;
  label?: string;
}) {
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const selected = selectedPath !== undefined ? selectedPath : ownSelected;
  const [state, setState] = useState(() => ({ files, open: initiallyOpen(files, selected) }));
  let open = state.open;
  // A new diff starts from its own defaults, not the last one's open files.
  if (state.files !== files) {
    open = initiallyOpen(files, selected);
    setState({ files, open });
  }
  const setOpen = (next: Set<string>) => setState({ files, open: next });
  const tokens = useDiffHighlight(
    useMemo(() => files.filter((f) => open.has(f.path)), [files, open]),
    files,
  );

  const summaries = useRef(new Map<string, HTMLElement>());
  const idOf = (index: number) => `${idPrefix}-file-${index}`;

  // Jump to a file: open it, scroll to it, and put focus on its heading row.
  const revealed = useRef<string | null>(null);
  const reveal = (path: string): boolean => {
    const summary = summaries.current.get(path);
    if (!summary) return false;
    revealed.current = path;
    if (!open.has(path)) setOpen(new Set(open).add(path));
    summary.scrollIntoView({ block: "start" });
    summary.focus({ preventScroll: true });
    return true;
  };
  // A file arriving from outside, such as the address, is revealed once.
  useEffect(() => {
    if (selected && revealed.current !== selected) reveal(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, files]);

  const choose = (path: string) => {
    reveal(path);
    setOwnSelected(path);
    onSelectPath?.(path);
  };

  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const allOpen = files.every((f) => open.has(f.path));
  return (
    <section aria-label={label} className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="m-0 min-w-0 flex-1 text-body-sm text-ink-muted">
          {files.length} {files.length === 1 ? "file" : "files"} changed
          {files.length > 0 && (
            <>
              , <span className="text-online mk-tabular">+{additions}</span>{" "}
              <span className="text-danger-text mk-tabular">−{deletions}</span>
            </>
          )}
          {truncated ? " (more not shown)" : ""}
        </p>
        {files.length > 0 && (
          <span className="flex gap-1">
            <button
              type="button"
              className="mk-btn mk-btn--ghost mk-btn--sm"
              disabled={allOpen}
              onClick={() => setOpen(new Set(files.map((f) => f.path)))}
            >
              Expand all
            </button>
            <button
              type="button"
              className="mk-btn mk-btn--ghost mk-btn--sm"
              disabled={open.size === 0}
              onClick={() => setOpen(new Set())}
            >
              Collapse all
            </button>
          </span>
        )}
      </div>
      {/* One file is its own list. */}
      {files.length > 1 && (
        <nav aria-label="Changed files" className="mb-3">
          <ul className="m-0 max-h-64 list-none divide-y divide-line-soft overflow-y-auto rounded-plate bg-sunken p-0">
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => choose(file.path)}
                  aria-current={selected === file.path ? "true" : undefined}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm max-sm:min-h-11 ${selected === file.path ? "bg-signal-wash" : "hover:bg-raised"}`}
                >
                  {STATUS_ICON[file.status]}
                  <span className="mk-mono min-w-0 flex-1 text-mono [overflow-wrap:anywhere]">
                    <span className="text-ink-faint">{dirOf(file.path)}</span>
                    <span className="font-semibold text-ink">{baseOf(file.path)}</span>
                  </span>
                  <span className="shrink-0">
                    <Counts file={file} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {files.map((file, index) => {
        const isOpen = open.has(file.path);
        return (
          <details
            key={file.path}
            id={idOf(index)}
            open={isOpen}
            onToggle={(event) => {
              const now = event.currentTarget.open;
              if (now !== open.has(file.path)) {
                const next = new Set(open);
                if (now) next.add(file.path);
                else next.delete(file.path);
                setOpen(next);
              }
            }}
            className={`mb-2 scroll-mt-2 rounded-md border ${selected === file.path ? "border-signal-line" : "border-line-soft"}`}
          >
            <summary
              ref={(node) => {
                if (node) summaries.current.set(file.path, node);
                else summaries.current.delete(file.path);
              }}
              className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-body-sm max-sm:min-h-11"
            >
              {STATUS_ICON[file.status]}
              <span className="mk-mono min-w-0 flex-1 text-mono [overflow-wrap:anywhere]">
                <span className="text-ink-faint">{dirOf(file.path)}</span>
                <span className="font-semibold">{baseOf(file.path)}</span>
              </span>
              <Counts file={file} />
              {blobHref && (
                <Link
                  className={`${link} text-micro`}
                  to={blobHref(file.path)}
                  aria-label={`View ${file.path}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  View file
                </Link>
              )}
            </summary>
            {isOpen && <FileBody file={file} tokens={tokens} />}
          </details>
        );
      })}
    </section>
  );
}

function FileBody({ file, tokens }: { file: DiffFile; tokens: Map<string, Tokens> }) {
  if (file.binary) return <p className="m-0 px-2 pb-2 text-micro text-ink-faint">Binary file.</p>;
  if (file.omitted)
    return <p className="m-0 px-2 pb-2 text-micro text-ink-faint">Too large to show here.</p>;
  if (file.hunks.length === 0)
    return <p className="m-0 px-2 pb-2 text-micro text-ink-faint">No line changes to show.</p>;
  return (
    // Long lines scroll inside the file, never the page.
    <div className="overflow-x-auto border-t border-line-soft">
      <table
        aria-label={`Changes to ${file.path}`}
        className="mk-mono w-full border-collapse text-micro leading-5"
      >
        {file.hunks.map((hunk, h) => (
          <HunkRows key={h} hunk={hunk} tokens={tokens.get(`${file.path}#${h}`)} />
        ))}
      </table>
    </div>
  );
}

const gutter = "w-10 min-w-10 select-none px-1 text-right align-top text-ink-faint mk-tabular";

function HunkRows({ hunk, tokens }: { hunk: DiffHunk; tokens: Tokens | undefined }) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return (
    <tbody>
      <tr className="bg-sunken text-ink-faint">
        <td colSpan={3} className="px-2 whitespace-pre">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </td>
      </tr>
      {hunk.lines.map((line, n) => {
        const sign = line[0] ?? " ";
        const code = line.slice(1);
        // "\ No newline at end of file" and the like belong to no line number.
        const meta = sign === "\\";
        const added = sign === "+";
        const removed = sign === "-";
        const old = meta || added ? "" : oldLine++;
        const now = meta || removed ? "" : newLine++;
        const lineTokens = tokens?.[n];
        return (
          <tr
            key={n}
            className={added ? "bg-data-teal-wash" : removed ? "bg-danger-wash" : undefined}
          >
            <td className={gutter}>{old}</td>
            <td className={gutter}>{now}</td>
            <td className={`px-2 whitespace-pre ${meta ? "text-ink-faint" : ""}`}>
              {sign}
              {lineTokens && !meta ? <HighlightedSource text={code} tokens={lineTokens} /> : code}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
