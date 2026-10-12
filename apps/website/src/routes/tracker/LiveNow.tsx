// A timeline's "Live now" (CORE-239): the latest step of each agent working
// in it, from each repository's live feed (GET …/steps/live, Server-Sent
// Events), within seconds of `gm step`. Read with fetch rather than
// EventSource so it goes through the app's request layer and can be aborted;
// a dropped stream reconnects from its last event.

import { RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { StepFeedRecord } from "../../../shared/steps.ts";
import type { Timeline } from "../../../shared/timelines.ts";
import { link } from "../../components/ui.tsx";
import { fullDate, timeAgo } from "../../lib/format.ts";

/** Parses Server-Sent Events from a fetch body, calling `onEvent` per step event. */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (id: number, record: StepFeedRecord) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    text += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = text.indexOf("\n\n")) >= 0) {
      const block = text.slice(0, end);
      text = text.slice(end + 2);
      const id = /^id: (\d+)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!/^event: step$/m.test(block) || !id || !data) continue;
      try {
        onEvent(Number(id), JSON.parse(data) as StepFeedRecord);
      } catch {
        // A record that doesn't parse is skipped.
      }
    }
  }
}

/** The live feeds of a timeline's repositories: every record seen, newest first. */
export function useStepFeed(timeline: Pick<Timeline, "slug" | "repos" | "status">) {
  const [records, setRecords] = useState<StepFeedRecord[]>([]);
  const live = timeline.status !== "landed" && timeline.status !== "abandoned";
  const repos = timeline.repos.map((r) => `${r.owner}/${r.name}`).join(",");
  useEffect(() => {
    setRecords([]);
    if (!live || !repos) return;
    const abort = new AbortController();
    const add = (record: StepFeedRecord) =>
      setRecords((prev) =>
        prev.some((r) => r.repo === record.repo && r.commitOid === record.commitOid)
          ? prev
          : [record, ...prev].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200),
      );
    for (const repo of repos.split(",")) {
      void (async () => {
        let last = 0;
        let wait = 5_000;
        while (!abort.signal.aborted) {
          try {
            const response = await fetch(
              `/api/repos/${repo}/steps/live?timeline=${encodeURIComponent(timeline.slug)}`,
              {
                signal: abort.signal,
                headers: last ? { "last-event-id": String(last) } : {},
                credentials: "same-origin",
              },
            );
            // No access, or no such repository: nothing to wait for.
            if (response.status === 401 || response.status === 403 || response.status === 404)
              return;
            if (response.ok && response.body) {
              wait = 5_000;
              await readEvents(response.body, (id, record) => {
                last = Math.max(last, id);
                add(record);
              });
            } else wait = Math.min(wait * 2, 60_000);
          } catch {
            if (abort.signal.aborted) return;
            wait = Math.min(wait * 2, 60_000);
          }
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      })();
    }
    return () => abort.abort();
  }, [timeline.slug, repos, live]);
  return { records, live };
}

/** The latest step per agent, with when it started working in this feed's window. */
export function latestByAgent(records: StepFeedRecord[]) {
  const byAgent = new Map<string, { latest: StepFeedRecord; since: string; steps: number }>();
  for (const record of records) {
    const seen = byAgent.get(record.author.id);
    if (!seen) byAgent.set(record.author.id, { latest: record, since: record.at, steps: 1 });
    else {
      seen.steps += 1;
      if (record.at < seen.since) seen.since = record.at;
    }
  }
  return [...byAgent.values()].sort((a, b) => b.latest.at.localeCompare(a.latest.at));
}

/** The feed is the page's (useStepFeed), shared with the timeline's observability view. */
export function LiveNow({
  owner,
  timeline,
  feed,
}: {
  owner: string;
  timeline: Timeline;
  feed: ReturnType<typeof useStepFeed>;
}) {
  const { records, live } = feed;
  // Relative times move on.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!live) return null;
  const agents = latestByAgent(records);
  const story = `/tracker/${encodeURIComponent(owner)}/timelines/${encodeURIComponent(timeline.slug)}/story`;
  return (
    <section aria-label="Live now">
      <h3 className="mt-4 mb-1 text-body-sm font-semibold text-ink-muted">Live now</h3>
      {agents.length === 0 ? (
        <p className="m-0 text-body-sm text-ink-faint">
          No steps yet. An agent&rsquo;s steps show here seconds after{" "}
          <span className="mk-mono">gm step</span>.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {agents.map(({ latest, since, steps }) => {
            const params = new URLSearchParams({ step: latest.commitOid, repo: latest.repo });
            return (
              <li
                key={latest.author.id}
                className="border-t border-line-soft py-1.5 text-body-sm first:border-t-0"
              >
                <div className="flex items-baseline gap-1.5">
                  {latest.author.kind === "agent" && (
                    <RobotIcon className="shrink-0 self-center text-ink-faint" aria-hidden />
                  )}
                  <span className="shrink-0 font-semibold">{latest.author.name}</span>
                  <Link className={`${link} min-w-0 flex-1 truncate`} to={`${story}?${params}`}>
                    {latest.summary || "(no summary)"}
                  </Link>
                </div>
                <div className="flex flex-wrap gap-x-2 text-micro text-ink-faint">
                  <time dateTime={latest.at} title={fullDate(latest.at)}>
                    {timeAgo(latest.at)}
                  </time>
                  {latest.tests && (
                    <span className={latest.tests.failed ? "text-danger-text" : "text-online"}>
                      {latest.tests.failed
                        ? `${latest.tests.failed} failed`
                        : `${latest.tests.passed} passed`}
                    </span>
                  )}
                  <span title={fullDate(since)}>
                    {steps} {steps === 1 ? "step" : "steps"} since {timeAgo(since)}
                  </span>
                  {timeline.repos.length > 1 && <span>{latest.repo}</span>}
                </div>
                {latest.why && (
                  <p className="m-0 text-micro text-ink-muted [overflow-wrap:anywhere]">
                    {latest.why}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
