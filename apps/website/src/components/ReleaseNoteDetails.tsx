import { Dialog } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { timelineLabel, type ReleaseNoteEntry } from "../../shared/release-notes.ts";
import { commitsUrl } from "../lib/refs.ts";
import { LinkedText } from "../refs/RefLink.tsx";
import { CommitLink } from "./CommitLink.tsx";
import { link, Tip } from "./ui.tsx";

export type ReleaseNoteDetailsSelection = {
  entry: ReleaseNoteEntry;
  repo: { owner: string; name: string } | null;
  trigger: HTMLButtonElement;
};

export const RELEASE_NOTE_DETAILS_ID = "release-note-details";

export function ReleaseNoteDetails({
  selection,
  onClose,
}: {
  selection: ReleaseNoteDetailsSelection | null;
  onClose: () => void;
}) {
  const location = useLocation();
  const [phone, setPhone] = useState(() => window.matchMedia("(max-width: 639px)").matches);
  const opener = useRef<{ trigger: HTMLButtonElement; pathname: string; search: string } | null>(
    null,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const change = () => setPhone(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useLayoutEffect(() => {
    if (selection) {
      opener.current = {
        trigger: selection.trigger,
        pathname: location.pathname,
        search: location.search,
      };
    }
  }, [selection, location.pathname, location.search]);

  const entry = selection?.entry;
  const repo = selection?.repo;
  return (
    <Dialog.Root
      open={selection !== null}
      modal={phone}
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup
          id={RELEASE_NOTE_DETAILS_ID}
          finalFocus={() => {
            const source = opener.current;
            return source?.trigger.isConnected &&
              source.pathname === location.pathname &&
              source.search === location.search
              ? source.trigger
              : false;
          }}
          className="fixed inset-y-0 right-0 z-40 flex h-dvh w-full min-w-0 flex-col bg-pane text-ink shadow-[var(--shadow-float),0_0_0_1px_var(--line-soft)] sm:w-[26rem]"
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-line-soft py-3 pr-2 pl-4">
            <Dialog.Title className="m-0 min-w-0 flex-1 text-title">
              Release note details
            </Dialog.Title>
            <Tip label="Close details (Escape)" side="bottom">
              <Dialog.Close
                className="mk-btn mk-btn--ghost mk-btn--sm size-8 shrink-0 p-0 max-sm:size-11"
                aria-label="Close release note details"
              >
                <XIcon size={18} aria-hidden />
              </Dialog.Close>
            </Tip>
          </header>
          {entry && (
            <div
              key={entry.id}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 [overflow-wrap:anywhere]"
            >
              <h3 className="mt-0 mb-6 text-title">
                <LinkedText text={entry.title} />
              </h3>
              <section className="mb-6">
                <h4 className="mt-0 mb-2 text-body-sm font-semibold">Last commit</h4>
                <time dateTime={entry.lastCommitAt} className="text-body-sm text-ink-muted">
                  {new Date(entry.lastCommitAt).toUTCString()}
                </time>
              </section>
              <section className="mb-6">
                <h4 className="mt-0 mb-2 text-body-sm font-semibold">Linked issue</h4>
                {entry.issue ? (
                  <Link
                    className={`${link} mk-mono text-body-sm`}
                    to={`/tracker/${encodeURIComponent(entry.issue.trackerOwner)}/issues/${encodeURIComponent(entry.issue.id)}`}
                  >
                    {entry.issue.key}
                  </Link>
                ) : (
                  <p className="m-0 text-body-sm text-ink-muted">No linked issue</p>
                )}
              </section>
              <section className="mb-6">
                <h4 className="mt-0 mb-2 text-body-sm font-semibold">
                  Commits ({entry.commits.length})
                </h4>
                {entry.commits.length === 0 ? (
                  <p className="m-0 text-body-sm text-ink-muted">No linked commits</p>
                ) : (
                  <>
                    {!repo && (
                      <p className="mt-0 mb-2 text-body-sm text-ink-muted">
                        Repository unavailable; commit links cannot be opened.
                      </p>
                    )}
                    <ul className="m-0 list-none space-y-2 p-0">
                      {entry.commits.map((oid) => (
                        <li key={oid} className="mk-mono text-body-sm">
                          {repo ? (
                            <CommitLink
                              className={link}
                              owner={repo.owner}
                              name={repo.name}
                              sha={oid}
                              // Phones show one dialog at a time: the commit replaces these details.
                              onClick={phone ? onClose : undefined}
                            >
                              {oid}
                            </CommitLink>
                          ) : (
                            <span className="text-ink-muted">{oid}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
              {entry.timeline && (
                <section>
                  <h4 className="mt-0 mb-2 text-body-sm font-semibold">Landed with</h4>
                  {repo ? (
                    <CommitLink
                      className={`${link} mk-mono text-body-sm`}
                      owner={repo.owner}
                      name={repo.name}
                      sha={entry.timeline.landing}
                      onClick={phone ? onClose : undefined}
                    >
                      {timelineLabel(entry.timeline)}
                    </CommitLink>
                  ) : (
                    <span className="mk-mono text-body-sm text-ink-muted">
                      {timelineLabel(entry.timeline)}
                    </span>
                  )}
                </section>
              )}
              {entry.provenance?.map((provenance) => (
                <section key={provenance.receiptId} className="mt-4">
                  <h4 className="mt-0 mb-2 text-body-sm font-semibold">Source receipt</h4>
                  <p className="m-0 text-body-sm break-all text-ink-muted">
                    <code className="mk-mono">{provenance.receiptId}</code>
                  </p>
                  {repo && (
                    <Link
                      className={`${link} text-body-sm`}
                      to={commitsUrl(
                        repo.owner,
                        repo.name,
                        provenance.source.commit,
                        "",
                        provenance.source.sourceId,
                      )}
                    >
                      Approved progress history ({provenance.commits.length} commits)
                    </Link>
                  )}
                </section>
              ))}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
