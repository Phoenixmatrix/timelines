// Needs you: what agents (and people) are waiting on from a person, across every
// tracker you're in. Requests routed to you come first; anyone with access can
// answer the rest.

import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type { Mutation, OpenRequest, OpenRequests } from "../../shared/tracker.ts";
import { Page } from "../components/AppShell.tsx";
import { api, ApiError, load } from "../lib/api.ts";
import { requireViewer, useViewer } from "../lib/session.ts";
import { RequestCard, type Answer } from "./tracker/Requests.tsx";

export async function needsYouLoader({ request }: LoaderFunctionArgs) {
  await requireViewer(request);
  return load<OpenRequests>("/requests", request);
}

export function NeedsYou() {
  const { requests, names } = useLoaderData<typeof needsYouLoader>();
  const viewer = useViewer();
  const revalidator = useRevalidator();
  const mine = requests.filter((item) => item.request.routeTo === viewer?.id);
  const others = requests.filter((item) => item.request.routeTo !== viewer?.id);
  const name = (id: string) => (id === viewer?.id ? "you" : (names[id] ?? id));

  const send = async (item: OpenRequest, mutation: Mutation) => {
    try {
      await api(`/tracker/${encodeURIComponent(item.tracker.slug)}/mutate`, {
        method: "POST",
        json: { operationId: crypto.randomUUID(), mutations: [mutation] },
      });
      await revalidator.revalidate();
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
      heading={
        <Link
          to={`/tracker/${encodeURIComponent(item.tracker.slug)}/issues/${encodeURIComponent(item.issue.id)}`}
          className="flex min-w-0 items-baseline gap-2 text-ink no-underline hover:underline"
        >
          <span className="font-mono text-body-sm text-ink-muted">{item.issue.key}</span>
          <span className="truncate font-semibold">{item.issue.title}</span>
        </Link>
      }
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
      <h1 className="m-0 text-headline">Needs you</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        Questions, approvals, decisions and credentials agents are waiting on. Their work stays
        theirs while they wait; answering lets them pick it back up. Approving a timeline checkpoint
        approves exactly those commits: new ones need a new approval.
      </p>
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
