// A timeline's story (CORE-234): its steps in order, each commit with the
// context its agent attached (CORE-226), and the commit's diff beside it.

import { CaretLeftIcon, CaretRightIcon, GitMergeIcon, RobotIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  redirect,
  data as routeData,
  useLoaderData,
  type LoaderFunctionArgs,
} from "react-router";
import { useLiveSearchParams } from "../../lib/searchParams.ts";
import type { CommitSummary, HistoryPage } from "../../../shared/api.ts";
import type { CommitDiff, DiffFile } from "../../../shared/diff.ts";
import type { Step, StepPage, StepVersions } from "../../../shared/steps.ts";
import type { TimelineDetail, TimelineRepo } from "../../../shared/timelines.ts";
import { SelectField, link } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { firstLine, fullDate, shortOid, timeAgo } from "../../lib/format.ts";

/** The filters' "no filter" value. */
const ALL = "*";

/** How far back a story reads: first-parent commits per repository. */
const MAX_COMMITS = 300;

export async function storyLoader({ request, params }: LoaderFunctionArgs) {
  try {
    return await api<TimelineDetail>(
      `/tracker/${encodeURIComponent(params.owner!)}/timelines/${encodeURIComponent(params.slug!)}?limit=200`,
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

/** Where a repository's part of the timeline ends: its bookmark while open,
 * the last commit once abandoned, the landed head once landed. */
function headOf(detail: TimelineDetail, repo: TimelineRepo): string {
  for (const event of [...detail.events].reverse()) {
    if (event.kind === "abandon" && event.lastCommits?.[repo.id])
      return event.lastCommits[repo.id]!;
    if (event.kind === "merge" && event.fromId === detail.timeline.id && event.repoId === repo.id)
      return event.parent;
  }
  return repo.bookmark;
}

function useStory(detail: TimelineDetail, repo: TimelineRepo | undefined) {
  const [state, setState] = useState<{
    rows: StoryRow[];
    error: string | null;
    loading: boolean;
    more: boolean;
  }>({ rows: [], error: null, loading: true, more: false });
  useEffect(() => {
    if (!repo) return;
    const abort = new AbortController();
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    const fork = detail.timeline.forkPoint.commits[repo.id];
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      const commits: CommitSummary[] = [];
      let at: string | null = headOf(detail, repo);
      let cursor: string | null = null;
      let more = false;
      while (at) {
        const query = new URLSearchParams({ at });
        if (cursor) query.set("cursor", cursor);
        const page: HistoryPage = await api<HistoryPage>(`${base}/history?${query}`, {
          signal: abort.signal,
        });
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
        rows: [],
        error: error instanceof Error ? error.message : "Couldn't read this timeline's steps.",
        loading: false,
        more: false,
      });
    });
    return () => abort.abort();
  }, [detail, repo]);
  return state;
}

const agentOf = (row: StoryRow) =>
  row.step ? row.step.author.name : row.commit.authorName || "Unknown";

