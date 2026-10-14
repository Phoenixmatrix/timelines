import { PlusIcon } from "@phosphor-icons/react";
import { Link, useLoaderData } from "react-router";
import type { RepoSummary } from "../../shared/api.ts";
import { Page } from "../components/AppShell.tsx";
import { RepoList } from "../components/RepoList.tsx";
import { GitmatrixLogo } from "../components/GitmatrixLogo.tsx";
import { load } from "../lib/api.ts";
import { greeting } from "../lib/format.ts";
import { loadSession, useViewer } from "../lib/session.ts";

export async function homeLoader({ request }: { request: Request }) {
  const [{ repos }, { viewer }] = await Promise.all([
    load<{ repos: RepoSummary[] }>("/repos", request),
    loadSession(request),
  ]);
  // The session lists exactly the Spaces the viewer holds a live grant in (the
  // access /spaces/:space reports as canCreateRepository), and its default is
  // always one of them; creating still authorizes on the server.
  const creationSpace = viewer?.spaces.find((space) => space.id === viewer.defaultSpaceId) ?? null;
  return { repos, creationSpace };
}

export function Home() {
  const { repos, creationSpace } = useLoaderData<typeof homeLoader>();
  const viewer = useViewer();

  return (
    <Page>
      <GitmatrixLogo className="mb-8 h-10 w-auto" />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-headline">
            {viewer ? (
              <>
                {greeting()}, <bdi>{viewer.displayName.split(" ")[0]}</bdi>
              </>
            ) : (
              "Public repositories"
            )}
          </h1>
          <p className="mt-1.5 mb-0 text-ink-muted">
            {viewer
              ? "Every repository you can read, most recently pushed first."
              : "You're browsing signed out, so only public repositories show."}
          </p>
        </div>
        {creationSpace ? (
          <Link
            to={`/${encodeURIComponent(creationSpace.slug)}/-/repositories/new`}
            className="mk-btn mk-btn--primary no-underline"
          >
            <PlusIcon weight="bold" aria-hidden />
            New repository
          </Link>
        ) : !viewer ? (
          <Link to="/signin" className="mk-btn mk-btn--primary no-underline">
            Sign in
          </Link>
        ) : null}
      </header>

      <div className="mt-8">
        <RepoList
          repos={repos}
          empty={
            <>
              No repositories yet.
              <br />
              <span className="text-body-sm text-ink-faint">
                {creationSpace
                  ? "Create one to get started."
                  : viewer
                    ? "Open a Space to see its repositories."
                    : "Sign in to see private ones."}
              </span>
            </>
          }
        />
      </div>
    </Page>
  );
}
