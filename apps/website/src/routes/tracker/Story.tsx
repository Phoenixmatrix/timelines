// A timeline's story (CORE-234): its steps in order, each commit with the
// context its agent attached (CORE-226), and the commit's diff beside it.

import { CaretLeftIcon, CaretRightIcon, GitMergeIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  redirect,
  data as routeData,
  useLoaderData,
  useParams,
  type LoaderFunctionArgs,
} from "react-router";
import { useLiveSearchParams } from "../../lib/searchParams.ts";
import type { CommitSummary, HistoryPage } from "../../../shared/api.ts";
import type { CommitDiff } from "../../../shared/diff.ts";
import type { Step, StepPage, StepVersions } from "../../../shared/steps.ts";
import type {
  CheckpointList,
  CheckpointView,
  TimelineDetail,
  TimelineRepo,
} from "../../../shared/timelines.ts";
import { DiffView } from "../../components/DiffView.tsx";
import { SelectField, link } from "../../components/ui.tsx";
import { Actor } from "./Actor.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { commitPanelUrl } from "../../lib/commitPanel.ts";
import { useMediaQuery } from "../../lib/useMediaQuery.ts";
import { firstLine, fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { blobUrl, sourceUrl } from "../../lib/refs.ts";
import { readTrackerShortcuts } from "./preferences.ts";
import { StepVisuals } from "./StepVisuals.tsx";
import { TimelineNav, timelinePageUrl } from "./TimelineNav.tsx";
import { givenAt } from "./timelineSpans.ts";

/** The filters' "no filter" value. */
const ALL = "*";

/** How far back a story reads: first-parent commits per repository. */
const MAX_COMMITS = 300;

/** The width at which the list and the step sit side by side (Tailwind's `lg`). */
const WIDE = "(min-width: 64rem)";

export async function storyLoader({ request, params }: LoaderFunctionArgs) {
  try {
    return await api<TimelineDetail>(
      `/tracker/${encodeURIComponent(params.space!)}/timelines/${encodeURIComponent(params.slug!)}?limit=200`,
      { signal: request.signal },
    );
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        const url = new URL(request.url);
        throw redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
      }
      throw routeData({ message: error.message }, { status: error.status });
    }
    throw error;
  }
}

/** One commit on the timeline's line, with its step context when it has one. */
interface StoryRow {
  commit: CommitSummary;
  step: Step | null;
  merge: boolean;
}

/** Owned sources retain their work ref after landing; abandon pins its last
 * commit. Historical canonical merge events pin the contributing parent's tip. */
function headOf(detail: TimelineDetail, repo: TimelineRepo): string {
  for (const event of [...detail.events].reverse()) {
    if (event.kind === "abandon" && event.lastCommits?.[repo.id])
      return event.lastCommits[repo.id]!;
    if (
      repo.source?.kind !== "timeline-work" &&
      event.kind === "merge" &&
      event.fromId === detail.timeline.id &&
      event.repoId === repo.id
    )
      return event.parent;
  }
  return repo.source?.ref.replace(/^refs\/heads\//, "") ?? repo.bookmark;
}

function useStory(detail: TimelineDetail, repo: TimelineRepo | undefined) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    /** What the rows were read for; other renders wait for theirs. */
    key: string;
    rows: StoryRow[];
    error: string | null;
    loading: boolean;
    more: boolean;
  }>({ key: "", rows: [], error: null, loading: true, more: false });
  // Primitives, not the loader's objects: the route reloads the timeline on
  // every ?step= change, and the whole history must not be read again for it.
  const space = repo?.space;
  const name = repo?.name;
  const sourceId = repo?.source?.sourceId;
  const head = repo ? headOf(detail, repo) : null;
  const fork = repo ? detail.timeline.forkPoint.commits[repo.id] : undefined;
  const key = `${space}/${name}@${head}`;
  useEffect(() => {
    if (!space || !name) return;
    const abort = new AbortController();
    const base = `/repos/${encodeURIComponent(space)}/${encodeURIComponent(name)}`;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      const commits: CommitSummary[] = [];
      let at: string | null = head;
      let cursor: string | null = null;
      let more = false;
      while (at) {
        const query = new URLSearchParams({ at });
        if (cursor) query.set("cursor", cursor);
        const page: HistoryPage = await api<HistoryPage>(
          sourceUrl(`${base}/history?${query}`, sourceId),
          { signal: abort.signal },
        );
        let reachedFork = false;
        for (const commit of page.commits) {
          if (commit.oid === fork) {
            reachedFork = true;
            break;
          }
          if (!commits.some((c) => c.oid === commit.oid)) commits.push(commit);
        }
        if (reachedFork || !page.next) break;
        if (commits.length >= MAX_COMMITS) {
          more = true;
          break;
        }
        at = page.head ?? at;
        cursor = page.next;
      }
      const steps = new Map<string, Step>();
      for (let i = 0; i < commits.length; i += 100) {
        const oids = commits.slice(i, i + 100).map((c) => c.oid);
        const page = await api<StepPage>(`${base}/steps?commits=${oids.join(",")}&limit=100`, {
          signal: abort.signal,
        });
        for (const step of page.steps)
          if (!steps.has(step.commitOid)) steps.set(step.commitOid, step);
      }
      setState({
        key,
        rows: commits.map((commit) => ({
          commit,
          step: steps.get(commit.oid) ?? null,
          merge: commit.parents.length > 1,
        })),
        error: null,
        loading: false,
        more,
      });
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      setState({
        key,
        rows: [],
        error: error instanceof Error ? error.message : "Couldn't read this timeline's steps.",
        loading: false,
        more: false,
      });
    });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sourceId, fork, attempt]);
  const current = state.key === key;
  return {
    rows: current ? state.rows : [],
    error: current ? state.error : null,
    loading: state.loading || !current,
    more: current && state.more,
    retry: () => setAttempt((n) => n + 1),
  };
}

