// Needs you: what agents (and people) are waiting on from a person, across every
// tracker you're in. Requests routed to you come first; anyone with access can
// answer the rest. Each says what the work behind it is doing (CORE-386), and
// History (?view=history) keeps the answered and withdrawn ones (CORE-387).

import { useState } from "react";
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type {
  Mutation,
  OpenRequest,
  OpenRequests,
  RequestHistory,
  Snapshot,
} from "../../shared/tracker.ts";
import { Page } from "../components/AppShell.tsx";
import { FormError } from "../components/ui.tsx";
import { api, ApiError, load } from "../lib/api.ts";
import { requireViewer, useViewer } from "../lib/session.ts";
import { NEEDS_YOU_CHANGED } from "../lib/needs-you.ts";
import { RequestCard, type Answer } from "./tracker/Requests.tsx";

export async function needsYouLoader({ request }: LoaderFunctionArgs) {
  await requireViewer(request);
  if (new URL(request.url).searchParams.get("view") === "history")
    return {
      view: "history" as const,
      ...(await load<RequestHistory>("/requests/history", request)),
    };
  return { view: "waiting" as const, ...(await load<OpenRequests>("/requests", request)) };
}

/** Waiting and History, as links: each view has its own address. */
function Views({ current }: { current: "waiting" | "history" }) {
  const views = [
    { value: "waiting", label: "Waiting", to: "/needs-you" },
    { value: "history", label: "History", to: "/needs-you?view=history" },
  ] as const;
  return (
    <nav aria-label="Requests" className="mk-segmented mt-6">
      {views.map((view) => (
        <Link
          key={view.value}
          to={view.to}
          className="mk-segment no-underline"
          aria-current={view.value === current ? "page" : undefined}
        >
          {view.label}
        </Link>
      ))}
    </nav>
  );
}

export function NeedsYou() {
  const data = useLoaderData<typeof needsYouLoader>();
  if (data.view === "history") return <History initial={data} />;
  return <Waiting {...data} />;
}

function Waiting({ requests, names }: OpenRequests) {
  const viewer = useViewer();
  const revalidator = useRevalidator();
  const mine = requests.filter((item) => item.request.routeTo === viewer?.id);
  const others = requests.filter((item) => item.request.routeTo !== viewer?.id);
  const name = (id: string) => (id === viewer?.id ? "you" : (names[id] ?? id));

  const send = async (item: OpenRequest, mutation: Mutation) => {
    try {
      const snapshot = await api<Snapshot>(
        `/tracker/${encodeURIComponent(item.tracker.slug)}/snapshot`,
      );
      await api(`/tracker/${encodeURIComponent(item.tracker.slug)}/mutate`, {
        method: "POST",
        json: {
          contractVersion: snapshot.contractVersion,
          spaceId: snapshot.spaceId,
          migrationEpoch: snapshot.migrationEpoch,
          operationId: crypto.randomUUID(),
          mutations: [mutation],
        },
      });
      await revalidator.revalidate();
      // The rail's count follows what was just answered or cancelled.
      window.dispatchEvent(new Event(NEEDS_YOU_CHANGED));
      return { ok: true };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof ApiError ? cause.message : "That didn't go through.",
      };
    }
  };
  const card = (item: OpenRequest) => (
    <RequestCard
      key={item.request.id}
      request={item.request}
      name={name}
      checkpoint={item.checkpoint && { view: item.checkpoint, tracker: item.tracker.slug }}
      work={item.work}
      approvesWhenGreen={item.approvesWhenGreen}
      heading={<IssueLink item={item} />}
      onAnswer={(answer: Answer) =>
        send(item, { kind: "request.answer", id: item.request.id, data: answer })
      }
      onCancel={
        item.request.askedBy === viewer?.id
          ? () => send(item, { kind: "request.cancel", id: item.request.id })
          : undefined
      }
    />
  );

  return (
    <Page>
      <Intro />
      <Views current="waiting" />
      <section className="mt-8" aria-labelledby="for-you">
        <h2 id="for-you" className="m-0 mb-3 text-title">
          For you
        </h2>
        {mine.length === 0 ? (
          <p className="mk-empty m-0">Nothing is waiting on you.</p>
        ) : (
          <div className="flex flex-col gap-3">{mine.map(card)}</div>
        )}
      </section>
      {others.length > 0 && (
        <section className="mt-10" aria-labelledby="others">
          <h2 id="others" className="m-0 mb-3 text-title">
            For others in your trackers
          </h2>
          <div className="flex flex-col gap-3">{others.map(card)}</div>
        </section>
      )}
    </Page>
  );
}

function Intro() {
  return (
    <>
      <h1 className="m-0 text-headline">Needs you</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        Questions, approvals, decisions and credentials agents are waiting on. Their work stays
        theirs while they wait; answering lets them pick it back up. Approving a timeline checkpoint
        approves exactly those commits: new ones need a new approval.
      </p>
    </>
  );
}

/** The issue a request is about, linked. */
function IssueLink({ item }: { item: OpenRequest }) {
  return (
    <Link
      to={`/tracker/${encodeURIComponent(item.tracker.slug)}/issues/${encodeURIComponent(item.issue.id)}`}
      className="flex min-w-0 items-baseline gap-2 text-ink no-underline hover:underline"
    >
      <span className="font-mono text-body-sm text-ink-muted">{item.issue.key}</span>
      <span className="truncate font-semibold">{item.issue.title}</span>
    </Link>
  );
}

/**
 * Answered and withdrawn requests, newest first (CORE-387): each with its
 * answer, and what was said on the issue after it. Older ones a page at a time.
 */
function History({ initial }: { initial: RequestHistory }) {
  const viewer = useViewer();
  const [pages, setPages] = useState({ ...initial, key: initial });
  // A new loader result (navigating back here) starts over.
  const current = pages.key === initial ? pages : { ...initial, key: initial };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => (id === viewer?.id ? "you" : (current.names[id] ?? id));
  const older = async () => {
    if (!current.next) return;
    setLoading(true);
    setError(null);
    try {
      const page = await api<RequestHistory>(
        `/requests/history?before=${encodeURIComponent(current.next)}`,
      );
      setPages({
        requests: [...current.requests, ...page.requests],
        names: { ...current.names, ...page.names },
        next: page.next,
        key: initial,
      });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Couldn't load older requests.");
    } finally {
      setLoading(false);
    }
  };
  return (
    <Page>
      <Intro />
      <Views current="history" />
      <section className="mt-8" aria-labelledby="history">
        <h2 id="history" className="m-0 mb-3 text-title">
          Answered and withdrawn
        </h2>
        {current.requests.length === 0 ? (
          <p className="mk-empty m-0">Nothing has been answered or withdrawn yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {current.requests.map((item) => (
              <RequestCard
                key={item.request.id}
                request={item.request}
                name={name}
                work={item.work}
                heading={<IssueLink item={item} />}
                // Closed: nothing to answer.
                onAnswer={async () => ({ ok: false })}
              />
            ))}
          </div>
        )}
        <div className="mt-3">
          <FormError message={error} />
        </div>
        {current.next && (
          <button
            type="button"
            className="mk-btn mk-btn--secondary mt-4 min-h-11"
            onClick={() => void older()}
            disabled={loading}
          >
            {loading ? "Loading…" : "Show older"}
          </button>
        )}
      </section>
    </Page>
  );
}
