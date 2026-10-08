// The commit side panel (CORE-22): Gitmatrix has no commit page; any SHA link
// opens this over the page it's on, and closing it leaves that page as it
// was. `?commit=<sha>` on any repository page opens it, so the address shares
// it. It gathers what the server already knows about one commit: its message,
// author and parents; the files it changed; its CI runs; the packages it
// published; where it's deployed; the issues its message cites; and the
// change, timelines and landing it came through (the push log, via the why
// chain).

import { Dialog } from "@base-ui/react/dialog";
import {
  FileMinusIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderOpenIcon,
  GitCommitIcon,
  GlobeSimpleIcon,
  PackageIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import type { CiRunList, CiRunSummary, CommitsResponse, RepoDetail } from "../../../shared/api.ts";
import type { Deployment, DeploymentList } from "../../../shared/deployments.ts";
import type { CommitDiff, DiffFile } from "../../../shared/diff.ts";
import type { Published } from "../../../shared/packages.ts";
import type { StepAuthor, StepPage } from "../../../shared/steps.ts";
import type { WhyChain, WhyResponse } from "../../../shared/why.ts";
import { CiStatusIcon, runLabel } from "../../components/CiStatus.tsx";
import { DEPLOYMENT_LABEL } from "../../components/Deployments.tsx";
import { fadeMotion, link, Tip } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import {
  COMMIT_PARAM,
  SHA_PATTERN,
  commitPanelUrl,
  panelDepth,
  useCommitHref,
  withCommit,
} from "../../lib/commitPanel.ts";
import { firstLine, fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { packagePath } from "../../lib/packages.ts";
import { useRememberPlace } from "../../lib/recentPlaces.ts";
import { LinkedText } from "../../refs/RefLink.tsx";
import { blobUrl, commitsUrl, repoPath, sourceUrl, treeUrl } from "../../lib/refs.ts";
import {
  confirmIssueKeys,
  issueKeysIn,
  resolveCommit,
  type ConfirmedIssue,
} from "../../lib/resolveRefs.ts";

const slide =
  "transition-[opacity,translate] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] data-[starting-style]:translate-x-6 data-[starting-style]:opacity-0 data-[ending-style]:translate-x-6 data-[ending-style]:opacity-0 motion-reduce:translate-x-0!";

/** One request's state: absent until it's asked. */
type Loaded<T> =
  | { state: "loading" }
  | { state: "done"; value: T }
  | { state: "failed"; error: string; status: number | null };

/** The work source the page is in, if not main's: its commits are read there (CORE-296). */
function workSource(repo: RepoDetail): string | undefined {
  return repo.source?.kind === "timeline-work" ? repo.source.sourceId : undefined;
}

/** GET `path` (null: not yet), cancelled when the path changes or the panel closes. */
function useApi<T>(path: string | null): Loaded<T> {
  const [result, setResult] = useState<{ path: string; loaded: Loaded<T> } | null>(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setResult({ path, loaded: { state: "loading" } });
    api<T>(path, { signal: controller.signal }).then(
      (value) => setResult({ path, loaded: { state: "done", value } }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          path,
          loaded: {
            state: "failed",
            error: error instanceof Error ? error.message : "Request failed.",
            status: error instanceof ApiError ? error.status : null,
          },
        });
      },
    );
    return () => controller.abort();
  }, [path]);
  return result && result.path === path ? result.loaded : { state: "loading" };
}

/** The full id `sha` names in the repository, or why it doesn't. */
function useResolved(repo: RepoDetail, sha: string | null): Loaded<string | null> {
  const [result, setResult] = useState<{ sha: string; loaded: Loaded<string | null> } | null>(null);
  const owner = repo.owner.slug;
  const { name } = repo;
  useEffect(() => {
    if (!sha) return;
    const controller = new AbortController();
    setResult({ sha, loaded: { state: "loading" } });
    resolveCommit(owner, name, sha, controller.signal).then(
      (value) => setResult({ sha, loaded: { state: "done", value } }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          sha,
          loaded: {
            state: "failed",
            error: error instanceof Error ? error.message : "Request failed.",
            status: error instanceof ApiError ? error.status : null,
          },
        });
      },
    );
    return () => controller.abort();
  }, [owner, name, sha]);
  return result && result.sha === sha ? result.loaded : { state: "loading" };
}

