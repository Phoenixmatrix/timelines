// What a step's CI runs showed of the app (CORE-383): screenshots the browser
// tests took and diagrams a job drew, compared with the earlier steps' so a
// reviewer sees what a commit changed on screen.

import { Dialog } from "@base-ui/react/dialog";
import { useState } from "react";
import type { Step, StepArtifact } from "../../../shared/steps.ts";
import { Mermaid } from "../../components/Mermaid.tsx";
import { dialogMotion, fadeMotion, link } from "../../components/ui.tsx";

type Screenshot = Extract<StepArtifact, { kind: "screenshot" }>;
type Document = Extract<StepArtifact, { kind: "document" }>;

/** A step's newest screenshots and documents, one per name (artifacts are newest first). */
export function visualsOf(step: Step | null): { screenshots: Screenshot[]; documents: Document[] } {
  const screenshots = new Map<string, Screenshot>();
  const documents = new Map<string, Document>();
  for (const artifact of step?.artifacts ?? []) {
    if (artifact.kind === "screenshot" && !screenshots.has(artifact.data.name))
      screenshots.set(artifact.data.name, artifact);
    else if (artifact.kind === "document" && !documents.has(artifact.data.name))
      documents.set(artifact.data.name, artifact);
  }
  return { screenshots: [...screenshots.values()], documents: [...documents.values()] };
}

/**
 * Whether a screenshot is new, byte-identical to the nearest earlier step's of
 * that name, or different from it. Different is only "compare": fixture ids and
 * times vary between runs, so equal hashes prove nothing changed but unequal
 * ones don't prove something did.
 */
export function compareWith(
  shot: Screenshot,
  earlier: Step[],
): { change: "new" | "unchanged" | "compare"; before: Screenshot | null } {
  for (const step of earlier) {
    const before = visualsOf(step).screenshots.find((s) => s.data.name === shot.data.name);
    if (before)
      return {
        change: before.data.sha256 === shot.data.sha256 ? "unchanged" : "compare",
        before,
      };
  }
  return { change: "new", before: null };
}

const CHANGE_LABEL = { new: "New", unchanged: "Unchanged", compare: "Compare" } as const;

/** The step's screenshots and diagrams; nothing at all when it has none. `earlier` is older steps, nearest first. */
export function StepVisuals({ step, earlier }: { step: Step | null; earlier: Step[] }) {
  const { screenshots, documents } = visualsOf(step);
  if (screenshots.length === 0 && documents.length === 0) return null;
  return (
    <section aria-label="Visuals" className="mt-4 min-w-0">
      <h3 className="mt-0 mb-2 text-body-sm font-semibold text-ink-muted">Visuals</h3>
      {screenshots.length > 0 && (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-3 p-0">
          {screenshots.map((shot) => (
            <li key={shot.data.name} className="min-w-0">
              <Thumbnail shot={shot} {...compareWith(shot, earlier)} />
            </li>
          ))}
        </ul>
      )}
      {documents.map((doc) => (
        <figure key={doc.data.name} className="m-0 mt-3 min-w-0">
          <figcaption className="mb-1 text-body-sm font-semibold [overflow-wrap:anywhere]">
            {doc.data.name}
          </figcaption>
          <Mermaid code={doc.data.source} />
        </figure>
      ))}
    </section>
  );
}

function Thumbnail({
  shot,
  change,
  before,
}: {
  shot: Screenshot;
  change: "new" | "unchanged" | "compare";
  before: Screenshot | null;
}) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"before" | "after">("after");
  const shown = side === "before" && before ? before : shot;
  const { name } = shot.data;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSide("after");
      }}
    >
      <Dialog.Trigger
        className="block w-full cursor-zoom-in overflow-hidden rounded-control bg-sunken p-0 text-left"
        aria-label={`Enlarge ${name}`}
      >
        <img
          src={shot.url}
          alt={name}
          loading="lazy"
          className="block aspect-[16/10] w-full object-cover object-top"
        />
      </Dialog.Trigger>
      <p className="mt-1 mb-0 flex flex-wrap items-center gap-x-2 text-micro text-ink-muted">
        <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
        <span className="mk-chip mk-chip--tag">{CHANGE_LABEL[change]}</span>
      </p>
      <Dialog.Portal>
        <Dialog.Backdrop className={`mk-backdrop ${fadeMotion}`} />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Popup
            className={`mk-dialog ${dialogMotion} max-h-[calc(100dvh-2rem)] overflow-auto`}
            style={{ width: "min(72rem, calc(100vw - 2rem))" }}
          >
            <Dialog.Title className="mk-dialog-title [overflow-wrap:anywhere]">{name}</Dialog.Title>
            <Dialog.Description className="mk-dialog-desc">
              {change === "compare"
                ? "Differs from the earlier step's picture; it may be only times or ids."
                : `${CHANGE_LABEL[change]}.`}
            </Dialog.Description>
            {change === "compare" && (
              <div className="mt-3 flex gap-2" role="group" aria-label="Before and after">
                {(["before", "after"] as const).map((which) => (
                  <button
                    key={which}
                    type="button"
                    className="mk-btn mk-btn--ghost mk-btn--sm"
                    aria-pressed={side === which}
                    onClick={() => setSide(which)}
                  >
                    {which === "before" ? "Before" : "After"}
                  </button>
                ))}
              </div>
            )}
            <img
              src={shown.url}
              alt={`${name} (${side === "before" && before ? "before" : "after"})`}
              className="mt-3 block h-auto w-full rounded-control"
            />
            <div className="mk-dialog-actions">
              <a className={link} href={shown.url} target="_blank" rel="noreferrer">
                Open full size
              </a>
              <Dialog.Close className="mk-btn mk-btn--ghost">Close</Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
