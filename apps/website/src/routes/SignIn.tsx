import { ArrowRightIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";
import type { Persona, RepoSummary } from "../../shared/api.ts";
import { Monogram } from "../components/Monogram.tsx";
import { FormError } from "../components/ui.tsx";
import { api, attempt, load } from "../lib/api.ts";
import { useViewer } from "../lib/session.ts";

export async function signInLoader({ request }: { request: Request }) {
  const [{ personas }, { repos }] = await Promise.all([
    load<{ personas: Persona[] }>("/personas", request),
    load<{ repos: RepoSummary[] }>("/repos", request),
  ]);
  return { personas, hasRepos: repos.length > 0 };
}

function safeNext(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export async function signInAction({ request }: { request: Request }) {
  const url = new URL(request.url);
  const form = await request.formData();
  const intent = url.searchParams.get("intent") ?? form.get("intent");

  if (intent === "signout") {
    await api("/session", { method: "DELETE" });
    return redirect("/signin");
  }
  if (intent === "seed") {
    return attempt(() => api("/dev/seed", { method: "POST" }));
  }
  const result = await attempt(() =>
    api("/session", { method: "POST", json: { accountId: form.get("accountId") } }),
  );
  if ("error" in (result as object)) return result;
  return redirect(safeNext(url.searchParams.get("next")));
}

export function SignIn() {
  const { personas, hasRepos } = useLoaderData<typeof signInLoader>();
  const viewer = useViewer();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const seeding = navigation.formData?.get("intent") === "seed";
  const pendingId = navigation.formData?.get("accountId");

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-8 sm:py-16">
      <h1 className="m-0 text-headline">Choose a persona</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        Real sign-in comes later. Each persona has different access, so you can watch the permission
        rules at work, in the browser and over git.
      </p>

      {!hasRepos && (
        <Form method="post" className="mk-strip mt-6">
          <span className="mk-strip-dot" />
          <span className="mk-strip-text">
            There are no repositories yet. Load four samples to try each persona.
          </span>
          <input type="hidden" name="intent" value="seed" />
          <button className="mk-btn mk-btn--primary mk-btn--sm" disabled={seeding}>
            {seeding ? "Importing…" : "Load samples"}
          </button>
        </Form>
      )}

      <ul className="mt-6 grid list-none gap-3 p-0 sm:grid-cols-2">
        {personas.map((persona) => {
          const current = viewer?.id === persona.id;
          return (
            <li key={persona.id}>
              <Form method="post" action={`/signin?${params.toString()}`} className="h-full">
                <input type="hidden" name="accountId" value={persona.id} />
                <button
                  className="group flex h-full w-full cursor-pointer flex-col items-start gap-3 rounded-pane border-0 bg-pane p-5 text-left text-ink transition-colors hover:bg-raised"
                  aria-current={current ? "true" : undefined}
                  disabled={pendingId === persona.id}
                >
                  <span className="flex w-full items-center gap-3">
                    <Monogram name={persona.displayName} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">
                        <bdi>{persona.displayName}</bdi>
                      </span>
                      <span className="block text-body-sm text-ink-faint">@{persona.slug}</span>
                    </span>
                    {persona.isSiteAdmin && (
                      <ShieldCheckIcon className="size-5 text-ink-muted" aria-label="Site admin" />
                    )}
                  </span>
                  <span className="text-body-sm text-ink-muted">{persona.bio}</span>
                  <span className="mt-auto inline-flex items-center gap-1.5 text-body-sm font-semibold text-ink-muted group-hover:text-ink">
                    {current
                      ? "Signed in as this persona"
                      : `Continue as ${persona.displayName.split(" ")[0]}`}
                    {!current && <ArrowRightIcon weight="bold" aria-hidden />}
                  </span>
                </button>
              </Form>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {viewer ? (
          <Form method="post" action="/signin?intent=signout">
            <button className="mk-btn mk-btn--ghost">
              Sign out and browse public repositories
            </button>
          </Form>
        ) : (
          <Link to="/" className="mk-btn mk-btn--ghost no-underline">
            Browse public repositories without signing in
          </Link>
        )}
      </div>
      <SignInErrors />
    </div>
  );
}

function SignInErrors() {
  const actionData = useActionData<{ error?: string } | undefined>();
  return (
    <div className="mt-4">
      <FormError message={actionData?.error} />
    </div>
  );
}