/**
 * Mounted once in the repository layout: opens for `?commit=` on any of its
 * pages, and closes back to the page (Back, when a link on it opened the
 * panel; otherwise by dropping the parameter, as for a shared link).
 */
export function CommitPanel({ repo }: { repo: RepoDetail }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const requested = params.get(COMMIT_PARAM)?.trim().toLowerCase() || null;
  // Kept while the panel animates closed, so it doesn't empty as it leaves.
  const last = useRef<string | null>(null);
  if (requested) last.current = requested;
  const sha = requested ?? last.current;
  // Focus starts on the content, not the close button (whose tooltip would take the first Escape).
  const body = useRef<HTMLDivElement>(null);

  const close = () => {
    const depth = panelDepth(location.state);
    if (depth > 0) void navigate(-depth);
    else void navigate(withCommit(location, null), { replace: true, preventScrollReset: true });
  };

  return (
    <Dialog.Root
      open={requested !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={`mk-backdrop ${fadeMotion}`} />
        <Dialog.Popup
          initialFocus={body}
          className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col bg-pane shadow-[var(--shadow-float),0_0_0_1px_var(--line-soft)] outline-none ${slide}`}
        >
          {sha && (
            <CommitBody
              key={sha}
              repo={repo}
              sha={sha}
              active={requested !== null}
              bodyRef={body}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CommitBody({
  repo,
  sha,
  active,
  bodyRef,
}: {
  repo: RepoDetail;
  sha: string;
  active: boolean;
  bodyRef: RefObject<HTMLDivElement | null>;
}) {
  const valid = SHA_PATTERN.test(sha);
  const resolved = useResolved(repo, valid && active ? sha : null);
  const oid = resolved.state === "done" ? resolved.value : null;
  const owner = repo.owner.slug;
  const { name } = repo;
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const ready = oid && active ? oid : null;
  const inSource = (path: string) => sourceUrl(path, workSource(repo));

  const diff = useApi<CommitDiff>(ready && inSource(`${base}/commits/${ready}/diff`));
  // A commit too large to diff still has a message: read it from the log.
  const tooLarge = diff.state === "failed" && diff.status === 413;
  const logged = useApi<CommitsResponse>(
    ready && tooLarge ? inSource(`${base}/commits?ref=${ready}`) : null,
  );
  const runs = useApi<CiRunList>(ready && inSource(`${base}/ci?commit=${ready}`));
  const published = useApi<Published>(
    ready && `/packages/-/published?repo=${encodeURIComponent(`${owner}/${name}`)}&commit=${ready}`,
  );
  const deployments = useApi<DeploymentList>(
    ready && inSource(`${base}/deployments?commit=${ready}&limit=20`),
  );
  const why = useApi<WhyResponse>(ready && inSource(`${base}/why?commit=${ready}`));
  const steps = useApi<StepPage>(ready && `${base}/steps?commits=${ready}&limit=1`);

  const summary =
    diff.state === "done"
      ? {
          message: diff.value.message,
          authorName: diff.value.authorName,
          authoredAt: diff.value.authoredAt,
          parents: diff.value.parents,
        }
      : logged.state === "done" && logged.value.commits[0]?.oid === ready
        ? logged.value.commits[0]
        : null;
  const chain = why.state === "done" ? (why.value.chains[0] ?? null) : null;

  useRememberPlace(
    ready && summary
      ? {
          kind: "commit",
          title: shortOid(ready),
          detail: `${firstLine(summary.message)} · ${owner}/${name}`,
          to: commitPanelUrl(owner, name, ready),
        }
      : null,
  );

  const failure = !valid
    ? `“${sha}” isn't a commit hash.`
    : resolved.state === "failed"
      ? `Couldn't look for ${shortOid(sha)}: ${resolved.error}`
      : resolved.state === "done" && !resolved.value
        ? `No commit starting ${sha} in ${owner}/${name}'s branches, tags or recent history. Try the full hash.`
        : diff.state === "failed" && !tooLarge
          ? diff.status === 404
            ? `No commit ${shortOid(sha)} in ${owner}/${name}.`
            : `Couldn't load commit ${shortOid(sha)}: ${diff.error}`
          : tooLarge && logged.state === "failed"
            ? `Couldn't load commit ${shortOid(sha)}: ${logged.error}`
            : null;

  return (
    <>
      <header className="flex items-start gap-3 border-b border-line-soft py-3 pr-2 pl-5">
        <div className="min-w-0 flex-1">
          <Dialog.Title className="m-0 flex items-center gap-2 text-title">
            <GitCommitIcon weight="bold" className="shrink-0 text-ink-faint" aria-hidden />
            Commit <span className="mk-mono font-normal">{shortOid(oid ?? sha)}</span>
          </Dialog.Title>
          <Dialog.Description className="m-0 mt-0.5 truncate text-body-sm text-ink-muted">
            {summary ? firstLine(summary.message) : `in ${owner}/${name}`}
          </Dialog.Description>
        </div>
        <Tip label="Close (Escape)" side="bottom">
          <Dialog.Close
            className="mk-btn mk-btn--ghost mk-btn--sm size-8 shrink-0 p-0 max-sm:size-11"
            aria-label="Close commit"
          >
            <XIcon size={18} aria-hidden />
          </Dialog.Close>
        </Tip>
      </header>
      <div
        ref={bodyRef}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 outline-none [overflow-wrap:anywhere]"
        aria-busy={!summary && !failure}
      >
        {failure ? (
          <p role="alert" className="m-0 text-body-sm text-danger-text">
            {failure}
          </p>
        ) : !summary || !ready ? (
          <p className="m-0 text-body-sm text-ink-faint">Loading the commit…</p>
        ) : (
          <div className="flex flex-col gap-6">
            <Message repo={repo} oid={ready} summary={summary} steps={steps} chain={chain} />
            <Landing
              repo={repo}
              why={why}
              trackerOwner={why.state === "done" ? why.value.tracker.owner : owner}
            />
            <Issues message={summary.message} owner={owner} repoName={name} />
            <Runs repo={repo} runs={runs} oid={ready} />
            <PublishedPackages published={published} />
            <Deployments repo={repo} deployments={deployments} />
            <Files repo={repo} oid={ready} diff={diff} parent={summary.parents[0] ?? null} />
          </div>
        )}
      </div>
    </>
  );
}

/** A labelled part of the panel. */
function Section({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="m-0 mb-2 text-body-sm font-semibold text-ink">
        {title}
        {count !== undefined && count > 0 && (
          <span className="ml-1.5 font-normal text-ink-faint mk-tabular">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

function Note({ children, tone = "faint" }: { children: ReactNode; tone?: "faint" | "danger" }) {
  return (
    <p className={`m-0 text-body-sm ${tone === "danger" ? "text-danger-text" : "text-ink-faint"}`}>
      {children}
    </p>
  );
}

/** A section's loading and failure lines, or its content. */
function Body<T>({
  loaded,
  what,
  children,
}: {
  loaded: Loaded<T>;
  what: string;
  children: (value: T) => ReactNode;
}) {
  if (loaded.state === "loading") return <Note>Loading {what}…</Note>;
  if (loaded.state === "failed")
    return (
      <Note tone="danger">
        Couldn't load {what}: {loaded.error}
      </Note>
    );
  return <>{children(loaded.value)}</>;
}

/** A person links to their profile; an agent is named as text. */
function Who({ slug, agent }: { slug: string | null; agent?: string | null }) {
  const person = slug ? (
    <Link className={link} to={`/${encodeURIComponent(slug)}`}>
      {slug}
    </Link>
  ) : null;
  if (agent)
    return person ? (
      <>
        {agent} for {person}
      </>
    ) : (
      <>{agent}</>
    );
  return person ?? <>someone</>;
}

function MadeBy({ author }: { author: StepAuthor }) {
  const person = (
    <Link className={link} to={`/${encodeURIComponent(author.accountable.slug)}`}>
      {author.accountable.displayName}
    </Link>
  );
  return author.kind === "agent" ? (
    <>
      {author.name} for {person}
    </>
  ) : (
    person
  );
}

function Message({
  repo,
  oid,
  summary,
  steps,
  chain,
}: {
  repo: RepoDetail;
  oid: string;
  summary: { message: string; authorName: string; authoredAt: number; parents: string[] };
  steps: Loaded<StepPage>;
  chain: WhyChain | null;
}) {
  const commitHref = useCommitHref();
  const owner = repo.owner.slug;
  const { name } = repo;
  const [title = "", ...rest] = summary.message.trimEnd().split("\n");
  const body = rest.join("\n").trim();
  const step = steps.state === "done" ? steps.value.steps[0] : undefined;
  const pushed = chain?.refs[0]?.firstUpdate;
  const row = "grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 max-sm:grid-cols-1";
  return (
    <section aria-label="Message">
      {/* References in the message link to what they name, once resolved (CORE-22). */}
      <p className="m-0 text-title-lg">
        <LinkedText text={title} context={{ owner, repo: name }} />
      </p>
      {body && (
        <p className="m-0 mt-2 max-w-[72ch] text-body-sm whitespace-pre-wrap text-ink-muted">
          <LinkedText text={body} context={{ owner, repo: name }} />
        </p>
      )}
      <dl className="m-0 mt-4 flex flex-col gap-2 text-body-sm">
        <div className={row}>
          <dt className="text-ink-faint">Author</dt>
          <dd className="m-0">
            <bdi>{summary.authorName}</bdi> ·{" "}
            <time
              dateTime={new Date(summary.authoredAt * 1000).toISOString()}
              title={fullDate(summary.authoredAt * 1000)}
            >
              {timeAgo(summary.authoredAt * 1000)}
            </time>
          </dd>
        </div>
        {step && (
          <div className={row}>
            <dt className="text-ink-faint">Made by</dt>
            <dd className="m-0">
              <MadeBy author={step.author} />
              {!step.verified && <span className="text-ink-faint"> · not verified by a push</span>}
            </dd>
          </div>
        )}
        {pushed && (pushed.actor || pushed.agent) && (
          <div className={row}>
            <dt className="text-ink-faint">Pushed by</dt>
            <dd className="m-0">
              <Who slug={pushed.actor} agent={pushed.agent} />{" "}
              <time className="text-ink-faint" title={fullDate(pushed.createdAt)}>
                {timeAgo(pushed.createdAt)}
              </time>
            </dd>
          </div>
        )}
        <div className={row}>
          <dt className="text-ink-faint">{summary.parents.length === 1 ? "Parent" : "Parents"}</dt>
          <dd className="m-0 flex flex-wrap gap-2">
            {summary.parents.length === 0 ? (
              <span className="text-ink-faint">None: the first commit</span>
            ) : (
              summary.parents.map((parent) => {
                const href = commitHref(owner, name, parent);
                return (
                  <Link
                    key={parent}
                    to={href.to}
                    state={href.state}
                    preventScrollReset
                    className="mk-chip mk-chip--tag mk-mono h-6 no-underline"
                    aria-label={`Open parent commit ${shortOid(parent)}`}
                  >
                    {shortOid(parent)}
                  </Link>
                );
              })
            )}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-ink-faint">Commit</dt>
          <dd className="m-0 mk-mono text-mono text-ink-muted">{oid}</dd>
        </div>
      </dl>
      <p className="m-0 mt-4 flex flex-wrap gap-2">
        <Link className="mk-btn mk-btn--sm" to={treeUrl(owner, name, oid, "", workSource(repo))}>
          <FolderOpenIcon weight="bold" aria-hidden />
          Browse files at this commit
        </Link>
        <Link
          className="mk-btn mk-btn--ghost mk-btn--sm"
          to={commitsUrl(owner, name, oid, "", workSource(repo))}
        >
          History from here
        </Link>
      </p>
    </section>
  );
}

function Landing({
  repo,
  why,
  trackerOwner,
}: {
  repo: RepoDetail;
  why: Loaded<WhyResponse>;
  trackerOwner: string;
}) {
  const timelineUrl = (slug: string) =>
    `/tracker/${encodeURIComponent(trackerOwner)}/timelines?tl=${encodeURIComponent(slug)}`;
  const refName = (ref: string) => ref.replace(/^refs\/(heads|tags)\//, "");
  return (
    <Section id="commit-landing" title="How it landed">
      <Body loaded={why} what="its history">
        {(result) => {
          const chain = result.chains[0];
          if (!chain) return <Note>Nothing recorded.</Note>;
          return (
            <dl className="m-0 flex flex-col gap-2 text-body-sm">
              <div>
                <dt className="sr-only">Landing</dt>
                <dd className="m-0">
                  {chain.landing ? (
                    <>
                      {chain.landing.via === "queue" ? "Landed on " : "Reached "}
                      <code className="mk-mono">{refName(chain.landing.ref)}</code>
                      {chain.landing.timeline && (
                        <>
                          {" with "}
                          <Link className={link} to={timelineUrl(chain.landing.timeline)}>
                            {chain.landing.timeline}
                          </Link>
                        </>
                      )}{" "}
                      <time className="text-ink-faint" title={fullDate(chain.landing.at)}>
                        {timeAgo(chain.landing.at)}
                      </time>
                      {chain.landing.queue && (
                        <span className="text-ink-faint">
                          {" · checkpoint #"}
                          {chain.landing.queue.checkpointNumber}
                          {chain.landing.queue.mergeRun && (
                            <>
                              {" · merge run "}
                              <Link
                                className={link}
                                to={repoPath(
                                  repo.owner.slug,
                                  repo.name,
                                  "ci",
                                  String(chain.landing.queue.mergeRun.number),
                                )}
                              >
                                #{chain.landing.queue.mergeRun.number}
                              </Link>
                            </>
                          )}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-muted">Not on {result.repo.defaultBranch} yet.</span>
                  )}
                </dd>
              </div>
              {chain.timelines.length > 0 && (
                <div>
                  <dt className="text-ink-faint">
                    {chain.timelines.length === 1 ? "Timeline" : "Timelines"}
                  </dt>
                  <dd className="m-0 mt-1 flex flex-col gap-1">
                    {chain.timelines.map((timeline) => (
                      <span key={timeline.id} className="flex flex-wrap items-center gap-2">
                        <Link className={link} to={timelineUrl(timeline.slug)}>
                          {timeline.name}
                        </Link>
                        <span className="mk-mono text-ink-faint">timeline/{timeline.slug}</span>
                        <span className="mk-chip mk-chip--tag">
                          {timeline.status.replaceAll("_", " ")}
                        </span>
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-ink-faint">Change</dt>
                <dd className="m-0 mt-1">
                  {chain.changeId ? (
                    <>
                      <code className="mk-mono" title={chain.changeId}>
                        {chain.changeId.slice(0, 12)}
                      </code>
                      {chain.refs.some((r) => r.rewritten) && (
                        <span className="text-ink-faint">
                          {" "}
                          · rewritten since it was first pushed
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-faint">
                      No change id: not made with gm, or never reached the push log.
                    </span>
                  )}
                </dd>
              </div>
              {chain.refs.length > 0 && (
                <div>
                  <dt className="text-ink-faint">Reached</dt>
                  <dd className="m-0 mt-1">
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-ink-muted">
                      {chain.refs.map((ref) => (
                        <li key={ref.ref}>
                          <code className="mk-mono text-ink">{refName(ref.ref)}</code>{" "}
                          <time title={fullDate(ref.firstSeenAt)}>{timeAgo(ref.firstSeenAt)}</time>
                          {(ref.firstUpdate.actor || ref.firstUpdate.agent) && (
                            <>
                              {" · pushed by "}
                              <Who slug={ref.firstUpdate.actor} agent={ref.firstUpdate.agent} />
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
              {!result.tracker.readable && (
                <Note>
                  You can't read {result.tracker.owner}'s tracker, so its timelines and approvals
                  aren't shown.
                </Note>
              )}
            </dl>
          );
        }}
      </Body>
    </Section>
  );
}

/** Issue keys the message cites: links only where they resolve to an issue the viewer can open. */
function Issues({
  message,
  owner,
  repoName,
}: {
  message: string;
  owner: string;
  repoName: string;
}) {
  const keys = issueKeysIn(message);
  const keyList = keys.join(",");
  const [confirmed, setConfirmed] = useState<Map<string, ConfirmedIssue> | null>(null);
  useEffect(() => {
    if (!keyList) return;
    const controller = new AbortController();
    setConfirmed(null);
    confirmIssueKeys(keyList.split(","), { owner, name: repoName }, controller.signal).then(
      (found) => !controller.signal.aborted && setConfirmed(found),
      () => !controller.signal.aborted && setConfirmed(new Map()),
    );
    return () => controller.abort();
  }, [keyList, owner, repoName]);

  return (
    <Section id="commit-issues" title="Issues it mentions" count={keys.length}>
      {keys.length === 0 ? (
        <Note>The message cites no issue keys.</Note>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-body-sm">
          {keys.map((key) => {
            const issue = confirmed?.get(key);
            return (
              <li key={key} className="flex flex-wrap items-baseline gap-x-2">
                {issue ? (
                  <>
                    <Link className={`${link} mk-mono`} to={issue.to}>
                      {key}
                    </Link>
                    <span className="text-ink">{issue.title}</span>
                  </>
                ) : (
                  <>
                    <span className="mk-mono text-ink-muted">{key}</span>
                    <span className="text-ink-faint">
                      {confirmed ? "not an issue you can open here" : "checking…"}
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Runs({ repo, runs, oid }: { repo: RepoDetail; runs: Loaded<CiRunList>; oid: string }) {
  const listed: CiRunSummary[] =
    runs.state === "done" ? runs.value.runs.filter((run) => run.commit === oid) : [];
  return (
    <Section id="commit-ci" title="CI" count={listed.length}>
      <Body loaded={runs} what="CI runs">
        {() =>
          listed.length === 0 ? (
            <Note>No CI runs for this commit.</Note>
          ) : (
            <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-plate bg-sunken p-0">
              {listed.map((run) => (
                <li key={run.id}>
                  <Link
                    to={repoPath(repo.owner.slug, repo.name, "ci", String(run.number))}
                    className="flex min-h-10 items-center gap-2 px-3 py-2 text-body-sm text-ink no-underline hover:bg-raised max-sm:min-h-11"
                  >
                    <CiStatusIcon status={run.status} />
                    <span className="mk-mono text-mono text-ink-muted">#{run.number}</span>
                    <span className="min-w-0 flex-1 truncate">{run.title}</span>
                    <span className="shrink-0 text-micro text-ink-faint">
                      {runLabel(run)} · {timeAgo(run.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </Body>
    </Section>
  );
}

function PublishedPackages({ published }: { published: Loaded<Published> }) {
  const rows = published.state === "done" ? published.value.rows : [];
  return (
    <Section id="commit-packages" title="Packages published" count={rows.length}>
      <Body loaded={published} what="packages">
        {() =>
          rows.length === 0 ? (
            <Note>Nothing was published from this commit.</Note>
          ) : (
            <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-plate bg-sunken p-0">
              {rows.map((row) => (
                <li key={row.id}>
                  <Link
                    to={`${packagePath(row.feed, row.format, row.package)}?version=${encodeURIComponent(row.version)}`}
                    className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-body-sm text-ink no-underline hover:bg-raised max-sm:min-h-11"
                  >
                    <PackageIcon weight="bold" className="shrink-0 text-ink-faint" aria-hidden />
                    <span className="font-semibold">{row.package}</span>
                    <span className="mk-mono text-mono">{row.version}</span>
                    <span className="mk-chip mk-chip--tag">{row.format}</span>
                    {row.status !== "active" && (
                      <span className="mk-chip mk-chip--tag">{row.status}</span>
                    )}
                    {row.runNumber !== null && (
                      <span className="ml-auto text-micro text-ink-faint">
                        run #{row.runNumber}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </Body>
    </Section>
  );
}

function Deployments({
  repo,
  deployments,
}: {
  repo: RepoDetail;
  deployments: Loaded<DeploymentList>;
}) {
  const rows: Deployment[] = deployments.state === "done" ? deployments.value.deployments : [];
  return (
    <Section id="commit-deployments" title="Deployments and previews" count={rows.length}>
      <Body loaded={deployments} what="deployments">
        {() =>
          rows.length === 0 ? (
            <Note>Not deployed anywhere Gitmatrix knows of.</Note>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-body-sm">
              {rows.map((deployment) => {
                const up =
                  deployment.url &&
                  (deployment.status === "active" || deployment.status === "sleeping");
                return (
                  <li key={deployment.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <GlobeSimpleIcon
                      weight="bold"
                      className={`shrink-0 ${deployment.status === "active" ? "text-online" : deployment.status === "failed" ? "text-danger-text" : "text-ink-faint"}`}
                      aria-hidden
                    />
                    <span className="font-semibold">{deployment.environment}</span>
                    <span className="mk-chip mk-chip--tag">
                      {DEPLOYMENT_LABEL[deployment.status]}
                    </span>
                    {up ? (
                      <a
                        className={`${link} mk-mono text-mono`}
                        href={deployment.url!}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {deployment.url!.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                      </a>
                    ) : null}
                    {deployment.run !== null && (
                      <Link
                        className={`${link} text-micro`}
                        to={repoPath(repo.owner.slug, repo.name, "ci", String(deployment.run))}
                      >
                        run #{deployment.run}
                      </Link>
                    )}
                    <time
                      className="text-micro text-ink-faint"
                      title={fullDate(deployment.createdAt)}
                    >
                      {timeAgo(deployment.createdAt)}
                    </time>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Body>
    </Section>
  );
}

const FILE_ICON: Record<DiffFile["status"], ReactNode> = {
  added: <FilePlusIcon weight="bold" className="shrink-0 text-online" aria-label="Added" />,
  deleted: (
    <FileMinusIcon weight="bold" className="shrink-0 text-danger-text" aria-label="Deleted" />
  ),
  modified: (
    <FileTextIcon weight="bold" className="shrink-0 text-ink-faint" aria-label="Modified" />
  ),
};

function Files({
  repo,
  oid,
  diff,
  parent,
}: {
  repo: RepoDetail;
  oid: string;
  diff: Loaded<CommitDiff>;
  parent: string | null;
}) {
  const files = diff.state === "done" ? diff.value.files : [];
  const owner = repo.owner.slug;
  const { name } = repo;
  return (
    <Section id="commit-files" title="Files changed" count={files.length}>
      {diff.state === "failed" && diff.status === 413 ? (
        <Note>This commit changes too much to list here; browse its files instead.</Note>
      ) : (
        <Body loaded={diff} what="the changed files">
          {(value) =>
            files.length === 0 ? (
              <Note>No files changed.</Note>
            ) : (
              <>
                <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-plate bg-sunken p-0">
                  {files.map((file) => {
                    // A deleted file lives on at the parent.
                    const at = file.status === "deleted" ? parent : oid;
                    return (
                      <li
                        key={file.path}
                        className="flex min-h-10 items-center gap-2 px-3 py-2 text-body-sm max-sm:min-h-11"
                      >
                        {FILE_ICON[file.status]}
                        {at ? (
                          <Link
                            className="min-w-0 flex-1 truncate mk-mono text-mono text-ink no-underline hover:underline"
                            to={blobUrl(owner, name, at, file.path, workSource(repo))}
                            title={
                              file.status === "deleted"
                                ? `${file.path} before this commit`
                                : `${file.path} at this commit`
                            }
                          >
                            {file.path}
                          </Link>
                        ) : (
                          <span className="min-w-0 flex-1 truncate mk-mono text-mono">
                            {file.path}
                          </span>
                        )}
                        <span className="shrink-0 mk-mono text-mono mk-tabular">
                          {file.binary ? (
                            <span className="text-ink-faint">binary</span>
                          ) : file.omitted ? (
                            <span className="text-ink-faint">not counted</span>
                          ) : (
                            <>
                              <span className="text-online">+{file.additions}</span>{" "}
                              <span className="text-danger-text">−{file.deletions}</span>
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {value.truncated && (
                  <p className="m-0 mt-2 text-body-sm text-ink-faint">
                    More files changed than are listed; browse the tree for the rest.
                  </p>
                )}
              </>
            )
          }
        </Body>
      )}
    </Section>
  );
}