/**
 * The timeline's checkpoints (CORE-382), for the dividers in the list. They
 * are context, not content: a failed read leaves the list without dividers.
 */
function useCheckpoints(space: string, slug: string): CheckpointView[] {
  const [views, setViews] = useState<CheckpointView[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    api<CheckpointList>(
      `/tracker/${encodeURIComponent(space)}/timelines/${encodeURIComponent(slug)}/checkpoints`,
      { signal: abort.signal },
    )
      .then((list) => setViews(list.checkpoints))
      .catch(() => {});
    return () => abort.abort();
  }, [space, slug]);
  return views;
}

/** Whether an element, or an ancestor inside the page, scrolls sideways (a code block). */
function inSidewaysScroller(element: Element): boolean {
  for (
    let node: Element | null = element;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const { overflowX } = getComputedStyle(node);
    if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth)
      return true;
  }
  return false;
}

/** Where a checkpoint stands, in a few words. */
function approvalLabel(view: CheckpointView): string | null {
  if (view.approved)
    return view.approval?.via === "auto-approve" ? "Approved automatically" : "Approved";
  switch (view.approval?.state) {
    case "pending":
      return "Awaiting approval";
    case "rejected":
      return "Rejected";
    case "approved":
      return "Approved earlier";
    case "superseded":
      return "Superseded";
    default:
      return null;
  }
}

const agentOf = (row: StoryRow) =>
  row.step ? row.step.author.name : row.commit.authorName || "Unknown";