export function Story() {
  const detail = useLoaderData() as TimelineDetail;
  const { timeline } = detail;
  const [params, setParams] = useLiveSearchParams();
  const repo =
    timeline.repos.find((r) => `${r.owner}/${r.name}` === params.get("repo")) ?? timeline.repos[0];
  const { rows, error, loading, more } = useStory(detail, repo);
  const agent = params.get("agent") ?? "";
  const issue = params.get("issue") ?? "";
  const shown = useMemo(
    () =>
      rows.filter(
        (row) => (!agent || agentOf(row) === agent) && (!issue || row.step?.issue === issue),
      ),
    [rows, agent, issue],
  );
  const agents = useMemo(() => [...new Set(rows.map(agentOf))].sort(), [rows]);
  const issues = useMemo(
    () => [...new Set(rows.flatMap((r) => (r.step?.issue ? [r.step.issue] : [])))].sort(),
    [rows],
  );
  const selected = params.get("step");
  const index = shown.findIndex((row) => row.commit.oid === selected);
  const current = index >= 0 ? shown[index]! : null;

  const set = (changes: Record<string, string | null>) =>
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
  const open = (row: StoryRow | undefined) => row && set({ step: row.commit.oid });

  // j/k and the arrow keys step through; Escape closes the step. The handler
  // reads the latest position, and remembers the step it asked for until the
  // URL shows it: a render in between (a diff loading) must not send the next
  // key from the old step.
  const position = useRef({ shown, open, set, selected, heading: null as string | null });
  position.current = {
    shown,
    open,
    set,
    selected,
    heading: position.current.heading === selected ? null : position.current.heading,
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable=true], [role=combobox], [role=listbox]",
        )
      )
        return;
      const { shown, open, set, selected, heading } = position.current;
      const at = heading ?? selected;
      const index = shown.findIndex((row) => row.commit.oid === at);
      // Newest first: "next" is the step after this one in time, one row up.
      const go = (row: StoryRow | undefined) => {
        if (!row) return;
        position.current.heading = row.commit.oid;
        open(row);
      };
      if (event.key === "j" || event.key === "ArrowLeft") go(shown[index < 0 ? 0 : index + 1]);
      else if (event.key === "k" || event.key === "ArrowRight") go(shown[index - 1]);
      else if (event.key === "Escape" && at) {
        position.current.heading = null;
        set({ step: null });
      } else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const owner = repo?.owner ?? "";
  return (
    <main className="mx-auto max-w-[110rem] px-4 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="m-0 text-title-lg [overflow-wrap:anywhere]">{timeline.name}: story</h1>
        <Link
          className={link}
          to={`/tracker/${encodeURIComponent(owner)}/timelines?tl=${timeline.slug}`}
        >
          Timeline
        </Link>
      </div>
      <p className="mt-1 mb-3 text-body-sm text-ink-muted">
        Every commit on <span className="mk-mono">timeline/{timeline.slug}</span>, newest first,
        with the context its agent recorded: why, instructions, steering, challenges and tests.
      </p>
      <div className="mb-3 flex flex-wrap items-end gap-3" role="group" aria-label="Filters">
        {timeline.repos.length > 1 && (
          <SelectField
            ariaLabel="Repository"
            className="w-56"
            value={`${repo?.owner}/${repo?.name}`}
            options={timeline.repos.map((r) => ({
              value: `${r.owner}/${r.name}`,
              label: `${r.owner}/${r.name}`,
            }))}
            onChange={(value) => set({ repo: value, step: null })}
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
      {error ? (
        <p className="mk-error">{error}</p>
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
              <ol className="m-0 list-none p-0">
                {shown.map((row) => (
                  <StepRow
                    key={row.commit.oid}
                    row={row}
                    active={row.commit.oid === selected}
                    onOpen={() => open(row)}
                  />
                ))}
              </ol>
            )}
            {more && (
              <p className="m-2 text-micro text-ink-faint">
                Showing the newest {MAX_COMMITS} commits.
              </p>
            )}
          </section>
          {current && repo ? (
            <StepDetail
              key={current.commit.oid}
              repo={repo}
              row={current}
              onPrevious={index + 1 < shown.length ? () => open(shown[index + 1]) : null}
              onNext={index > 0 ? () => open(shown[index - 1]) : null}
              onClose={() => set({ step: null })}
            />
          ) : (
            <p className="m-0 self-start rounded-pane bg-pane p-4 text-body-sm text-ink-faint max-lg:hidden">
              Open a step to see its context and diff. <kbd>j</kbd>/<kbd>k</kbd> step through.
            </p>
          )}
        </div>
      )}
    </main>
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

function coverageLabel(step: Step | null): string {
  if (!step) return "No context";
  if (step.deleted) return "Context removed";
  const { instructions, steering } = step.context.coverage;
  return byHook(instructions) && byHook(steering) ? "Full context" : "Partial context";
}

function StepRow({ row, active, onOpen }: { row: StoryRow; active: boolean; onOpen: () => void }) {
  const tests = testSummary(row.step);
  const at = new Date(row.commit.authoredAt * 1000).toISOString();
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={`block w-full rounded-md px-2 py-1.5 text-left text-body-sm ${active ? "bg-signal-wash" : "hover:bg-sunken"}`}
      >
        <span className="flex items-baseline gap-1.5">
          {row.merge && (
            <GitMergeIcon className="shrink-0 self-center text-ink-faint" aria-label="Merge" />
          )}
          <span className="min-w-0 flex-1 truncate text-ink">
            {row.step?.summary || firstLine(row.commit.message) || "(no description)"}
          </span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-ink-faint">
          <span className="inline-flex items-center gap-1">
            {row.step?.author.kind === "agent" && <RobotIcon aria-hidden />}
            {agentOf(row)}
          </span>
          <time dateTime={at} title={fullDate(at)} className="tabular-nums">
            {timeAgo(at)}
          </time>
          {tests && (
            <span className={tests.ok ? "text-online" : "text-danger-text"}>{tests.label}</span>
          )}
          <span>{coverageLabel(row.step)}</span>
        </span>
      </button>
    </li>
  );
}

