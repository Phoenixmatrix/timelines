import {
  CopyIcon,
  DownloadSimpleIcon,
  FileDocIcon,
  FileMdIcon,
  MagicWandIcon,
  PrinterIcon,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { downloadBlob, exportFileName, printHtml, wordDocument } from "../lib/releaseExport.ts";
import { useViewer } from "../lib/session.ts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FormError, link, useToast } from "./ui.tsx";

/** Where the notes are written from. The server reads them again, as this viewer may. */
export type ComposeTarget =
  | { kind: "repo"; space: string; name: string; release: string; timeline: string | null }
  | { kind: "tracker"; space: string; q: string; timeline: string | null };

interface Composed {
  markdown: string;
  model: string;
  entries: number;
  truncated: boolean;
  /** What it was written from, as it read when it was asked for. */
  from: string;
}

const STARTERS = [
  {
    label: "Client-ready announcement",
    prompt:
      "A client-ready announcement of what is new and improved, written for customers in a warm, confident tone. Lead with the most important changes and leave out internal housekeeping.",
  },
  {
    label: "Changelog by category",
    prompt:
      "A changelog grouped by category (New, Improved, Fixed), one concise line per change, in plain language.",
  },
  {
    label: "Short email to customers",
    prompt:
      "A short email to customers, under 150 words, with a subject line and the two or three changes they will care about most.",
  },
  {
    label: "Internal summary for the team",
    prompt:
      "An internal summary for the team: what shipped, grouped by area, including notable fixes and anything routine, in a direct tone.",
  },
];

const PROMPT_LIMIT = 2000;

/**
 * The result as plain Markdown: no autolinked issue keys or commit refs, no
 * images (they would load from wherever the model pointed). What is shown is
 * what Copy, Print and Word carry.
 */
function Result({ text }: { text: string }) {
  return (
    <div className="gm-prose" dir="auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: () => null,
          a: ({ href, children }) => (
            <a className={link} href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describe(target: ComposeTarget, label: string): string {
  return target.kind === "repo"
    ? `the selected release, ${label}`
    : target.q.trim()
      ? `the notes matching the filter “${target.q.trim()}”`
      : "the notes in the current feed";
}

/**
 * Write release notes in the words a person asks for (CORE-151), from the
 * notes already on the page: collapsed until wanted, one model call per
 * request, nothing saved. The result renders as Markdown and leaves as
 * Markdown, Word or a PDF (through the print dialog).
 */
export function ReleaseNotesComposer({
  target,
  label,
  aiOff = false,
}: {
  target: ComposeTarget;
  /** What the notes are called on the page ("2026-10-08"), for the line saying what they're written from. */
  label: string;
  /** Known up front that AI release notes are off here. */
  aiOff?: boolean;
}) {
  const viewer = useViewer();
  const toast = useToast();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [composed, setComposed] = useState<Composed | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  // Set again on mount too: StrictMode runs the cleanup once before the page is live.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (open) promptRef.current?.focus();
  }, [open]);

  const from = describe(target, label);
  const base = target.kind === "repo" ? target.name : target.space;
  const text = prompt.trim();

  const generate = async () => {
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path =
        target.kind === "repo"
          ? `/repos/${encodeURIComponent(target.space)}/${encodeURIComponent(target.name)}/release-notes/compose`
          : `/tracker/${encodeURIComponent(target.space)}/release-notes/compose`;
      const body =
        target.kind === "repo"
          ? { prompt: text, release: target.release, timeline: target.timeline ?? undefined }
          : { prompt: text, q: target.q, timeline: target.timeline ?? undefined };
      const result = await api<Omit<Composed, "from">>(path, { method: "POST", json: body });
      if (mounted.current) setComposed({ ...result, from });
    } catch (caught) {
      if (!mounted.current) return;
      setError(
        caught instanceof ApiError
          ? { status: caught.status, message: caught.message }
          : { status: 0, message: "Couldn't reach the server. Try again." },
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  /** One export at a time, each reporting its own failure. */
  const exportAs = async (what: string, run: () => Promise<void> | void) => {
    setExporting(what);
    try {
      await run();
    } catch (caught) {
      console.error(`Release notes: ${what} failed`, caught);
      toast.add({ title: `Couldn't ${what.toLowerCase()}`, type: "error" });
    } finally {
      if (mounted.current) setExporting(null);
    }
  };
  const rendered = () => resultRef.current?.querySelector<HTMLElement>(".gm-prose") ?? null;

  const copy = () =>
    exportAs("Copy", async () => {
      const markdown = composed!.markdown;
      const html = rendered()?.innerHTML;
      if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": new Blob([markdown], { type: "text/plain" }),
              "text/html": new Blob([html], { type: "text/html" }),
            }),
          ]);
          toast.add({ title: "Release notes copied" });
          return;
        } catch {
          // A browser that refuses rich clipboard data still takes plain text.
        }
      }
      await navigator.clipboard.writeText(markdown);
      toast.add({ title: "Release notes copied" });
    });

  const result = <div ref={resultRef}>{composed && <Result text={composed.markdown} />}</div>;

  return (
    <section aria-label="Custom release notes" className="mb-6 min-w-0">
      <button
        type="button"
        className="mk-btn mk-btn--sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <MagicWandIcon weight="bold" aria-hidden />
        Write custom release notes
      </button>
      {open && (
        <div id={id} className="mt-3 flex min-w-0 flex-col gap-4 rounded-pane bg-pane p-4">
          {!viewer ? (
            <p className="m-0 text-body-sm text-ink-muted">
              Sign in to write custom release notes from these notes.
            </p>
          ) : aiOff ? (
            <p className="m-0 text-body-sm text-ink-muted">
              AI writing is off here, so custom release notes can&apos;t be written. A Space admin
              can turn on AI release notes in the Space&apos;s AI settings.
            </p>
          ) : (
            <>
              <div className="mk-field">
                <label htmlFor={`${id}-prompt`} className="mk-label">
                  What should these release notes be?
                </label>
                <textarea
                  id={`${id}-prompt`}
                  ref={promptRef}
                  className="mk-input"
                  rows={4}
                  maxLength={PROMPT_LIMIT}
                  value={prompt}
                  aria-describedby={`${id}-scope`}
                  placeholder="For example: an announcement for our customers, friendly, with a one-line summary on top."
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </div>
              <div role="group" aria-label="Starting points" className="flex flex-wrap gap-2">
                {STARTERS.map((starter) => (
                  <button
                    key={starter.label}
                    type="button"
                    className="mk-chip"
                    onClick={() => {
                      setPrompt(starter.prompt);
                      promptRef.current?.focus();
                    }}
                  >
                    {starter.label}
                  </button>
                ))}
              </div>
              <p id={`${id}-scope`} className="mk-hint m-0">
                Writes from {from}, as you can see it. The result isn&apos;t saved: copy or download
                it.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="mk-btn mk-btn--primary"
                  aria-busy={busy}
                  disabled={busy || !text}
                  onClick={() => void generate()}
                >
                  {busy ? "Writing…" : composed ? "Write again" : "Write release notes"}
                </button>
                {busy && (
                  <span role="status" className="text-body-sm text-ink-muted">
                    Writing from {from}. This takes a few seconds.
                  </span>
                )}
              </div>
              {error && (
                <FormError
                  message={
                    error.status === 409
                      ? `${error.message} A Space admin can turn it on in the Space's AI settings.`
                      : error.message
                  }
                />
              )}
            </>
          )}
          {composed && (
            <div className="flex min-w-0 flex-col gap-3 border-t border-line-soft pt-4">
              <div
                role="toolbar"
                aria-label="Export release notes"
                className="flex flex-wrap items-center gap-2"
              >
                <button
                  type="button"
                  className="mk-btn mk-btn--sm"
                  disabled={exporting !== null}
                  onClick={() => void copy()}
                >
                  <CopyIcon weight="bold" aria-hidden />
                  Copy
                </button>
                <button
                  type="button"
                  className="mk-btn mk-btn--sm"
                  disabled={exporting !== null}
                  onClick={() =>
                    void exportAs("Download Markdown", () =>
                      downloadBlob(
                        new Blob([composed.markdown], { type: "text/markdown;charset=utf-8" }),
                        exportFileName(base, "md"),
                      ),
                    )
                  }
                >
                  <FileMdIcon weight="bold" aria-hidden />
                  Download Markdown
                </button>
                <button
                  type="button"
                  className="mk-btn mk-btn--sm"
                  disabled={exporting !== null}
                  onClick={() =>
                    void exportAs("Download Word", async () => {
                      const root = rendered();
                      if (!root) throw new Error("Nothing rendered to export.");
                      downloadBlob(
                        await wordDocument(root, `${base} release notes`),
                        exportFileName(base, "docx"),
                      );
                    })
                  }
                >
                  <FileDocIcon weight="bold" aria-hidden />
                  {exporting === "Download Word" ? "Building Word file…" : "Download Word"}
                </button>
                <button
                  type="button"
                  className="mk-btn mk-btn--sm"
                  disabled={exporting !== null}
                  onClick={() =>
                    void exportAs("Print", async () => {
                      const html = rendered()?.innerHTML;
                      if (!html) throw new Error("Nothing rendered to print.");
                      await printHtml(html, `${base} release notes`);
                    })
                  }
                >
                  <PrinterIcon weight="bold" aria-hidden />
                  Print / Save as PDF
                </button>
              </div>
              <p className="m-0 flex items-center gap-1.5 text-micro text-ink-faint">
                <DownloadSimpleIcon aria-hidden />
                Written from {composed.from} by {composed.model.replace("@cf/", "")}
                {composed.entries ? ` (${plural(composed.entries, "note")})` : ""}.
                {composed.truncated &&
                  " Only the newest notes fit; narrow the filter or release to cover the rest."}{" "}
                Check it before you publish it.
              </p>
              <div className="min-w-0 break-words rounded-pane bg-raised p-4">{result}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
