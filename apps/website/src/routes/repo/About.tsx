// The Code tab's right rail: what the knowledge graph says this repository
// is, and how CI on the default branch is doing. Each part streams in on its
// own: a slow read (the Tracker's ready count) holds up nothing else, and a
// part already shown keeps showing while its next read loads, so the rail
// never holds up a navigation (a folder to folder move reads it again).

import {
  BookOpenTextIcon,
  ListChecksIcon,
  MapTrifoldIcon,
  PackageIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import type {
  CiRunList,
  CiRunSummary,
  GraphNodeDetail,
  RepoDetail,
  RepoIssueSummary,
} from "../../../shared/api.ts";
import { CiStatusIcon, ciLabel, duration } from "../../components/CiStatus.tsx";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { RailSection } from "../../components/Rail.tsx";
import { Tip } from "../../components/ui.tsx";
import { fullDate, timeAgo } from "../../lib/format.ts";
import { repoPath } from "../../lib/refs.ts";

const STATUS_FILL: Partial<Record<CiRunSummary["status"], string>> = {
  succeeded: "bg-online",
  failed: "bg-danger-text",
};

function ExploreLink({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <li>
      <PrefetchLink
        to={to}
        className="-mx-2 flex h-8 items-center gap-2 rounded-plate px-2 text-body-sm text-ink-muted no-underline transition-colors hover:bg-raised hover:text-ink"
      >
        <span className="flex text-ink-faint">{icon}</span>
        {children}
      </PrefetchLink>
    </li>
  );
}

/** The rail's reads, as the Code loader starts them; a failed one is null. */
export interface AboutReads {
  knowledge: Promise<GraphNodeDetail | null>;
  ci: Promise<CiRunList | null>;
  issues: Promise<RepoIssueSummary | null>;
}

/** What each read resolved to, once it has: a part reads it at once, without a render's wait. */
const settledReads = new WeakMap<Promise<unknown>, { value: unknown }>();

/**
 * The value `read` resolved to, or until it has, the last value an earlier
 * read resolved to here; undefined before any did. It never suspends: inside a
 * navigation's transition, a pending read in a Suspense boundary already shown
 * would hold up the whole page until it resolved.
 */
function useSettled<T>(read: Promise<T>): { value: T } | undefined {
  const [last, setLast] = useState<{ value: T } | undefined>(
    () => settledReads.get(read) as { value: T } | undefined,
  );
  useEffect(() => {
    let live = true;
    void read.then((value) => {
      settledReads.set(read, { value });
      if (live) setLast({ value });
    });
    return () => {
      live = false;
    };
  }, [read]);
  return (settledReads.get(read) as { value: T } | undefined) ?? last;
}

/**
 * Each part renders when its own read arrives, nothing before; CI waits for
 * the About section above it (its read is cached and quick) so it never
 * pushes that down. Key it by the access epoch, repository and scope so a
 * part never shows another identity's or repository's data while the new one
 * loads.
 */
export function AboutRail({ repo, reads }: { repo: RepoDetail; reads: AboutReads }) {
  const knowledge = useSettled(reads.knowledge);
  const ci = useSettled(reads.ci);
  const issues = useSettled(reads.issues);
  if (!knowledge) return null;
  return (
    <>
      <About repo={repo} knowledge={knowledge.value} issues={issues} />
      {ci?.value && <CiSection repo={repo} ci={ci.value} />}
    </>
  );
}

function IssuesLink({
  repo,
  issues,
}: {
  repo: RepoDetail;
  issues: { value: RepoIssueSummary | null } | undefined;
}) {
  // Its row is kept while the count loads, so the links below don't move.
  if (!issues) return <li aria-hidden="true" className="h-8" data-testid="issues-pending" />;
  const summary = issues.value;
  if (!summary || summary.ready === null) return null;
  return (
    <ExploreLink
      to={repoPath(repo.space.slug, repo.name, "tracker")}
      icon={<ListChecksIcon weight="bold" aria-hidden />}
    >
      Issues · <span className="font-mono text-mono tabular-nums">{summary.ready}</span> ready
    </ExploreLink>
  );
}

function About({
  repo,
  knowledge,
  issues,
}: {
  repo: RepoDetail;
  knowledge: GraphNodeDetail | null;
  issues: { value: RepoIssueSummary | null } | undefined;
}) {
  const [more, setMore] = useState(false);
  const space = repo.space.slug;
  const node = knowledge?.node;
  const summary = node?.summary ?? "";
  const long = summary.length > 320;
  const stack = Array.isArray(node?.data.techStack)
    ? (node.data.techStack as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  const files = typeof node?.data.files === "number" ? node.data.files : null;
  const components =
    knowledge?.outgoing.filter((l) => l.kind === "contains" && l.node.kind === "component")
      .length ?? 0;

  return (
    <RailSection title="About">
      {summary ? (
        <>
          <p
            className={`m-0 max-w-[48ch] text-body-sm text-ink-muted ${long && !more ? "line-clamp-6" : ""}`}
          >
            {summary}
          </p>
          {long && (
            <button
              type="button"
              className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-body-sm font-semibold text-ink-muted hover:text-ink"
              aria-expanded={more}
              onClick={() => setMore(!more)}
            >
              {more ? "Less" : "More"}
            </button>
          )}
        </>
      ) : (
        <p className="m-0 max-w-[48ch] text-body-sm text-ink-faint">
          The knowledge graph hasn't described this repository yet. It starts after a push.
        </p>
      )}
      {stack.length > 0 && (
        <ul aria-label="Tech stack" className="m-0 mt-3 flex list-none flex-wrap gap-1.5 p-0">
          {stack.map((tech) => (
            <li key={tech} className="mk-chip mk-chip--tag">
              {tech}
            </li>
          ))}
        </ul>
      )}
      <ul className="m-0 mt-3 list-none p-0">
        <ExploreLink
          to={repoPath(space, repo.name, "wiki")}
          icon={<BookOpenTextIcon weight="bold" aria-hidden />}
        >
          Read the wiki
        </ExploreLink>
        <ExploreLink
          to={repoPath(space, repo.name, "knowledge")}
          icon={<MapTrifoldIcon weight="bold" aria-hidden />}
        >
          {files !== null ? (
            <span>
              <span className="font-mono text-mono text-ink tabular-nums">{files}</span> files
              {components > 0 && (
                <>
                  , <span className="font-mono text-mono text-ink tabular-nums">{components}</span>{" "}
                  components on the map
                </>
              )}
            </span>
          ) : (
            "Knowledge map"
          )}
        </ExploreLink>
        <ExploreLink
          to={repoPath(space, repo.name, "packages")}
          icon={<PackageIcon weight="bold" aria-hidden />}
        >
          Packages published from here
        </ExploreLink>
        <IssuesLink repo={repo} issues={issues} />
        <ExploreLink
          to={repoPath(space, repo.name, "releases")}
          icon={<TagIcon weight="bold" aria-hidden />}
        >
          Releases
        </ExploreLink>
      </ul>
    </RailSection>
  );
}

function CiSection({ repo, ci }: { repo: RepoDetail; ci: CiRunList }) {
  const space = repo.space.slug;
  const runs = ci.runs.filter((run) => run.ref === repo.defaultBranch);
  const latest = runs[0];
  const recent = runs.slice(0, 16).reverse();
  return (
    <RailSection
      title={`CI on ${repo.defaultBranch}`}
      action={
        <PrefetchLink
          to={repoPath(space, repo.name, "ci")}
          className="text-body-sm text-ink-muted no-underline hover:text-ink"
        >
          All runs
        </PrefetchLink>
      }
    >
      {latest ? (
        <>
          <PrefetchLink
            to={repoPath(space, repo.name, "ci", String(latest.number))}
            className="-mx-2 flex items-start gap-2.5 rounded-plate px-2 py-1.5 text-ink no-underline transition-colors hover:bg-raised"
          >
            <CiStatusIcon status={latest.status} className="mt-0.5 size-4" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-sm font-semibold" dir="auto">
                {latest.title || "(no message)"}
              </span>
              <span className="block text-micro text-ink-faint tabular-nums">
                <span className="font-mono">#{latest.number}</span> · {ciLabel(latest.status)}
                {latest.startedAt && ` in ${duration(latest.startedAt, latest.finishedAt)}`} ·{" "}
                <span title={fullDate(latest.createdAt)}>{timeAgo(latest.createdAt)}</span>
              </span>
            </span>
          </PrefetchLink>
          {recent.length > 1 && (
            <ol
              aria-label={`Last ${recent.length} runs, oldest first`}
              className="m-0 mt-2 flex list-none gap-1 p-0"
            >
              {recent.map((run) => (
                <li key={run.id} className="flex">
                  <Tip label={`#${run.number} · ${ciLabel(run.status)}`}>
                    <PrefetchLink
                      to={repoPath(space, repo.name, "ci", String(run.number))}
                      aria-label={`Run ${run.number}: ${ciLabel(run.status)}`}
                      className="flex size-4 items-center justify-center rounded-[3px] hover:bg-raised"
                    >
                      <span
                        className={`size-2.5 rounded-[2px] ${STATUS_FILL[run.status] ?? "bg-ink-faint"}`}
                      />
                    </PrefetchLink>
                  </Tip>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <p className="m-0 text-body-sm text-ink-faint">No runs on {repo.defaultBranch} yet.</p>
      )}
    </RailSection>
  );
}
