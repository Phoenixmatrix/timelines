import {
  ArrowClockwiseIcon,
  GitBranchIcon,
  PackageIcon,
  PlayIcon,
  StopIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import type { CiJob, CiLogs, CiRunDetail, CiRunList, CiRunSummary } from "../../../shared/api.ts";
import { CiStatusIcon, ciLabel, duration, isActive } from "../../components/CiStatus.tsx";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { FormError } from "../../components/ui.tsx";
import { api, attempt, field, load } from "../../lib/api.ts";
import { bytes, fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { formatLabel, packagePath } from "../../lib/packages.ts";
import { STATUS_LABEL } from "../packages/PackageConsole.tsx";
import type { Published } from "../../../shared/packages.ts";
import { repoPath, treeUrl } from "../../lib/refs.ts";
import { useRepo } from "./RepoLayout.tsx";

const SETUP_STEP = -1;
const base = (owner?: string, name?: string) => `/repos/${owner}/${name}/ci`;

export async function ciLoader({ request, params }: LoaderFunctionArgs) {
  return load<CiRunList>(base(params.owner, params.repo), request);
}

export async function ciRunLoader({ request, params }: LoaderFunctionArgs) {
  const repo = `${params.owner}/${params.repo}`;
  // What the run published is extra: the run page never fails on it.
  const published = api<Published>(
    `/packages/-/published?repo=${encodeURIComponent(repo)}&run=${params.number}`,
    { signal: request.signal },
  ).catch(() => ({ rows: [] }) as Published);
  const run = await load<CiRunDetail>(
    `${base(params.owner, params.repo)}/runs/${params.number}`,
    request,
  );
  return { ...run, published: (await published).rows };
}

/** Every package version the run published, linked to its console. */
function PublishedPanel({ rows }: { rows: Published["rows"] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="ci-published" className="overflow-hidden rounded-pane bg-pane">
      <h3 id="ci-published" className="m-0 border-b border-line-soft px-4 py-3 text-title">
        Published
      </h3>
      <ul className="m-0 list-none divide-y divide-line-soft p-0">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              to={`${packagePath(row.feed, row.format, row.package)}?q=${encodeURIComponent(`run:${row.runNumber} source:${row.repo}`)}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-ink no-underline hover:bg-raised"
            >
              <PackageIcon weight="bold" className="text-ink-faint" aria-hidden />
              <span className="font-semibold">{row.package}</span>
              <span className="mk-mono text-body-sm">{row.version}</span>
              <span className="mk-chip mk-chip--tag">{formatLabel(row.format)}</span>
              {row.status !== "active" && (
                <span className="mk-chip mk-chip--tag">{STATUS_LABEL[row.status]}</span>
              )}
              <span className="flex-1" />
              <span className="text-micro text-ink-faint mk-tabular">
                {row.size !== null ? bytes(row.size) : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export async function ciAction({ request, params }: ActionFunctionArgs) {
  const form = await request.formData();
  const root = base(params.owner, params.repo);
  const intent = field(form, "intent");
  const result = await attempt(async () => {
    if (intent === "cancel") {
      await api(`${root}/runs/${field(form, "number")}/cancel`, { method: "POST" });
      return { number: Number(field(form, "number")) };
    }
    const path =
      intent === "rerun" ? `${root}/runs/${field(form, "number")}/rerun` : `${root}/runs`;
    return api<{ number: number }>(path, {
      method: "POST",
      json: intent === "start" ? { ref: field(form, "ref") || undefined } : {},
    });
  });
  if ("error" in result) return result;
  return redirect(repoPath(params.owner ?? "", params.repo ?? "", "ci", String(result.number)));
}

/** Revalidate on a timer while `busy`, so live runs update themselves. */
function usePolling(busy: boolean, ms = 2000) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, ms);
    return () => clearInterval(timer);
  }, [busy, ms, revalidator]);
}

function RunnerHint({ runner, waiting }: { runner: CiRunList["runner"]; waiting: boolean }) {
  if (runner !== "local" || !waiting) return null;
  return (
    <div className="mk-strip">
      <span className="mk-strip-dot" />
      <span className="mk-strip-text">
        Jobs run on this machine: <code className="mk-mono">vp dev</code> starts a runner for each
        one. If a job keeps waiting, check the dev server's log, or run{" "}
        <code className="mk-mono">gm runner --once</code>.
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="mk-card">
      <h2 className="mk-card-title">No runs yet</h2>
      <p className="mk-card-desc">
        Add a pipeline at <code className="mk-mono">.gitmatrix/ci.yml</code> and push. Every push to
        a matching branch starts a run.
      </p>
      <pre className="mk-mono mt-3 mb-0 overflow-x-auto rounded-control bg-sunken p-3 text-mono">
        {`on:
  push:
    branches: [main]
jobs:
  test:
    steps:
      - name: Install
        run: pnpm install --frozen-lockfile
      - run: vp test
  deploy:
    needs: [test]
    if: branch == "main"
    secrets: [CLOUDFLARE_API_TOKEN]
    steps:
      - run: cf deploy`}
      </pre>
    </section>
  );
}

function RunRow({ run }: { run: CiRunSummary }) {
  const repo = useRepo();
  return (
    <li>
      <PrefetchLink
        to={repoPath(repo.owner.slug, repo.name, "ci", String(run.number))}
        className="flex items-center gap-3 px-4 py-3 text-ink no-underline hover:bg-raised"
      >
        <CiStatusIcon status={run.status} className="size-5" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold" dir="auto">
            {run.title || "(no message)"}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-body-sm text-ink-faint">
            <span>#{run.number}</span>
            <span>·</span>
            <span>
              {run.trigger === "manual"
                ? `Started by ${run.actor ?? "someone"}`
                : `Pushed${run.actor ? ` by ${run.actor}` : ""}`}
            </span>
            <span>·</span>
            <span title={fullDate(run.createdAt)}>{timeAgo(run.createdAt)}</span>
            {run.startedAt && (
              <>
                <span>·</span>
                <span>{duration(run.startedAt, run.finishedAt)}</span>
              </>
            )}
          </div>
        </div>
        <span className="mk-chip mk-chip--tag hidden h-6 gap-1 sm:inline-flex">
          <GitBranchIcon weight="bold" aria-hidden />
          {run.ref}
        </span>
        <span className="mk-chip mk-chip--tag mk-mono h-6">{shortOid(run.commit)}</span>
      </PrefetchLink>
    </li>
  );
}

export function CiRuns() {
  const { runs, runner } = useLoaderData<typeof ciLoader>();
  const error = useActionData<typeof ciAction>();
  const repo = useRepo();
  const navigation = useNavigation();
  const canRun = repo.viewerRole === "write" || repo.viewerRole === "admin";
  usePolling(runs.some((r) => isActive(r.status)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-title">Runs</h2>
        {canRun && repo.head && (
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="intent" value="start" />
            <input type="hidden" name="ref" value={repo.defaultBranch} />
            <button
              type="submit"
              className="mk-btn mk-btn--sm"
              disabled={navigation.state !== "idle"}
            >
              <PlayIcon weight="bold" aria-hidden />
              Run {repo.defaultBranch}
            </button>
          </Form>
        )}
      </div>
      <FormError message={error && "error" in error ? error.error : null} />
      <RunnerHint
        runner={runner}
        waiting={runs.some((r) => r.status === "queued" || r.status === "running")}
      />
      {runs.length === 0 ? (
        <EmptyState />
      ) : (
        <ol className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ol>
      )}
    </div>
  );
}

// ---- one run ----------------------------------------------------------------

/** Terminal output as plain text: drop colors, keep the last state of \r-redrawn lines. */
function clean(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .split("\n")
      .map((line) => line.slice(line.lastIndexOf("\r", line.length - 2) + 1).replace(/\r$/, ""))
      .join("\n")
  );
}

/** A job's log, fetched incrementally while the job runs. (JobPanel is keyed by job.) */
function useJobLog(owner: string, name: string, job: CiJob) {
  const [log, setLog] = useState({ byStep: new Map<number, string>(), next: 0, done: false });
  const active = isActive(job.status);

  useEffect(() => {
    if (log.done && !active) return;
    let stopped = false;
    const timer = setTimeout(
      async () => {
        try {
          const page = await api<CiLogs>(
            `/repos/${owner}/${name}/ci/jobs/${job.id}/logs?after=${log.next}`,
          );
          if (stopped) return;
          setLog((current) => {
            const byStep = new Map(current.byStep);
            for (const chunk of page.chunks) {
              byStep.set(chunk.step, (byStep.get(chunk.step) ?? "") + chunk.text);
            }
            return { byStep, next: page.next, done: page.done };
          });
        } catch {
          // A new state object schedules the next attempt.
          if (!stopped) setLog((current) => ({ ...current }));
        }
      },
      log.next === 0 ? 0 : 1000,
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [owner, name, job.id, log, active]);

  return log;
}

function setupStatus(job: CiJob): CiJob["steps"][number]["status"] {
  if (job.status === "pending" || job.status === "queued") return "pending";
  if (job.error === "Checkout failed.") return "failed";
  const started = job.steps.some((s) => s.status !== "pending");
  return started || !isActive(job.status) ? "succeeded" : "running";
}

function StepLog({
  title,
  status,
  exitCode,
  time,
  text,
  open,
}: {
  title: string;
  status: CiJob["steps"][number]["status"];
  exitCode: number | null;
  time: string;
  text: string;
  open: boolean;
}) {
  const pre = useRef<HTMLPreElement>(null);
  // Follow the tail while the step is running.
  useEffect(() => {
    if (status === "running" && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text, status]);
  return (
    <details open={open} className="group border-b border-line-soft last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 hover:bg-raised">
        <CiStatusIcon status={status} />
        <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
        {exitCode !== null && exitCode !== 0 && (
          <span className="mk-mono text-mono text-danger-text">exit {exitCode}</span>
        )}
        <span className="mk-mono text-mono text-ink-faint">{time}</span>
      </summary>
      {text ? (
        <pre
          ref={pre}
          className="mk-mono m-0 max-h-[32rem] overflow-auto bg-sunken px-4 py-3 text-mono leading-relaxed whitespace-pre-wrap break-words"
        >
          {clean(text)}
        </pre>
      ) : (
        <p className="m-0 bg-sunken px-4 py-3 text-body-sm text-ink-faint">
          {status === "pending" || status === "skipped" ? "Did not run." : "No output."}
        </p>
      )}
    </details>
  );
}

function JobPanel({ job }: { job: CiJob }) {
  const repo = useRepo();
  const log = useJobLog(repo.owner.slug, repo.name, job);
  const setup = log.byStep.get(SETUP_STEP) ?? "";
  return (
    <section className="min-w-0 overflow-hidden rounded-pane bg-pane">
      <header className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3">
        <CiStatusIcon status={job.status} className="size-5" />
        <h3 className="m-0 text-title">{job.name}</h3>
        <span className="text-body-sm text-ink-faint">
          {ciLabel(job.status)}
          {job.startedAt && ` · ${duration(job.startedAt, job.finishedAt)}`}
          {job.claimedBy && ` · ${job.runner === "sandbox" ? "Cloudflare Sandbox" : job.claimedBy}`}
        </span>
      </header>
      {job.error && (
        <p className="m-0 border-b border-line-soft bg-danger-wash px-4 py-2.5 text-body-sm text-danger-text">
          {job.error}
        </p>
      )}
      {(setup || job.startedAt) && (
        <StepLog
          title="Set up"
          status={setupStatus(job)}
          exitCode={null}
          time=""
          text={setup}
          open={false}
        />
      )}
      {job.steps.map((step) => (
        <StepLog
          key={step.position}
          title={step.name}
          status={step.status}
          exitCode={step.exitCode}
          time={duration(step.startedAt, step.finishedAt)}
          text={log.byStep.get(step.position) ?? ""}
          open={step.status === "running" || step.status === "failed"}
        />
      ))}
    </section>
  );
}

export function CiRun() {
  const run = useLoaderData<typeof ciRunLoader>();
  const error = useActionData<typeof ciAction>();
  const repo = useRepo();
  const navigation = useNavigation();
  const [params, setParams] = useSearchParams();
  const canRun = repo.viewerRole === "write" || repo.viewerRole === "admin";
  const active = isActive(run.status);
  usePolling(active);

  const chosen =
    run.jobs.find((j) => j.name === params.get("job")) ??
    run.jobs.find((j) => j.status === "running") ??
    run.jobs.find((j) => j.status === "failed") ??
    run.jobs.find((j) => j.status !== "skipped") ??
    run.jobs[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={repoPath(repo.owner.slug, repo.name, "ci")}
            className="text-body-sm text-ink-muted no-underline hover:text-ink"
          >
            ← All runs
          </Link>
          <h2 className="m-0 mt-1 flex items-center gap-2 text-title-lg">
            <CiStatusIcon status={run.status} className="size-6" />
            <span className="truncate" dir="auto">
              {run.title || "(no message)"}
            </span>
            <span className="font-normal text-ink-faint">#{run.number}</span>
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-body-sm text-ink-faint">
            <span>{ciLabel(run.status)}</span>
            <span>·</span>
            <span>
              {run.trigger === "manual" ? "Started by" : "Pushed by"} {run.actor ?? "someone"}{" "}
              <span title={fullDate(run.createdAt)}>{timeAgo(run.createdAt)}</span>
            </span>
            {run.startedAt && (
              <>
                <span>·</span>
                <span>{duration(run.startedAt, run.finishedAt)}</span>
              </>
            )}
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <GitBranchIcon weight="bold" aria-hidden />
              {run.ref}
            </span>
            <PrefetchLink
              to={treeUrl(repo.owner.slug, repo.name, run.commit)}
              className="mk-chip mk-chip--tag mk-mono h-6 no-underline"
              title="Browse files at this commit"
            >
              {shortOid(run.commit)}
            </PrefetchLink>
          </div>
        </div>
        {canRun && (
          <Form
            method="post"
            action={repoPath(repo.owner.slug, repo.name, "ci")}
            className="flex gap-2"
          >
            <input type="hidden" name="number" value={run.number} />
            {active ? (
              <button
                type="submit"
                name="intent"
                value="cancel"
                className="mk-btn mk-btn--sm mk-btn--danger-ghost"
                disabled={navigation.state !== "idle"}
              >
                <StopIcon weight="bold" aria-hidden />
                Cancel
              </button>
            ) : (
              <button
                type="submit"
                name="intent"
                value="rerun"
                className="mk-btn mk-btn--sm"
                disabled={navigation.state !== "idle"}
              >
                <ArrowClockwiseIcon weight="bold" aria-hidden />
                Re-run
              </button>
            )}
          </Form>
        )}
      </div>
      <FormError message={error && "error" in error ? error.error : null} />

      {run.configError ? (
        <section className="mk-card">
          <h3 className="mk-card-title">The pipeline could not be read</h3>
          <p className="mk-card-desc">{run.configError}</p>
        </section>
      ) : (
        <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
          <nav aria-label="Jobs" className="self-start overflow-hidden rounded-pane bg-pane">
            <ul className="m-0 list-none p-1">
              {run.jobs.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    aria-current={job.id === chosen?.id ? "true" : undefined}
                    onClick={() =>
                      setParams({ job: job.name }, { replace: true, preventScrollReset: true })
                    }
                    className="flex w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-3 py-2 text-left text-ink hover:bg-raised aria-[current=true]:bg-raised"
                  >
                    <CiStatusIcon status={job.status} />
                    <span className="min-w-0 flex-1 truncate font-semibold">{job.name}</span>
                    <span className="mk-mono text-mono text-ink-faint">
                      {duration(job.startedAt, job.finishedAt)}
                    </span>
                  </button>
                  {job.needs.length > 0 && (
                    <div className="truncate px-9 pb-1 text-micro text-ink-faint">
                      after {job.needs.join(", ")}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </nav>
          {chosen && <JobPanel key={chosen.id} job={chosen} />}
        </div>
      )}
      <PublishedPanel rows={run.published} />
      {active && run.jobs.some((j) => j.status === "queued" && j.runner === "local") && (
        <RunnerHint runner="local" waiting />
      )}
    </div>
  );
}
