import { Popover } from "@base-ui/react/popover";
import { ArrowClockwiseIcon, CaretDownIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import {
  Link,
  Outlet,
  useLoaderData,
  useLocation,
  useRevalidator,
  useRouteLoaderData,
  type LoaderFunctionArgs,
} from "react-router";
import type { RepoDetail } from "../../../shared/api.ts";
import { Page } from "../../components/AppShell.tsx";
import { CopyField, RoleChip, VisibilityChip } from "../../components/ui.tsx";
import { loadRepo } from "../../lib/api.ts";
import { commitsUrl, repoPath } from "../../lib/refs.ts";
import { useViewer } from "../../lib/session.ts";

export async function repoLoader({ request, params }: LoaderFunctionArgs) {
  return loadRepo(params.owner ?? "", params.repo ?? "", request);
}

export function useRepo(): RepoDetail {
  return useRouteLoaderData("repo") as RepoDetail;
}

/** A tab is current for every page under its sections, e.g. Code for tree/ and blob/. */
function Tab({
  to,
  sections,
  children,
}: {
  to: string;
  sections: string[];
  children: React.ReactNode;
}) {
  const { pathname } = useLocation();
  const current = sections.some((section) =>
    section === "" ? pathname === to : pathname.startsWith(section),
  );
  return (
    <Link
      to={to}
      aria-current={current ? "page" : undefined}
      className="-mb-px border-b-2 border-transparent px-1 pb-2.5 font-semibold text-ink-muted no-underline transition-colors hover:text-ink aria-[current=page]:border-signal-line aria-[current=page]:text-ink"
    >
      {children}
    </Link>
  );
}

function ClonePopover({ repo }: { repo: RepoDetail }) {
  const viewer = useViewer();
  const canPush = repo.viewerRole === "write" || repo.viewerRole === "admin";
  return (
    <Popover.Root>
      <Popover.Trigger className="mk-btn mk-btn--primary">
        <TerminalWindowIcon weight="bold" aria-hidden />
        Clone
        <CaretDownIcon weight="bold" className="size-3.5" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className="mk-popup gm-pop w-[min(26rem,calc(100vw-2rem))] p-4">
            <Popover.Title className="m-0 text-title">Clone over HTTPS</Popover.Title>
            <div className="mt-3">
              <CopyField value={repo.cloneUrl} label="Clone URL" />
            </div>
            <Popover.Description className="mt-3 mb-0 text-body-sm text-ink-muted">
              {viewer ? (
                <>
                  When git asks, sign in as <strong className="text-ink">{viewer.slug}</strong> with
                  a{" "}
                  <Link to="/settings/tokens" className="gm-link">
                    personal access token
                  </Link>{" "}
                  as the password.{" "}
                  {canPush ? "You can push to this repository." : "You can clone but not push."}
                </>
              ) : repo.visibility === "public" ? (
                "Public repositories clone without signing in. Pushing needs a persona with write access."
              ) : null}
            </Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function RepoLayout() {
  const repo = useLoaderData<typeof repoLoader>();
  const revalidator = useRevalidator();
  const base = repoPath(repo.owner.slug, repo.name);

  return (
    <Page wide>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 flex flex-wrap items-baseline gap-x-2 text-headline">
            <Link
              to={`/${repo.owner.slug}`}
              className="font-normal text-ink-muted no-underline hover:text-ink"
            >
              {repo.owner.slug}
            </Link>
            <span className="font-normal text-ink-faint">/</span>
            <Link to={base} className="text-ink no-underline">
              <bdi>{repo.name}</bdi>
            </Link>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <VisibilityChip visibility={repo.visibility} />
            <RoleChip role={repo.viewerRole} />
            {repo.importedFrom && (
              <span className="text-body-sm text-ink-faint">
                Imported from{" "}
                <span className="mk-mono">{repo.importedFrom.replace(/^https:\/\//, "")}</span>
              </span>
            )}
          </div>
          {repo.description && (
            <p className="mt-2 mb-0 max-w-[60ch] text-ink-muted" dir="auto">
              {repo.description}
            </p>
          )}
        </div>
        {repo.state === "ready" && <ClonePopover repo={repo} />}
      </header>

      {repo.state === "importing" ? (
        <div className="mk-strip mt-6">
          <span className="mk-strip-dot" />
          <span className="mk-strip-text">Still importing. Large histories can take a minute.</span>
          <button
            type="button"
            className="mk-btn mk-btn--sm"
            onClick={() => revalidator.revalidate()}
            disabled={revalidator.state !== "idle"}
          >
            <ArrowClockwiseIcon weight="bold" aria-hidden />
            Check again
          </button>
        </div>
      ) : (
        <>
          <nav aria-label="Repository" className="mt-6 flex gap-5 border-b border-line-soft">
            <Tab to={base} sections={["", `${base}/tree/`, `${base}/blob/`]}>
              Code
            </Tab>
            {repo.head && (
              <Tab
                to={commitsUrl(repo.owner.slug, repo.name, repo.defaultBranch)}
                sections={[`${base}/commits/`]}
              >
                Commits
              </Tab>
            )}
            {repo.viewerRole === "admin" && (
              <Tab to={`${base}/settings`} sections={[`${base}/settings`]}>
                Settings
              </Tab>
            )}
          </nav>
          <div className="mt-6">
            <Outlet />
          </div>
        </>
      )}
    </Page>
  );
}