export function Story() {
  const detail = useLoaderData() as TimelineDetail;
  const { timeline } = detail;
  const [params, setParams] = useLiveSearchParams();
  const shortcuts = readTrackerShortcuts();
  const wide = useMediaQuery(WIDE);
  // The timeline belongs to the tracker in the address, not to its repositories' space.
  const space = useParams().space ?? "";
  const repo =
    timeline.repos.find((r) => `${r.space}/${r.name}` === params.get("repo")) ?? timeline.repos[0];
  const repoKey = repo ? `${repo.space}/${repo.name}` : "";
  const { rows, error, loading, more, retry } = useStory(detail, repo);
  const checkpoints = useCheckpoints(space, timeline.slug);
  const agent = params.get("agent") ?? "";
  const issue = params.get("issue") ?? "";
  const shown = useMemo(
    () =>
      rows.filter(
        (row) => (!agent || agentOf(row) === agent) && (!issue || row.step?.issue === issue),
      ),
    [rows, agent, issue],
  );
  const agents = useMemo(
    () => [...new Set(rows.map(agentOf))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );
  const issues = useMemo(
    () =>
      [...new Set(rows.flatMap((r) => (r.step?.issue ? [r.step.issue] : [])))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [rows],
  );
  // How many steps each repository has, as far as it has been read.
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!loading && !error && repoKey) setCounts((c) => ({ ...c, [repoKey]: rows.length }));
  }, [loading, error, repoKey, rows.length]);
  // Checkpoint dividers sit before the step whose commit the checkpoint holds
  // in this repository; a checkpoint beyond the steps read has none.
  const dividers = useMemo(() => {
    const byCommit = new Map<string, CheckpointView[]>();
    for (const view of checkpoints) {
      const commit = view.checkpoint.repos.find((r) => `${r.space}/${r.name}` === repoKey)?.commit;
      if (commit) byCommit.set(commit, [...(byCommit.get(commit) ?? []), view]);
    }
    return byCommit;
  }, [checkpoints, repoKey]);
  // The steps in runs, each headed by the checkpoints made at its first step.
  const groups = useMemo(() => {
    const out: { views: CheckpointView[]; rows: StoryRow[] }[] = [];
    for (const row of shown) {
      const views = dividers.get(row.commit.oid) ?? [];
      if (views.length || out.length === 0) out.push({ views, rows: [] });
      out[out.length - 1]!.rows.push(row);
    }
    return out;
  }, [shown, dividers]);
  const selected = params.get("step");
  const index = shown.findIndex((row) => row.commit.oid === selected);
  const current = index >= 0 ? shown[index]! : null;

  const set = (changes: Record<string, string | null>): void => {
    // Buttons, row clicks and keys share the same pending selection. React
    // may not have rendered the URL yet when the next input arrives.
    if ("step" in changes) position.current.heading = changes.step;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes))
          if (value) next.set(key, value);
          else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };
  // A chosen file goes along to a step that changes it too; the step's diff
  // drops it once it knows it isn't there (CORE-382).
  const open = (row: StoryRow | undefined) => row && set({ step: row.commit.oid });
  // Back to the list, with focus on the row the step was opened from.
  const restore = useRef<string | null>(null);
  const close = () => {
    restore.current = new URLSearchParams(window.location.search).get("step");
    set({ step: null, file: null });
  };
  useEffect(() => {
    if (selected || !restore.current) return;
    const row = [...document.querySelectorAll<HTMLElement>("[data-step]")].find(
      (el) => el.dataset.step === restore.current,
    );
    restore.current = null;
    row?.focus();
  });

  // On a screen wide enough for the split, the newest step opens at once so
  // the code is in view; once per repository, so Escape can still close it.
  // A step already chosen (a link's ?step=) counts as that once (CORE-382).
  const autoSelected = useRef<string | null>(null);
  useEffect(() => {
    if (!wide || loading || error || autoSelected.current === repoKey) return;
    autoSelected.current = repoKey;
    if (!selected && shown[0]) set({ step: shown[0].commit.oid });
  });

  // Keep the requested step across intermediate renders until the URL shows
  // it. Undefined means settled; null is an explicitly requested close.
  const position = useRef({
    shown,
    open,
    set,
    close,
    heading: undefined as string | null | undefined,
  });
  position.current = {
    shown,
    open,
    set,
    close,
    heading:
      position.current.heading !== undefined &&
      position.current.heading === new URLSearchParams(window.location.search).get("step")
        ? undefined
        : position.current.heading,
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=combobox], [role=listbox], [role=menu]",
        )
      )
        return;
      const characters = readTrackerShortcuts();
      // Up and Down scroll the page unless character navigation is on, and
      // Left and Right scroll a code block that scrolls sideways.
      if ((event.key === "j" || event.key === "k") && !characters) return;
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !characters) return;
      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        target &&
        inSidewaysScroller(target)
      )
        return;
      const { shown, open, close, heading } = position.current;
      const at =
        heading === undefined ? new URLSearchParams(window.location.search).get("step") : heading;
      const index = shown.findIndex((row) => row.commit.oid === at);
      // Newer and Older follow the visible newest-first list, up/down respectively.
      if (event.key === "k" || event.key === "ArrowLeft" || event.key === "ArrowUp")
        open(shown[index < 0 ? 0 : index - 1]);
      else if (event.key === "j" || event.key === "ArrowRight" || event.key === "ArrowDown")
        open(shown[index < 0 ? 0 : index + 1]);
      else if (event.key === "Escape" && at) close();
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const changesUrl = (query?: Record<string, string>) =>
    timelinePageUrl(space, timeline.slug, "changes", { repo: repoKey, ...query });
  const forked = !more && !agent && !issue && shown.length > 0;
  return (
    <main className="mx-auto max-w-[110rem] px-4 py-4">
      <h1 className="m-0 text-title-lg [overflow-wrap:anywhere]">{timeline.name}</h1>
      <TimelineNav
        space={space}
        slug={timeline.slug}
        current="story"
        query={{ repo: params.get("repo") }}
      />
      <p className="mt-1 mb-3 text-body-sm text-ink-muted">
        Every step on <span className="mk-mono">timeline/{timeline.slug}</span>, with the context
        its agent recorded.
      </p>
      <div className="mb-3 flex flex-wrap items-end gap-3" role="group" aria-label="Filters">
        {timeline.repos.length > 1 && (
          <SelectField
            ariaLabel="Repository"
            className="w-64"
            value={repoKey}
            options={timeline.repos.map((r) => {
              const key = `${r.space}/${r.name}`;
              const n = counts[key];
              return {
                value: key,
                label: n === undefined ? key : `${key} (${n} ${n === 1 ? "step" : "steps"})`,
              };
            })}
            onChange={(value) => set({ repo: value, step: null, file: null })}
          />
        )}
        <SelectField
          ariaLabel="Agent"
          className="w-48"
          value={agent || ALL}
          options={[
            { value: ALL, label: "Every agent" },
            ...agents.map((a) => ({ value: a, label: a })),
          ]}
          onChange={(value) => set({ agent: value === ALL ? null : value })}
        />
        <SelectField
          ariaLabel="Issue"
          className="w-40"
          value={issue || ALL}
          options={[
            { value: ALL, label: "Any issue" },
            ...issues.map((i) => ({ value: i, label: i })),
          ]}
          onChange={(value) => set({ issue: value === ALL ? null : value })}
        />
      </div>
      {timeline.repos.length > 1 && (
        <p className="mt-0 mb-3 text-body-sm text-ink-muted">
          Showing <span className="mk-mono">{repoKey}</span> · {timeline.repos.length - 1} more{" "}
          {timeline.repos.length === 2 ? "repository" : "repositories"}
        </p>
      )}
      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="mk-error m-0">{error}</p>
          <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={retry}>
            Retry
          </button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <section
            aria-label="Steps"
            className={`rounded-pane bg-pane p-2 ${current ? "max-lg:hidden" : ""}`}
          >
            {loading ? (
              <p className="m-2 text-body-sm text-ink-faint">Reading the timeline…</p>
            ) : shown.length === 0 ? (
              <p className="m-2 text-body-sm text-ink-faint">
                {rows.length ? "No steps match these filters." : "No commits on this timeline yet."}
              </p>
            ) : (
              groups.map((group, at) => (
                <div key={group.views[0]?.checkpoint.id ?? `top-${at}`} className="mt-2 first:mt-0">
                  {group.views.map((view) => (
                    <CheckpointHeading
                      key={view.checkpoint.id}
                      view={view}
                      href={changesUrl({ checkpoint: String(view.checkpoint.number) })}
                    />
                  ))}
                  <ol className="m-0 list-none p-0">
                    {group.rows.map((row) => (
                      <StepRow
                        key={row.commit.oid}
                        row={row}
                        active={row.commit.oid === selected}
                        onOpen={() => open(row)}
                      />
                    ))}
                  </ol>
                </div>
              ))
            )}
            {more && (
              <p className="m-2 text-micro text-ink-faint">
                Earlier steps not loaded: showing the newest {MAX_COMMITS} commits.
              </p>
            )}
            {forked && (
              <p className="m-2 text-micro text-ink-faint">
                This is where the timeline forked from main.
              </p>
            )}
          </section>
          {current && repo ? (
            <StepDetail
              key={current.commit.oid}
              repo={repo}
              row={current}
              earlier={rows
                .slice(rows.findIndex((r) => r.commit.oid === current.commit.oid) + 1)
                .flatMap((r) => (r.step ? [r.step] : []))}
              shortcuts={shortcuts}
              wide={wide}
              file={params.get("file")}
              onFile={(path) => set({ file: path })}
              changesUrl={changesUrl()}
              oldest={index + 1 >= shown.length && !agent && !issue}
              truncated={more}
              onNewer={index > 0 ? () => open(shown[index - 1]) : null}
              onOlder={index + 1 < shown.length ? () => open(shown[index + 1]) : null}
              onClose={close}
            />
          ) : (
            <p className="m-0 self-start rounded-pane bg-pane p-4 text-body-sm text-ink-faint max-lg:hidden">
              Open a step to see its context and diff. Left goes to the next newer visible step;
              Right goes to the next older one.
              {shortcuts && (
                <>
                  {" "}
                  <kbd>k</kbd> is newer (also Up); <kbd>j</kbd> is older (also Down).
                </>
              )}
            </p>
          )}
        </div>
      )}
    </main>
  );
}

