// An issue's linked work (CORE-250), in the Chronicle's inspector and on the
// issue page (CORE-22): what its work produced, by kind, each item opening
// its existing page; with a work span selected, what was made during it
// first. Commits whose message names the issue follow as "Mentioned in",
// labelled as mentions and kept apart from the evidence above, each with its
// own CI runs and packages; their SHAs open the commit panel (`?commit=`).

import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { LinkedWork, WorkMention, WorkSpan } from "../../../shared/chronicle.ts";
import { api, ApiError } from "../../lib/api.ts";
import { day } from "./chronicleModel.ts";

const time = (iso: string) => Date.parse(iso);
const short = (oid: string) => oid.slice(0, 7);

type WorkState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; work: LinkedWork };

type Item = {
  group: string;
  key: string;
  label: string;
  meta: string;
  href: string;
  at: string | null;
  external?: boolean;
};

const GROUPS = [
  "Agent work",
  "Commits",
  "CI runs",
  "Deployments",
  "Packages",
  "Timelines",
  "Release notes",
];

const ROW = "block rounded-plate px-2 py-1 text-body-sm no-underline hover:bg-raised max-sm:py-2";

function items(w: LinkedWork): Item[] {
  return [
    ...w.steps.map((s) => ({
      group: "Agent work",
      key: `step:${s.repo.id}:${s.commitOid}`,
      label: s.summary || s.commitOid.slice(0, 10),
      meta: `${s.repo.owner}/${s.repo.name} · ${short(s.commitOid)} · ${s.author.name ?? s.author.id}${s.verified ? "" : " · unverified"}`,
      href: s.href,
      at: s.committedAt,
    })),
    ...w.commits.map((c) => ({
      group: "Commits",
      key: `commit:${c.repo.id}:${c.oid}`,
      label: c.summary ?? `Commit ${short(c.oid)}`,
      meta: `${c.repo.owner}/${c.repo.name} · ${short(c.oid)} · ${c.sources.join(", ")}`,
      href: c.href,
      at: c.at,
    })),
    ...w.runs.map((r) => ({
      group: "CI runs",
      key: `run:${r.repo.id}:${r.number}`,
      label: `Run #${r.number} ${r.title ? `· ${r.title}` : ""}`,
      meta: `${r.repo.owner}/${r.repo.name} · ${r.status} · ${r.kind}`,
      href: r.href,
      at: r.createdAt,
    })),
    ...w.deployments.map((d) => ({
      group: "Deployments",
      key: `deploy:${d.id}`,
      label: d.environment,
      meta: `${d.repo.owner}/${d.repo.name} · ${d.status} · ${short(d.commit)}`,
      href: d.href,
      at: d.createdAt,
      external: /^https?:/.test(d.href),
    })),
    ...w.packages.map((p) => ({
      group: "Packages",
      key: `package:${p.format}:${p.name}:${p.version}`,
      label: `${p.name}@${p.version}`,
      meta: `${p.format} · from ${short(p.commit)}`,
      href: p.href,
      at: p.at,
    })),
    ...w.timelines.flatMap((t) => [
      ...t.checkpoints.map((cp) => ({
        group: "Timelines",
        key: `cp:${cp.id}`,
        label: `${t.slug} · checkpoint #${cp.number}`,
        meta: `${cp.approval ?? "no approval"}${cp.summary ? ` · ${cp.summary}` : ""}`,
        href: cp.href,
        at: cp.createdAt,
      })),
      ...t.landings.map((l) => ({
        group: "Timelines",
        key: `landing:${l.id}`,
        label: `${t.slug} · landing of #${l.checkpointNumber}`,
        meta: l.state,
        href: l.href,
        at: l.updatedAt,
      })),
      ...(t.checkpoints.length || t.landings.length
        ? []
        : [
            {
              group: "Timelines",
              key: `timeline:${t.id}`,
              label: t.name || t.slug,
              meta: t.status,
              href: t.href,
              at: null,
            },
          ]),
    ]),
    ...w.releaseNotes.map((n) => ({
      group: "Release notes",
      key: `note:${n.repo.id}:${n.release}:${n.title}`,
      label: n.title,
      meta: `${n.repo.owner}/${n.repo.name} · ${n.label} · ${n.category}`,
      href: n.href,
      at: n.shippedAt,
    })),
  ];
}

function ItemRow({ item }: { item: Item }) {
  const body = (
    <>
      <span className="flex items-center gap-1 truncate text-ink">
        {item.label}
        {item.external && (
          <ArrowSquareOutIcon className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        )}
      </span>
      <span className="block truncate text-micro text-ink-faint">{item.meta}</span>
    </>
  );
  return (
    <li data-linked-work={item.group}>
      {item.external ? (
        <a href={item.href} target="_blank" rel="noreferrer" className={ROW}>
          {body}
        </a>
      ) : (
        <Link to={item.href} className={ROW}>
          {body}
        </Link>
      )}
    </li>
  );
}