function StepDetail({
  repo,
  row,
  onPrevious,
  onNext,
  onClose,
}: {
  repo: TimelineRepo;
  row: StoryRow;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
}) {
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
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
  return (
    <section aria-label="Step" className="min-w-0 rounded-pane bg-pane p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm lg:hidden"
          onClick={onClose}
        >
          All steps
        </button>
        <h2 className="m-0 min-w-0 flex-1 text-body font-semibold [overflow-wrap:anywhere] max-sm:order-first max-sm:basis-full">
          {step?.summary || firstLine(row.commit.message) || "(no description)"}
        </h2>
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm"
          disabled={!onPrevious}
          onClick={() => onPrevious?.()}
          aria-keyshortcuts="j"
        >
          <CaretLeftIcon aria-hidden /> Previous
        </button>
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm"
          disabled={!onNext}
          onClick={() => onNext?.()}
          aria-keyshortcuts="k"
        >
          Next <CaretRightIcon aria-hidden />
        </button>
      </div>
      <p className="mt-1 mb-3 flex flex-wrap gap-x-3 text-body-sm text-ink-muted">
        <span>
          {step
            ? `${step.author.name}${step.author.accountable && step.author.kind === "agent" ? ` for ${step.author.accountable.displayName}` : ""}`
            : row.commit.authorName}
        </span>
        <time dateTime={at} title={fullDate(at)}>
          {timeAgo(at)}
        </time>
        <span className="mk-mono">{shortOid(version)}</span>
        {step?.issue && <span className="mk-chip mk-chip--tag">{step.issue}</span>}
        {step && !step.verified && (
          <span className="mk-chip mk-chip--tag">Not verified by a push</span>
        )}
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
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <Diff base={base} oid={version} />
        <Context step={step} />
      </div>
    </section>
  );
}

function Context({ step }: { step: Step | null }) {
  if (!step)
    return (
      <aside aria-label="Context" className="text-body-sm text-ink-muted order-first">
        <p className="m-0">
          No context was recorded for this commit. Agents attach it with{" "}
          <span className="mk-mono">gm commit --context</span>.
        </p>
      </aside>
    );
  if (step.deleted)
    return (
      <aside aria-label="Context" className="text-body-sm text-ink-muted order-first">
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
              {entry.text} <span className="text-micro text-ink-faint">({entry.source})</span>
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
    <aside aria-label="Context" className="min-w-0 order-first">
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

function Diff({ base, oid }: { base: string; oid: string }) {
  const [state, setState] = useState<{ diff: CommitDiff | null; error: string | null }>({
    diff: null,
    error: null,
  });
  useEffect(() => {
    const abort = new AbortController();
    setState({ diff: null, error: null });
    api<CommitDiff>(`${base}/commits/${oid}/diff`, { signal: abort.signal })
      .then((diff) => setState({ diff, error: null }))
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setState({
            diff: null,
            error: error instanceof Error ? error.message : "Couldn't read the diff.",
          });
      });
    return () => abort.abort();
  }, [base, oid]);
  if (state.error) return <p className="mk-error m-0">{state.error}</p>;
  if (!state.diff) return <p className="m-0 text-body-sm text-ink-faint">Reading the diff…</p>;
  const { files, truncated } = state.diff;
  return (
    <section aria-label="Diff" className="min-w-0">
      <p className="mt-0 mb-2 text-body-sm text-ink-muted">
        {files.length} {files.length === 1 ? "file" : "files"} changed
        {truncated ? " (more not shown)" : ""}
      </p>
      {files.map((file) => (
        <DiffFileView key={file.path} file={file} />
      ))}
    </section>
  );
}

function DiffFileView({ file }: { file: DiffFile }) {
  return (
    <details open className="mb-2 rounded-md border border-line-soft">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-2 px-2 py-1 text-body-sm">
        <span className="mk-mono min-w-0 flex-1 [overflow-wrap:anywhere]">{file.path}</span>
        <span className="text-micro text-ink-faint">{file.status}</span>
        <span className="text-micro text-online">+{file.additions}</span>
        <span className="text-micro text-danger-text">−{file.deletions}</span>
      </summary>
      {file.binary ? (
        <p className="m-0 px-2 pb-2 text-micro text-ink-faint">Binary file.</p>
      ) : file.omitted ? (
        <p className="m-0 px-2 pb-2 text-micro text-ink-faint">Too large to show here.</p>
      ) : (
        <div className="overflow-x-auto">
          <pre className="m-0 text-micro leading-5">
            {file.hunks.map((hunk, h) => (
              <code key={h} className="block">
                <span className="block bg-sunken px-2 text-ink-faint">
                  @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                </span>
                {hunk.lines.map((line, n) => (
                  <span
                    key={n}
                    className={`block px-2 ${line.startsWith("+") ? "bg-data-teal-wash" : line.startsWith("-") ? "bg-danger-wash" : ""}`}
                  >
                    {line || " "}
                  </span>
                ))}
              </code>
            ))}
          </pre>
        </div>
      )}
    </details>
  );
}