/**
 * Where a checkpoint was made, among the steps (CORE-382). It heads the steps
 * the checkpoint holds, down to the previous checkpoint. A heading above its
 * own list, not a step: keys skip it and it is not an option in the list.
 */
function CheckpointHeading({ view, href }: { view: CheckpointView; href: string }) {
  const approval = approvalLabel(view);
  return (
    <h2 className="m-0 flex flex-wrap items-baseline gap-x-2 border-b border-line-soft px-2 pb-1 text-micro font-semibold text-ink-muted">
      <Link className={link} to={href} title={`What checkpoint #${view.checkpoint.number} added`}>
        Checkpoint #{view.checkpoint.number}
      </Link>
      {approval && <span className="mk-chip mk-chip--tag">{approval}</span>}
    </h2>
  );
}

/** Coverage like "hook:claude-code": a harness hook captured it. */
const byHook = (coverage: string) => coverage === "hook" || coverage.startsWith("hook:");

function testSummary(step: Step | null): { label: string; ok: boolean } | null {
  const tests = step?.context.tests ?? [];
  if (!tests.length) return null;
  const failed = tests.filter((t) => t.exit !== 0).length;
  return failed
    ? { label: `${failed} of ${tests.length} failed`, ok: false }
    : { label: `${tests.length} passed`, ok: true };
}

