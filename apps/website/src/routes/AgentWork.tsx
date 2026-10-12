// Agent work (CORE-220): what the agents you answer for finished lately, across
// every tracker you're in, each issue with the work behind it (commits, steps,
// CI, timelines, release notes) a click away. Like the tracker's "Closed
// lately", limited to your agents, and sliced by agent, tracker, window and type.

import { CaretDownIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import {
  Link,
  useLoaderData,
  useSearchParams,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { CompletedWork, CompletedWorkList, TrackerIdentity } from "../../shared/tracker.ts";
import { Page } from "../components/AppShell.tsx";
import { SelectField } from "../components/ui.tsx";
import { load } from "../lib/api.ts";
import { fullDate, timeAgo } from "../lib/format.ts";
import { requireViewer, useViewer } from "../lib/session.ts";
import { Actor } from "./tracker/Actor.tsx";
import { LinkedWorkPanel } from "./tracker/LinkedWork.tsx";
import { DoneInTimelineIcon, typeLabel } from "./tracker/ui.tsx";

export const WINDOWS = [
  { value: "7d", label: "7 days" },
  { value: "14d", label: "14 days" },
  { value: "30d", label: "30 days" },
] as const;
const DEFAULT_WINDOW = "14d";
const ALL = "all";

function windowOf(params: URLSearchParams): string {
  const since = params.get("since");
  return WINDOWS.some((w) => w.value === since) ? since! : DEFAULT_WINDOW;
}

export async function agentWorkLoader({ request }: LoaderFunctionArgs) {
  await requireViewer(request);
  const since = windowOf(new URL(request.url).searchParams);
  // Agent, tracker and type slice what's loaded; only the window asks again.
  return load<CompletedWorkList>(`/agent-work?since=${since}`, request);
}

export function agentWorkShouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  return windowOf(currentUrl.searchParams) !== windowOf(nextUrl.searchParams);
}

export function AgentWork() {
  const data = useLoaderData<typeof agentWorkLoader>();
  const viewer = useViewer();
  const [params, setParams] = useSearchParams();
  const range = windowOf(params);
  const pick = (key: string, known: string[]) => {
    const value = params.get(key);
    return value && known.includes(value) ? value : ALL;
  };
  const agent = pick(
    "agent",
    data.agents.map((a) => a.name),
  );
  const trackerSlug = pick(
    "tracker",
    data.trackers.map((t) => t.slug),
  );
  const types = [...new Set(data.items.map((item) => item.issue.type))].sort();
  const type = pick("type", types);
  const set = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === ALL || (key === "since" && value === DEFAULT_WINDOW)) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  const agentId = data.agents.find((a) => a.name === agent)?.id;
  const items = data.items.filter(
    (item) =>
      (agent === ALL || item.completion.actorId === agentId) &&
      (trackerSlug === ALL || item.tracker.slug === trackerSlug) &&
      (type === ALL || item.issue.type === type),
  );
  const names = new Map(data.agents.map((a) => [a.id, a.name]));
  const person: TrackerIdentity | null = viewer
    ? { id: viewer.id, slug: viewer.slug, displayName: viewer.displayName }
    : null;
  const days = WINDOWS.find((w) => w.value === range)!.label;

  return (
    <Page>
      <h1 className="m-0 text-headline">Agent work</h1>
      <p className="mt-1.5 mb-0 max-w-[52ch] text-ink-muted">
        What your agents finished, across your trackers: whoever held the claim when it was done,
        including work done in a timeline that hasn't landed. Open one to see the commits, steps,
        CI, timelines and release notes behind it.
      </p>

      {data.agents.length === 0 ? (
        <p className="mk-empty mt-8">
          You have no agents yet.{" "}
          <Link to="/settings/agents" className="text-ink underline-offset-2 hover:underline">
            Set one up
          </Link>{" "}
          and what it finishes shows here.
        </p>
      ) : (
        <>
          <div
            className="mt-6 flex flex-wrap items-end gap-3"
            role="group"
            aria-label="Filter agent work"
          >
            <div className="mk-field">
              <span className="mk-label">Finished in the last</span>
              <div className="mk-segmented" role="radiogroup" aria-label="Window">
                {WINDOWS.map((w) => (
                  <button
                    key={w.value}
                    type="button"
                    role="radio"
                    aria-checked={range === w.value}
                    className="mk-segment"
                    onClick={() => set("since", w.value)}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>
            <Filter
              label="Agent"
              value={agent}
              all="All my agents"
              options={data.agents.map((a) => ({
                value: a.name,
                label: a.revoked ? `${a.name} (revoked)` : a.name,
              }))}
              onChange={(value) => set("agent", value)}
            />
            <Filter
              label="Tracker"
              value={trackerSlug}
              all="All trackers"
              options={data.trackers.map((t) => ({ value: t.slug, label: t.displayName }))}
              onChange={(value) => set("tracker", value)}
            />
            <Filter
              label="Type"
              value={type}
              all="All types"
              options={types.map((t) => ({ value: t, label: typeLabel(t) }))}
              onChange={(value) => set("type", value)}
            />
          </div>

          <section className="mt-6" aria-labelledby="finished">
            <h2 id="finished" className="m-0 mb-1 text-title">
              Finished
            </h2>
            <p className="m-0 mb-3 text-body-sm text-ink-muted" aria-live="polite">
              {items.length === 1 ? "1 issue" : `${items.length} issues`} in the last {days}
              {data.truncated && ", the newest of more: narrow the window to see the rest"}.
            </p>
            {items.length === 0 ? (
              <p className="mk-empty m-0">
                Nothing finished in the last {days}
                {agent === ALL && trackerSlug === ALL && type === ALL ? "" : " that matches"}.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col divide-y divide-line-soft p-0">
                {items.map((item) => (
                  <WorkRow
                    key={`${item.tracker.slug}:${item.issue.id}`}
                    item={item}
                    agentName={names.get(item.completion.actorId) ?? item.completion.actorId}
                    person={person}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Page>
  );
}

function Filter({
  label,
  value,
  all,
  options,
  onChange,
}: {
  label: string;
  value: string;
  all: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="mk-field min-w-40">
      <span className="mk-label">{label}</span>
      <SelectField
        value={value}
        options={[{ value: ALL, label: all }, ...options]}
        onChange={onChange}
        ariaLabel={label}
      />
    </div>
  );
}

function WorkRow({
  item,
  agentName,
  person,
}: {
  item: CompletedWork;
  agentName: string;
  person: TrackerIdentity | null;
}) {
  // Linked work loads only once a row is opened, never for every row up front.
  const [open, setOpen] = useState(false);
  const panel = useId();
  const { issue, completion, tracker, timeline } = item;
  const href = `/tracker/${encodeURIComponent(tracker.slug)}/issues/${encodeURIComponent(issue.id)}`;
  return (
    <li className="flex flex-col gap-2 py-3" aria-label={`${issue.key} ${issue.title}`}>
      <div className="flex min-w-0 items-start gap-2.5">
        {timeline ? (
          <DoneInTimelineIcon className="mt-1 size-4" />
        ) : (
          <CheckCircleIcon
            weight="fill"
            className="mt-0.5 size-4.5 shrink-0 text-online"
            aria-hidden
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Link
            to={href}
            className="flex min-w-0 items-baseline gap-2 text-ink no-underline hover:underline"
          >
            <span className="shrink-0 font-mono text-body-sm text-ink-muted">{issue.key}</span>
            <span className="truncate font-semibold">{issue.title}</span>
          </Link>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink-muted">
            <Actor who={{ kind: "agent", name: agentName, person }} />
            {completion.agent && (
              <span className="font-mono text-mono text-ink-faint" title="Session">
                {completion.agent}
              </span>
            )}
            <span aria-hidden>·</span>
            <span>{tracker.displayName}</span>
            <span aria-hidden>·</span>
            <span>{typeLabel(issue.type)}</span>
            {timeline && (
              <>
                <span aria-hidden>·</span>
                <span>
                  Done in <span className="font-mono text-mono">{timeline.slug}</span>, not landed
                </span>
              </>
            )}
            <span aria-hidden>·</span>
            <time dateTime={completion.at} title={fullDate(completion.at)}>
              {timeAgo(completion.at)}
            </time>
          </div>
          {item.evidence && (
            <p className="m-0 truncate text-body-sm text-ink-faint" title={item.evidence}>
              {item.evidence}
            </p>
          )}
        </div>
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm shrink-0"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((value) => !value)}
        >
          Work
          <CaretDownIcon
            className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
          <span className="sr-only"> behind {issue.key}</span>
        </button>
      </div>
      <div id={panel} hidden={!open} className="pl-7">
        {open && <LinkedWorkPanel owner={tracker.slug} issueId={issue.id} issueKey={issue.key} />}
      </div>
    </li>
  );
}

/** For the Agents page: where an agent's finished work is. */
export function agentWorkPath(agent?: string): string {
  return agent ? `/agent-work?agent=${encodeURIComponent(agent)}` : "/agent-work";
}
