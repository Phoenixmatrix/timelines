import { PlusIcon } from "@phosphor-icons/react";
import { Link, useLoaderData } from "react-router";
import type { RepoSummary } from "../../shared/api.ts";
import { Page } from "../components/AppShell.tsx";
import { RepoList } from "../components/RepoList.tsx";
import { load } from "../lib/api.ts";
import { greeting } from "../lib/format.ts";
import { useViewer } from "../lib/session.ts";

export async function homeLoader({ request }: { request: Request }) {
  return load<{ repos: RepoSummary[] }>("/repos", request);
}

export function Home() {
  const { repos } = useLoaderData<typeof homeLoader>();
  const viewer = useViewer();

  return (
    <Page>
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
        {viewer ? (
          <Link to="/new" className="mk-btn mk-btn--primary no-underline">
            <PlusIcon weight="bold" aria-hidden />
            New repository
          </Link>
        ) : (
          <Link to="/signin" className="mk-btn mk-btn--primary no-underline">
            Sign in
          </Link>
        )}
      </header>

      <div className="mt-8">
        <RepoList
          repos={repos}
          empty={
            <>
              No repositories yet.
              <br />
              <span className="text-body-sm text-ink-faint">
                {viewer ? "Create one to get started." : "Sign in to see private ones."}
              </span>
            </>
          }
        />
      </div>
    </Page>
  );
}