function coverageLabel(step: Step | null): { label: string; title?: string } {
  if (!step) return { label: "No context" };
  if (step.deleted) return { label: "Context removed" };
  const { instructions, steering } = step.context.coverage;
  return byHook(instructions) && byHook(steering)
    ? { label: "Full context" }
    : {
        label: "Some context missing",
        title:
          "A harness hook didn't capture this step's instructions or steering, so only what the agent recorded is here.",
      };
}

function StepRow({ row, active, onOpen }: { row: StoryRow; active: boolean; onOpen: () => void }) {
  const tests = testSummary(row.step);
  const at = new Date(row.commit.authoredAt * 1000).toISOString();
  const coverage = coverageLabel(row.step);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-step={row.commit.oid}
        aria-current={active ? "true" : undefined}
        className={`block w-full rounded-md px-2 py-1.5 text-left text-body-sm ${active ? "bg-signal-wash" : "hover:bg-sunken"}`}
      >
        <span className="flex items-baseline gap-1.5">
          {/* A merge from main is plumbing; real work stands out beside it. */}
          {row.merge && (
            <span className="flex shrink-0 items-center gap-1 self-center text-micro text-ink-faint">
              <GitMergeIcon aria-hidden /> Merge
            </span>
          )}
          <span className={`min-w-0 flex-1 truncate ${row.merge ? "text-ink-muted" : "text-ink"}`}>
            {row.step?.summary || firstLine(row.commit.message) || "(no description)"}
          </span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-ink-faint">
          {row.step ? (
            <Actor
              who={{
                name: row.step.author.name,
                kind: row.step.author.kind,
                person: row.step.author.accountable,
              }}
            />
          ) : (
            agentOf(row)
          )}
          <time dateTime={at} title={fullDate(at)} className="tabular-nums">
            {timeAgo(at)}
          </time>
          {tests && (
            <span className={tests.ok ? "text-online" : "text-danger-text"}>{tests.label}</span>
          )}
          <span title={coverage.title}>{coverage.label}</span>
        </span>
      </button>
    </li>
  );
}