/** A mentioning commit, then its runs and packages, indented under it. */
function MentionRow({ mention }: { mention: WorkMention }) {
  const repo = `${mention.repo.owner}/${mention.repo.name}`;
  const at = mention.committedAt ?? mention.pushedAt;
  return (
    <li data-linked-work="Mentioned in" data-commit={mention.oid}>
      <Link
        to={mention.href}
        className={ROW}
        aria-label={`Commit ${short(mention.oid)} in ${repo}: ${mention.title || "no message"}`}
      >
        <span className="block truncate text-ink">
          {mention.title || `Commit ${short(mention.oid)}`}
        </span>
        <span className="block truncate text-micro text-ink-faint">
          {repo} · <span className="mk-mono">{short(mention.oid)}</span> ·{" "}
          <time dateTime={at}>{day(time(at))}</time>
        </span>
      </Link>
      {(mention.runs.length > 0 || mention.packages.length > 0) && (
        <ul className="m-0 mb-1 ml-3 flex list-none flex-col border-l border-line-soft p-0 pl-1">
          {mention.runs.map((run) => (
            <li key={`run:${run.number}`} data-linked-work="Mentioned in run">
              <Link to={run.href} className={ROW}>
                <span className="block truncate text-ink">
                  Run <span className="mk-mono">#{run.number}</span>
                </span>
                <span className="block truncate text-micro text-ink-faint">
                  {run.status} · {run.kind}
                </span>
              </Link>
            </li>
          ))}
          {mention.packages.map((p) => (
            <li
              key={`package:${p.format}:${p.name}:${p.version}`}
              data-linked-work="Mentioned in package"
            >
              <Link to={p.href} className={ROW}>
                <span className="block truncate text-ink">
                  <span className="mk-mono">
                    {p.name}@{p.version}
                  </span>
                </span>
                <span className="block truncate text-micro text-ink-faint">{p.format} package</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Linked work, loaded when an issue opens. `headingClassName` styles the
 * section headings so the panel matches where it sits.
 */
export function LinkedWorkPanel({
  owner,
  issueId,
  issueKey,
  span = null,
  now = Date.now(),
  headingClassName = "m-0 text-label text-ink-muted",
}: {
  owner: string;
  issueId: string;
  issueKey: string;
  span?: WorkSpan | null;
  now?: number;
  headingClassName?: string;
}) {
  const [work, setWork] = useState<WorkState>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setWork({ state: "loading" });
    api<LinkedWork>(
      `/tracker/${encodeURIComponent(owner)}/issues/${encodeURIComponent(issueId)}/work`,
      { signal: controller.signal },
    )
      .then((value) => setWork({ state: "ready", work: value }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setWork({
          state: "error",
          message:
            cause instanceof ApiError ? cause.message : "Couldn't load this issue's linked work.",
        });
      });
    return () => controller.abort();
  }, [owner, issueId]);

  if (work.state === "loading")
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <h3 className={headingClassName}>Linked work</h3>
        <div className="h-16 animate-pulse rounded-plate bg-surface motion-reduce:animate-none" />
      </div>
    );
  if (work.state === "error")
    return (
      <div className="flex flex-col gap-1">
        <h3 className={headingClassName}>Linked work</h3>
        <p className="m-0 text-body-sm text-danger-text">{work.message}</p>
      </div>
    );
  const w = work.work;
  const mentions = w.mentions ?? [];
  // With a span: what was made while it held (and shortly after), first.
  const during = (at: string | null) => {
    if (!span || !at) return true;
    const t = time(at);
    const end = span.end ? time(span.end) : now;
    return t >= time(span.start) - 5 * 60_000 && t <= end + 60 * 60_000;
  };
  const all = items(w);
  const mentionAt = (m: WorkMention) => m.committedAt ?? m.pushedAt;
  const render = (subset: Item[], mentioned: WorkMention[], heading: string) => (
    <div className="flex flex-col gap-3">
      <h3 className={headingClassName}>{heading}</h3>
      {GROUPS.map((group) => ({ group, entries: subset.filter((item) => item.group === group) }))
        .filter((g) => g.entries.length)
        .map(({ group, entries }) => (
          <div key={group}>
            <h4 className="m-0 mb-0.5 px-2 text-micro font-semibold text-ink-faint">{group}</h4>
            <ul className="m-0 flex list-none flex-col p-0">
              {entries.map((item) => (
                <ItemRow key={item.key} item={item} />
              ))}
            </ul>
          </div>
        ))}
      {mentioned.length > 0 && (
        <div data-linked-work-mentions>
          <h4 className="m-0 px-2 text-micro font-semibold text-ink-faint">Mentioned in</h4>
          <p className="m-0 mb-0.5 max-w-[44ch] px-2 text-micro text-ink-faint">
            Commits whose message names {issueKey}. A mention, not evidence of the work.
          </p>
          <ul className="m-0 flex list-none flex-col p-0">
            {mentioned.map((m) => (
              <MentionRow key={`${m.repo.id}:${m.oid}`} mention={m} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
  if (!all.length && !mentions.length)
    return (
      <div className="flex flex-col gap-1">
        <h3 className={headingClassName}>Linked work</h3>
        <p className="m-0 max-w-[44ch] px-2 text-body-sm text-ink-faint">
          Nothing names {issueKey} yet: no step context, release-note entry, timeline that worked it
          or commit message that mentions it. Steps link to an issue when{" "}
          <code className="mk-mono">gm</code> records the commit's context with the issue it was
          for; a commit links when its message names <span className="mk-mono">{issueKey}</span>.
        </p>
      </div>
    );
  return (
    <div className="flex flex-col gap-4" data-chronicle-linked-work>
      {span ? (
        <>
          {all.some((item) => during(item.at)) || mentions.some((m) => during(mentionAt(m))) ? (
            render(
              all.filter((item) => during(item.at)),
              mentions.filter((m) => during(mentionAt(m))),
              "Linked work during this span",
            )
          ) : (
            <p className="m-0 px-2 text-body-sm text-ink-faint">
              Nothing linked was made during this span.
            </p>
          )}
          {(all.some((item) => !during(item.at)) || mentions.some((m) => !during(mentionAt(m)))) &&
            render(
              all.filter((item) => !during(item.at)),
              mentions.filter((m) => !during(mentionAt(m))),
              "Other linked work",
            )}
        </>
      ) : (
        render(all, mentions, "Linked work")
      )}
      {w.truncated && (
        <p className="m-0 px-2 text-micro text-ink-faint">Showing the newest of each kind.</p>
      )}
    </div>
  );
}
