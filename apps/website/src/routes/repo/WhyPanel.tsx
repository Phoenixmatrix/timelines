// "Why did this change?" from the code view (CORE-85): for the selected lines,
// the commit blame names, its change, the timelines it came through, its
// issues, checkpoints, approval and landing, each linking where it lives.

import { Dialog } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { RepoDetail } from "../../../shared/api.ts";
import type { WhyChain, WhyResponse } from "../../../shared/why.ts";
import { CommitLink } from "../../components/CommitLink.tsx";
import { link } from "../../components/ui.tsx";
import { PersonLink } from "../../components/PersonLink.tsx";
import { api } from "../../lib/api.ts";
import { firstLine, fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { blobUrl, commitsUrl, sourceUrl, treeUrl } from "../../lib/refs.ts";

const fade =
  "transition-opacity duration-200 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0";
const slide =
  "transition-[opacity,translate] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] data-[starting-style]:translate-x-6 data-[starting-style]:opacity-0 data-[ending-style]:translate-x-6 data-[ending-style]:opacity-0 motion-reduce:translate-x-0!";

/** The request a selection makes: lines of a file at the commit the page shows. */
export function whyPath(
  owner: string,
  name: string,
  path: string,
  rev: string,
  start: number,
  end: number,
  sourceId?: string,
) {
  const line = start === end ? `${start}` : `${start}-${end}`;
  return sourceUrl(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/why?path=${encodeURIComponent(path)}&line=${line}&rev=${encodeURIComponent(rev)}`,
    sourceId,
  );
}

/** "line 3", "lines 3–5", "lines 3, 7 and 9". */
export function linesLabel(lines: number[]): string {
  if (!lines.length) return "";
  const sorted = [...lines].sort((a, b) => a - b);
  const contiguous = sorted.every((line, i) => i === 0 || line === sorted[i - 1]! + 1);
  if (sorted.length === 1) return `line ${sorted[0]}`;
  if (contiguous) return `lines ${sorted[0]}–${sorted.at(-1)}`;
  const shown = sorted.slice(0, 6);
  const rest = sorted.length - shown.length;
  return rest > 0
    ? `lines ${shown.join(", ")} and ${rest} more`
    : `lines ${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

export function WhyPanel({
  repo,
  path,
  rev,
  start,
  end,
  open,
  onOpenChange,
}: {
  repo: RepoDetail;
  path: string;
  /** The commit the page shows, so blame matches the lines on screen. */
  rev: string;
  start: number;
  end: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const request = whyPath(repo.owner.slug, repo.name, path, rev, start, end, repo.source?.sourceId);
  const [state, setState] = useState<{
    request: string;
    result?: WhyResponse;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ request });
    api<WhyResponse>(request).then(
      (result) => live && setState({ request, result }),
      (error: Error) => live && setState({ request, error: error.message }),
    );
    return () => {
      live = false;
    };
  }, [open, request]);
  const current = state?.request === request ? state : null;
  const label = start === end ? `line ${start}` : `lines ${start}–${end}`;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={`mk-backdrop ${fade}`} />
        <Dialog.Popup
          className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col bg-pane shadow-xl outline-none ${slide}`}
        >
          <header className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="mk-dialog-title">Why {label}?</Dialog.Title>
              <Dialog.Description className="m-0 mt-1 text-body-sm break-all text-ink-muted">
                {path} at {shortOid(rev)}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="mk-btn mk-btn--ghost mk-btn--sm max-sm:h-11"
              aria-label="Close"
            >
              <XIcon aria-hidden />
            </Dialog.Close>
          </header>
          <div className="flex-1 overflow-y-auto px-5 py-4" aria-busy={!current?.result}>
            {!current || (!current.result && !current.error) ? (
              <p className="m-0 text-body-sm text-ink-faint">Following the history…</p>
            ) : current.error ? (
              <p className="m-0 text-body-sm text-danger-text">
                Couldn't follow the history: {current.error}
              </p>
            ) : (
              <WhyResult result={current.result!} path={path} onLeave={() => onOpenChange(false)} />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WhyResult({
  result,
  path,
  onLeave,
}: {
  result: WhyResponse;
  path: string;
  /** Closes this panel as a link opens the commit panel in its place. */
  onLeave: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      {!result.tracker.readable && (
        <p className="m-0 rounded-plate bg-sunken px-3 py-2 text-body-sm text-ink-muted">
          You can't read {result.tracker.owner}'s tracker, so its timelines, checkpoints and
          approvals aren't shown.
        </p>
      )}
      {result.blame?.truncated && (
        <p className="m-0 text-body-sm text-ink-faint">
          History was too long to follow to the end; the oldest commits shown may be later than the
          ones that wrote these lines.
        </p>
      )}
      {result.chains.map((chain) => (
        <Chain key={chain.oid} chain={chain} result={result} path={path} onLeave={onLeave} />
      ))}
    </div>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="relative border-l-2 border-line-soft pb-4 pl-4 last:pb-0">
      <span
        aria-hidden
        className="absolute top-1.5 -left-[5px] size-2 rounded-full bg-signal-line"
      />
      <h4 className="m-0 text-micro font-semibold tracking-wide text-ink-faint uppercase">
        {title}
      </h4>
      <div className="mt-1 flex flex-col gap-1 text-body-sm">{children}</div>
    </li>
  );
}

/**
 * The step behind the commit (CORE-243): who recorded it, its why and
 * challenges, what steered it, its tests, and the way into the story.
 */
function StepContext({
  chain,
  tracker,
  repo,
  onLeave,
}: {
  chain: WhyChain;
  tracker: string;
  repo: string;
  onLeave: () => void;
}) {
  const step = chain.step;
  if (!step) return <span className="text-ink-faint">No context was recorded for this step.</span>;
  if (step.deleted)
    return <span className="text-ink-faint">An admin removed this step&rsquo;s context.</span>;
  const { context } = step;
  const first = (text: string) =>
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  const failed = context.tests.filter((t) => t.exit !== 0).length;
  const by =
    step.author.kind === "agent"
      ? `${step.author.name} for ${step.author.accountable.displayName}`
      : step.author.name;
  const story = step.timeline
    ? `/tracker/${encodeURIComponent(tracker)}/timelines/${encodeURIComponent(step.timeline)}/story?${new URLSearchParams({ step: chain.oid, repo })}`
    : null;
  return (
    <>
      <span className="text-ink-muted">
        By {by}
        {step.commitOid !== chain.oid && (
          <>
            {", recorded on "}
            <code className="mk-mono">{shortOid(step.commitOid)}</code>
            {" before a rebase"}
          </>
        )}
      </span>
      {context.why.trim() && (
        <span>
          <span className="text-ink-faint">Why: </span>
          {first(context.why)}
        </span>
      )}
      {context.challenges.trim() && (
        <span>
          <span className="text-ink-faint">Challenges: </span>
          {first(context.challenges)}
        </span>
      )}
      {(context.instructions.length > 0 || context.steering.length > 0) && (
        <span className="text-ink-muted">
          {context.instructions.length}{" "}
          {context.instructions.length === 1 ? "instruction" : "instructions"},{" "}
          {context.steering.length} steering ({context.coverage.steering})
        </span>
      )}
      {context.tests.length > 0 && (
        <span className={failed ? "text-danger-text" : "text-online"}>
          {failed
            ? `${failed} of ${context.tests.length} tests failed`
            : `${context.tests.length} tests passed`}
        </span>
      )}
      {story && (
        <Link className={link} to={story} onClick={onLeave}>
          Open in the timeline&rsquo;s story
        </Link>
      )}
    </>
  );
}

function Chain({
  chain,
  result,
  path,
  onLeave,
}: {
  chain: WhyChain;
  result: WhyResponse;
  path: string;
  onLeave: () => void;
}) {
  const { owner, name, defaultBranch } = result.repo;
  const tracker = result.tracker.owner;
  const timelineUrl = (slug: string) =>
    `/tracker/${encodeURIComponent(tracker)}/timelines?tl=${encodeURIComponent(slug)}`;
  const who = (id: string | null) => {
    if (!id) return "someone";
    const named = result.people[id];
    if (!named) return id;
    // People link to their profile; agents stay text.
    return named.kind === "person" ? (
      <PersonLink slug={named.slug} prose>
        {named.name}
      </PersonLink>
    ) : (
      named.name
    );
  };
  const refName = (ref: string) => ref.replace(/^refs\/(heads|tags)\//, "");
  const commit = chain.commit;

  return (
    <section aria-label={`Commit ${shortOid(chain.oid)}`}>
      <ol className="m-0 list-none p-0">
        <Step title={chain.lines.length ? `Commit · ${linesLabel(chain.lines)}` : "Commit"}>
          {commit ? (
            <>
              <span className="font-semibold text-ink">{firstLine(commit.message)}</span>
              <span className="text-ink-muted">
                {commit.authorName} ·{" "}
                <time title={fullDate(commit.authoredAt * 1000)}>
                  {timeAgo(commit.authoredAt * 1000)}
                </time>{" "}
                ·{" "}
                <CommitLink
                  className={`${link} mk-mono`}
                  owner={owner}
                  name={name}
                  sha={commit.oid}
                  onClick={onLeave}
                  title={`Open commit ${shortOid(commit.oid)}`}
                >
                  {shortOid(commit.oid)}
                </CommitLink>
              </span>
              <span className="flex flex-wrap gap-x-3">
                <Link
                  className={link}
                  to={blobUrl(
                    owner,
                    name,
                    commit.oid,
                    path,
                    chain.source?.sourceId ?? result.source?.sourceId,
                  )}
                >
                  File at this commit
                </Link>
                <Link
                  className={link}
                  to={commitsUrl(
                    owner,
                    name,
                    commit.oid,
                    "",
                    chain.source?.sourceId ?? result.source?.sourceId,
                  )}
                >
                  History from here
                </Link>
              </span>
            </>
          ) : (
            <span className="text-ink-muted">
              <code className="mk-mono">{shortOid(chain.oid)}</code> isn't on the server.
            </span>
          )}
        </Step>

        <Step title="Change">
          {chain.changeId ? (
            <span>
              <code className="mk-mono">{chain.changeId.slice(0, 12)}</code>
              {chain.refs.some((r) => r.rewritten) && (
                <span className="text-ink-muted"> · rewritten since it was first pushed</span>
              )}
            </span>
          ) : (
            <span className="text-ink-muted">
              No change id: this commit wasn't made with gm, or never reached the push log.
            </span>
          )}
          {chain.refs.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-ink-muted">
              {chain.refs.map((ref) => (
                <li key={ref.ref}>
                  {ref.afterLanding ? "Carried into " : "Reached "}
                  <code className="mk-mono text-ink">{refName(ref.ref)}</code>{" "}
                  <time title={fullDate(ref.firstSeenAt)}>{timeAgo(ref.firstSeenAt)}</time>
                  {ref.firstUpdate.actor && (
                    <>
                      {" "}
                      · pushed by {ref.firstUpdate.agent ?? ref.firstUpdate.actor}
                      {ref.firstUpdate.agent && ` for ${ref.firstUpdate.actor}`}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Step>

        {chain.timelines.length > 0 && (
          <Step title={chain.timelines.length === 1 ? "Timeline" : "Timelines"}>
            {chain.timelines.map((timeline) => (
              <span key={timeline.id} className="flex flex-wrap items-center gap-2">
                <Link className={link} to={timelineUrl(timeline.slug)}>
                  {timeline.name}
                </Link>
                <span className="mk-chip mk-chip--tag">{timeline.status.replace("_", " ")}</span>
                {timeline.experimental && (
                  <span className="mk-chip mk-chip--tag">experimental</span>
                )}
              </span>
            ))}
            {chain.merges
              .filter((merge) => merge.into !== null)
              .map((merge) => (
                <span key={merge.commit} className="text-ink-muted">
                  Merged from {merge.from ?? defaultBranch} into {merge.into}{" "}
                  <time title={fullDate(merge.at)}>{timeAgo(merge.at)}</time>
                </span>
              ))}
          </Step>
        )}

        {chain.issues.length > 0 && (
          <Step title={chain.issues.length === 1 ? "Issue" : "Issues"}>
            {chain.issues.map((issue) => (
              <span key={issue.key} className="flex flex-wrap items-baseline gap-x-2">
                <Link
                  className={link}
                  to={`/tracker/${encodeURIComponent(issue.trackerOwner)}/issues/${encodeURIComponent(issue.id)}`}
                >
                  {issue.key}
                </Link>
                <span className="text-ink">{issue.title}</span>
                <span className="text-ink-faint">
                  {issue.status.replaceAll("_", " ")}
                  {issue.source === "timeline" && " · worked on in the timeline"}
                </span>
              </span>
            ))}
          </Step>
        )}

        {chain.checkpoints.length > 0 && (
          <Step title={chain.checkpoints.length === 1 ? "Checkpoint" : "Checkpoints"}>
            {chain.checkpoints.map((checkpoint) => (
              <span key={checkpoint.id} className="flex flex-col">
                <span className="flex flex-wrap items-center gap-2">
                  <Link className={link} to={timelineUrl(checkpoint.timeline)}>
                    #{checkpoint.number} of {checkpoint.timeline}
                  </Link>
                  {checkpoint.approval && (
                    <span className="mk-chip mk-chip--tag">{checkpoint.approval.state}</span>
                  )}
                  {checkpoint.commit !== chain.oid && (
                    <span
                      className="text-ink-faint"
                      title="The checkpoint pinned an earlier commit of the same change"
                    >
                      as <code className="mk-mono">{shortOid(checkpoint.commit)}</code>
                    </span>
                  )}
                </span>
                {checkpoint.summary && (
                  <span className="text-ink-muted">{firstLine(checkpoint.summary)}</span>
                )}
              </span>
            ))}
          </Step>
        )}

        {chain.approval && (
          <Step title="Approval">
            <span>
              {chain.approval.state === "pending"
                ? "Waiting for approval"
                : `${chain.approval.state[0]!.toUpperCase()}${chain.approval.state.slice(1)}`}
              {chain.approval.by &&
                (chain.approval.via === "auto-approve" ? (
                  <> automatically by {who(chain.approval.by)}&rsquo;s approve-when-green setting</>
                ) : (
                  <> by {who(chain.approval.by)}</>
                ))}
              {chain.approval.at && (
                <>
                  {" "}
                  <time title={fullDate(chain.approval.at)}>{timeAgo(chain.approval.at)}</time>
                </>
              )}{" "}
              <span className="text-ink-muted">
                (checkpoint #{chain.approval.number} of {chain.approval.timeline})
              </span>
            </span>
            {chain.approval.note && <span className="text-ink-muted">“{chain.approval.note}”</span>}
          </Step>
        )}

        <Step title="Landing">
          {chain.landing ? (
            <span>
              {chain.landing.via === "compact"
                ? "Integrated as a compact result on "
                : chain.landing.via === "queue"
                  ? "Landed by historical merge on "
                  : "Reached "}
              <code className="mk-mono">{refName(chain.landing.ref)}</code>
              {chain.landing.timeline && (
                <>
                  {" with "}
                  <Link className={link} to={timelineUrl(chain.landing.timeline)}>
                    {chain.landing.timeline}
                  </Link>
                </>
              )}{" "}
              <time title={fullDate(chain.landing.at)}>{timeAgo(chain.landing.at)}</time>
              {chain.landing.queue && (
                <span className="text-ink-muted">
                  {" · landing "}
                  <code className="mk-mono">{chain.landing.queue.id}</code>
                  {" · checkpoint #"}
                  {chain.landing.queue.checkpointNumber}
                  {" ("}
                  {chain.landing.queue.checkpointId}
                  {")"}
                  {" · requested by "}
                  {who(
                    chain.landing.queue.requestedBy.agentId ??
                      chain.landing.queue.requestedBy.actorId,
                  )}
                  {" for "}
                  {who(chain.landing.queue.requestedBy.accountableId)}
                  {chain.landing.queue.mergeRun &&
                    ` · merge run #${chain.landing.queue.mergeRun.number} (${chain.landing.queue.mergeRun.id})`}
                  {chain.landing.queue.gateRun
                    ? ` · gates #${chain.landing.queue.gateRun.number} (${chain.landing.queue.gateRun.id})`
                    : " · no gates run"}
                </span>
              )}
            </span>
          ) : (
            <span className="text-ink-muted">Not on {defaultBranch} yet.</span>
          )}
        </Step>
        {chain.lineage && (
          <Step title="Source receipt">
            {chain.lineage.integration ? (
              <>
                <Link
                  className={link}
                  to={treeUrl(
                    owner,
                    name,
                    chain.lineage.integration.canonical.commit,
                    "",
                    "canonical",
                  )}
                >
                  Canonical result {shortOid(chain.lineage.integration.canonical.commit)}
                </Link>
                <Link
                  className={link}
                  to={commitsUrl(
                    owner,
                    name,
                    chain.lineage.integration.source.commit,
                    "",
                    chain.lineage.integration.source.sourceId,
                  )}
                >
                  Approved progress history
                </Link>
                <span className="text-ink-muted">
                  Exact source membership; progress commits are not canonical ancestors.
                </span>
              </>
            ) : (
              <span className="text-ink-muted">
                {chain.lineage.status === "expired"
                  ? "Source expired; progress objects are no longer retained."
                  : chain.lineage.status === "ambiguous"
                    ? "Multiple integration receipts; no unique mapping."
                    : chain.lineage.status === "pending"
                      ? "This source has not completed integration."
                      : "No admitted source membership recorded."}
              </span>
            )}
          </Step>
        )}

        {(chain.step || chain.timelines.length > 0) && (
          <Step title="Step context">
            <StepContext
              chain={chain}
              tracker={tracker}
              repo={`${owner}/${name}`}
              onLeave={onLeave}
            />
          </Step>
        )}

        <Step title="Discussion">
          <span className="text-ink-faint">{chain.discussions.reason}</span>
        </Step>
      </ol>
    </section>
  );
}