function StepDetail({
  repo,
  row,
  earlier,
  shortcuts,
  wide,
  file,
  onFile,
  changesUrl,
  oldest,
  truncated,
  onNewer,
  onOlder,
  onClose,
}: {
  repo: TimelineRepo;
  row: StoryRow;
  /** Steps before this one on the line, nearest first, to compare visuals with (CORE-383). */
  earlier: Step[];
  shortcuts: boolean;
  /** The list sits beside the step; otherwise the step has the screen and a bar of its own. */
  wide: boolean;
  /** The file chosen in the diff (`?file=`, CORE-382). */
  file: string | null;
  onFile: (path: string | null) => void;
  /** This repository's changes across the whole timeline. */
  changesUrl: string;
  /** The last step in the list, with nothing filtered out. */
  oldest: boolean;
  /** Earlier history was cut off. */
  truncated: boolean;
  onNewer: (() => void) | null;
  onOlder: (() => void) | null;
  onClose: () => void;
}) {
  const base = `/repos/${encodeURIComponent(repo.space)}/${encodeURIComponent(repo.name)}`;
  const [versions, setVersions] = useState<Step[]>(row.step ? [row.step] : []);
  const [version, setVersion] = useState(row.commit.oid);
  useEffect(() => {
    if (!row.step) return;
    const abort = new AbortController();
    api<StepVersions>(`${base}/steps/${row.step.changeId}`, { signal: abort.signal })
      .then((v) => setVersions(v.versions))
      .catch(() => {});
    return () => abort.abort();
  }, [base, row.step]);
  const step = versions.find((v) => v.commitOid === version) ?? row.step;
  const at = new Date(row.commit.authoredAt * 1000).toISOString();
  const diff = useDiff(repo, version);
  // A file kept from the step before that this diff doesn't change is dropped.
  useEffect(() => {
    if (file && diff.diff && !diff.diff.files.some((f) => f.path === file)) onFile(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff.diff]);
  // On a phone the step replaces the list: start at its heading.
  const heading = useRef<HTMLHeadingElement>(null);
  // The bar below sticks to the screen's bottom: focus must not scroll under it.
  useEffect(() => {
    if (wide) return;
    const root = document.documentElement;
    const was = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = "4.5rem";
    return () => {
      root.style.scrollPaddingBottom = was;
    };
  }, [wide]);
  useEffect(() => {
    if (!wide) heading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const files = diff.diff?.files ?? [];
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const newerKeys = shortcuts ? "k ArrowLeft ArrowUp" : "ArrowLeft";
  const olderKeys = shortcuts ? "j ArrowRight ArrowDown" : "ArrowRight";
  const newerTitle = shortcuts ? "Newer step (k, Left or Up)" : "Newer step (Left)";
  const olderTitle = shortcuts ? "Older step (j, Right or Down)" : "Older step (Right)";
  return (
    <section aria-label="Step" className="min-w-0 rounded-pane bg-pane p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2
          ref={heading}
          tabIndex={-1}
          className="m-0 min-w-0 flex-1 text-body font-semibold [overflow-wrap:anywhere] outline-none max-sm:order-first max-sm:basis-full"
        >
          {step?.summary || firstLine(row.commit.message) || "(no description)"}
        </h2>
        <span className="flex gap-2 max-lg:hidden">
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--sm"
            disabled={!onNewer}
            onClick={() => onNewer?.()}
            aria-label="Newer step"
            aria-keyshortcuts={newerKeys}
            title={newerTitle}
          >
            <CaretLeftIcon aria-hidden /> Newer
          </button>
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--sm"
            disabled={!onOlder}
            onClick={() => onOlder?.()}
            aria-label="Older step"
            aria-keyshortcuts={olderKeys}
            title={olderTitle}
          >
            Older <CaretRightIcon aria-hidden />
          </button>
        </span>
      </div>
      <p className="mt-1 mb-3 flex flex-wrap gap-x-3 text-body-sm text-ink-muted">
        <span>
          {step ? (
            <Actor
              who={{
                name: step.author.name,
                kind: step.author.kind,
                person: step.author.accountable,
              }}
              link
            />
          ) : (
            row.commit.authorName
          )}
        </span>
        <time dateTime={at} title={fullDate(at)}>
          {timeAgo(at)}
        </time>
        <Link
          className={`${link} mk-mono`}
          to={sourceUrl(commitPanelUrl(repo.space, repo.name, version), repo.source?.sourceId)}
          title={`Open commit ${shortOid(version)} in ${repo.space}/${repo.name}`}
        >
          {shortOid(version)}
        </Link>
        {step?.issue && <span className="mk-chip mk-chip--tag">{step.issue}</span>}
        {step && !step.verified && (
          <span
            className="mk-chip mk-chip--tag"
            title="Timelines hasn't seen this commit in a push yet."
          >
            Unpushed
          </span>
        )}
        {diff.diff && (
          <span
            className="mk-tabular"
            title={diff.diff.truncated ? "More files not shown" : undefined}
          >
            {files.length} {files.length === 1 ? "file" : "files"}
            {" · "}
            <span className="text-online">+{additions}</span>{" "}
            <span className="text-danger-text">−{deletions}</span>
          </span>
        )}
        <Link
          className={link}
          to={changesUrl}
          title={`Everything ${repo.space}/${repo.name} changed on this timeline`}
        >
          Timeline changes
        </Link>
      </p>
      {versions.length > 1 && (
        <div className="mb-3">
          <SelectField
            ariaLabel="Version"
            className="w-80 max-w-full"
            value={version}
            options={versions.map((v, n) => ({
              value: v.commitOid,
              label: `${shortOid(v.commitOid)} · ${timeAgo(v.committedAt)}${n === 0 ? " (newest)" : ""}`,
            }))}
            onChange={setVersion}
          />
        </div>
      )}
      {/* The context reads first, at a reading width; the diff below gets the
          step's whole width (CORE-394): beside a context column it was left a
          narrow strip at every width the page reaches. */}
      <div className="flex flex-col gap-4">
        <Context step={step} />
        <Diff repo={repo} oid={version} state={diff} file={file} onFile={onFile} />
      </div>
      <StepVisuals step={step} earlier={earlier} />
      {oldest && (
        <p className="mt-4 mb-0 text-body-sm text-ink-muted">
          {truncated ? "Earlier steps not loaded." : "That was the first step after the fork."}{" "}
          <Link className={link} to={changesUrl}>
            Review all changes
          </Link>
        </p>
      )}
      {/* On a phone the step has the screen: keep the way on within thumb reach. */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-4 flex gap-2 border-t border-line-soft bg-pane p-2 lg:hidden">
        <button
          type="button"
          className="mk-btn mk-btn--ghost min-h-11 flex-1"
          disabled={!onNewer}
          onClick={() => onNewer?.()}
          aria-label="Newer step"
        >
          <CaretLeftIcon aria-hidden /> Newer
        </button>
        <button type="button" className="mk-btn mk-btn--ghost min-h-11 flex-1" onClick={onClose}>
          All steps
        </button>
        <button
          type="button"
          className="mk-btn mk-btn--ghost min-h-11 flex-1"
          disabled={!onOlder}
          onClick={() => onOlder?.()}
          aria-label="Older step"
        >
          Older <CaretRightIcon aria-hidden />
        </button>
      </div>
    </section>
  );
}

function Context({ step }: { step: Step | null }) {
  if (!step)
    return (
      <aside aria-label="Context" className="max-w-[80ch] text-body-sm text-ink-muted">
        <p className="m-0">
          No context was recorded for this commit. Agents attach it with{" "}
          <span className="mk-mono">gm commit --context</span>.
        </p>
      </aside>
    );
  if (step.deleted)
    return (
      <aside aria-label="Context" className="max-w-[80ch] text-body-sm text-ink-muted">
        <p className="m-0">An admin removed this step's context.</p>
      </aside>
    );
  const { context } = step;
  const heading = "mt-3 mb-1 text-body-sm font-semibold text-ink-muted first:mt-0";
  const entries = (title: string, list: Step["context"]["instructions"]) =>
    list.length > 0 && (
      <>
        <h3 className={heading}>{title}</h3>
        <ul className="m-0 pl-4 text-body-sm">
          {list.map((entry, n) => (
            <li key={n} className="[overflow-wrap:anywhere]">
              {entry.text}{" "}
              <span className="text-micro text-ink-faint">
                ({entry.source}
                <EntryTime at={givenAt(entry)} />)
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  const text = (title: string, body: string) =>
    body.trim() && (
      <>
        <h3 className={heading}>{title}</h3>
        <p className="m-0 text-body-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</p>
      </>
    );
  const missing = !byHook(context.coverage.instructions) || !byHook(context.coverage.steering);
  return (
    <aside aria-label="Context" className="min-w-0 max-w-[80ch]">
      {text("Why", context.why)}
      {entries("Instructions", context.instructions)}
      {entries("Steering", context.steering)}
      {text("Challenges", context.challenges)}
      {context.tests.length > 0 && (
        <>
          <h3 className={heading}>Tests</h3>
          <ul className="m-0 list-none p-0 text-body-sm">
            {context.tests.map((t, n) => (
              <li key={n} className="[overflow-wrap:anywhere]">
                <span className={t.exit === 0 ? "text-online" : "text-danger-text"}>
                  {t.exit === 0 ? "Passed" : `Failed (exit ${t.exit})`}
                </span>{" "}
                <span className="mk-mono">{t.command}</span>
                {t.summary && <span className="text-ink-muted"> · {t.summary}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {(context.harness || context.model) && (
        <p className="mt-3 mb-0 text-micro text-ink-faint">
          Made with {[context.harness, context.model].filter(Boolean).join(" running ")}
        </p>
      )}
      {missing && (
        <p className="mt-3 mb-0 rounded-md bg-sunken p-2 text-micro text-ink-muted" role="note">
          Steering recorded by the agent; a harness hook isn&rsquo;t set up, so some context may be
          missing.{" "}
          {context.harness === "claude-code"
            ? "Run `gm agent setup` in the agent's checkout to install the Claude Code hook."
            : "Claude Code has a hook: run `gm agent setup` in its checkout."}
        </p>
      )}
    </aside>
  );
}

interface DiffState {
  diff: CommitDiff | null;
  error: string | null;
}

/** A commit's diff, read for the step header's totals as well as the diff below it. */
function useDiff(repo: TimelineRepo, oid: string): DiffState {
  const { space, name } = repo;
  const sourceId = repo.source?.sourceId;
  const [state, setState] = useState<DiffState>({ diff: null, error: null });
  useEffect(() => {
    const abort = new AbortController();
    setState({ diff: null, error: null });
    api<CommitDiff>(
      sourceUrl(
        `/repos/${encodeURIComponent(space)}/${encodeURIComponent(name)}/commits/${oid}/diff`,
        sourceId,
      ),
      { signal: abort.signal },
    )
      .then((diff) => setState({ diff, error: null }))
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setState({
            diff: null,
            error: error instanceof Error ? error.message : "Couldn't read the diff.",
          });
      });
    return () => abort.abort();
  }, [space, name, oid, sourceId]);
  return state;
}

function Diff({
  repo,
  oid,
  state,
  file,
  onFile,
}: {
  repo: TimelineRepo;
  oid: string;
  state: DiffState;
  file: string | null;
  onFile: (path: string) => void;
}) {
  const { space, name } = repo;
  const sourceId = repo.source?.sourceId;
  if (state.error) return <p className="mk-error m-0">{state.error}</p>;
  if (!state.diff) return <p className="m-0 text-body-sm text-ink-faint">Reading the diff…</p>;
  const { files, truncated, parents } = state.diff;
  return (
    <div className="min-w-0">
      {parents.length > 1 && (
        <p className="mt-0 mb-2 rounded-md bg-sunken p-2 text-body-sm text-ink-muted" role="note">
          Merge commit: changes shown against its first parent, including what the merge brought in.
        </p>
      )}
      <DiffView
        files={files}
        truncated={truncated}
        selectedPath={file}
        onSelectPath={onFile}
        idPrefix="story-diff"
        // A deleted file lives on at the first parent.
        blobHref={(path) =>
          blobUrl(
            space,
            name,
            files.find((f) => f.path === path)?.status === "deleted" && parents[0]
              ? parents[0]
              : oid,
            path,
            sourceId,
          )
        }
      />
    </div>
  );
}

/** When an instruction or steering was given (CORE-398), if known. */
function EntryTime({ at }: { at: number | null }) {
  if (at === null) return null;
  const iso = new Date(at).toISOString();
  return (
    <>
      {" · "}
      <time dateTime={iso} title={fullDate(iso)}>
        {timeAgo(iso)}
      </time>
    </>
  );
}
