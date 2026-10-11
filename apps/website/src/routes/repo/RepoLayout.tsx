import { Popover } from "@base-ui/react/popover";
import { useEffect, useRef } from "react";
import { ArrowClockwiseIcon, CaretDownIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import {
  Link,
  Outlet,
  useLoaderData,
  useLocation,
  useRevalidator,
  useRouteLoaderData,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { RepoDetail } from "../../../shared/api.ts";
import { Page } from "../../components/AppShell.tsx";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { CopyField, RoleChip, VisibilityChip, link, popMotion } from "../../components/ui.tsx";
import { forgetRepoData, repoData, requestSource, routeData } from "../../lib/repoData.ts";
import { repoPath, sourceUrl } from "../../lib/refs.ts";
import { repoSections } from "../../lib/repoSections.ts";
import { useRememberPlace } from "../../lib/recentPlaces.ts";
import { useViewer } from "../../lib/session.ts";
import { CommitPanel } from "./CommitPanel.tsx";

export async function repoLoader({ params, request }: LoaderFunctionArgs) {
  const owner = params.owner ?? "";
  const name = params.repo ?? "";
  const pathname = new URL(request.url).pathname;
  const releases = repoPath(owner, name, "releases");
  // Landed notes outlive their work source; the layout must not read that source either.
  const source =
    pathname === releases || pathname.startsWith(`${releases}/`)
      ? null
      : await requestSource(owner, name, request);
  return routeData(repoData.detail(owner, name, source, true));
}

/**
 * Moving around inside one repository doesn't refetch its branches; entering
 * it, submitting a form or an explicit revalidation does.
 */
export function repoShouldRevalidate({
  currentParams,
  nextParams,
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return (
    currentParams.owner !== nextParams.owner ||
    currentParams.repo !== nextParams.repo ||
    currentUrl.searchParams.get("source") !== nextUrl.searchParams.get("source") ||
    currentUrl.searchParams.get("tl") !== nextUrl.searchParams.get("tl")
  );
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
    section === "" ? pathname === to.split("?")[0] : pathname.startsWith(section),
  );
  // On narrow screens the tab row scrolls; keep the current tab in it.
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);
  return (
    <PrefetchLink
      ref={ref}
      to={to}
      aria-current={current ? "page" : undefined}
      className="-mb-px shrink-0 border-b-2 border-transparent px-1 pb-2.5 font-semibold text-ink-muted no-underline transition-colors hover:text-ink aria-[current=page]:border-signal-line aria-[current=page]:text-ink"
    >
      {children}
    </PrefetchLink>
  );
}

function ClonePopover({ repo }: { repo: RepoDetail }) {
  const viewer = useViewer();
  const canPush =
    repo.sourceState !== "archived" && (repo.viewerRole === "write" || repo.viewerRole === "admin");
  return (
    <Popover.Root>
      <Popover.Trigger className="mk-btn mk-btn--primary">
        <TerminalWindowIcon weight="bold" aria-hidden />
        Clone
        <CaretDownIcon weight="bold" className="size-3.5" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className={`mk-popup ${popMotion} w-[min(26rem,calc(100vw-2rem))] p-4`}>
            <Popover.Title className="m-0 text-title">Clone over HTTPS</Popover.Title>
            <div className="mt-3">
              <CopyField value={repo.cloneUrl} label="Clone URL" />
            </div>
            <Popover.Description className="mt-3 mb-0 text-body-sm text-ink-muted">
              {viewer ? (
                <>
                  When git asks, sign in as <strong className="text-ink">{viewer.slug}</strong> with
                  a{" "}
                  <Link to="/settings/tokens" className={link}>
                    personal access token
                  </Link>{" "}
                  as the password.{" "}
                  {repo.sourceState === "archived"
                    ? "This archived source is read-only until retention expires."
                    : canPush
                      ? "You can push to this repository."
                      : "You can clone but not push."}
                </>
              ) : repo.source?.kind === "timeline-work" ? (
                "Work sources require an authorized Timelines account."
              ) : repo.visibility === "public" ? (
                "Public repositories clone without signing in. Pushing needs an account with write access."
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
  useRememberPlace({
    kind: "repo",
    title: `${repo.owner.slug}/${repo.name}`,
    detail: repo.description,
    to: base,
  });
  // Every repository tab uses the same full-width column, so the header and
  // tabs never shift; pages that read better narrow constrain their own content.
  return (
    <Page full>
      <header className="flex items-start justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <h1 className="m-0 flex flex-wrap items-baseline gap-x-2 text-headline">
            <Link
              to={`/${repo.owner.slug}`}
              className="font-normal text-ink-muted no-underline hover:text-ink"
            >
              {repo.owner.slug}
            </Link>
            <span className="font-normal text-ink-faint">/</span>
            <Link to={sourceUrl(base, repo.source?.sourceId)} className="text-ink no-underline">
              <bdi>{repo.name}</bdi>
            </Link>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <VisibilityChip visibility={repo.visibility} />
            <RoleChip role={repo.viewerRole} />
            {repo.source?.kind === "timeline-work" && (
              <>
                <span className="text-body-sm text-ink-muted" title={repo.source.sourceId}>
                  {repo.sourceState === "expired"
                    ? "Expired work source · published data retained"
                    : repo.sourceState === "archived"
                      ? "Archived work source · read-only"
                      : "Timeline work source"}
                </span>
                <Link className={`${link} text-body-sm`} to={`${base}?tl=main`}>
                  Canonical code
                </Link>
              </>
            )}
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
        {repo.state === "ready" && repo.sourceState !== "expired" && <ClonePopover repo={repo} />}
      </header>

      {repo.state === "importing" ? (
        <div className="mk-strip mt-6">
          <span className="mk-strip-dot" />
          <span className="mk-strip-text">Still importing. Large histories can take a minute.</span>
          <button
            type="button"
            className="mk-btn mk-btn--sm"
            onClick={() => {
              forgetRepoData(repo.owner.slug, repo.name);
              void revalidator.revalidate();
            }}
            disabled={revalidator.state !== "idle"}
          >
            <ArrowClockwiseIcon weight="bold" aria-hidden />
            Check again
          </button>
        </div>
      ) : (
        <>
          <nav
            aria-label="Repository"
            className="mt-4 flex gap-5 overflow-x-auto border-b border-line-soft [scrollbar-width:none] max-sm:[mask-image:linear-gradient(to_right,transparent,black_1.25rem,black_calc(100%-1.25rem),transparent)] max-sm:px-3 sm:mt-6"
          >
            {repoSections(repo).map((section) => (
              <Tab key={section.id} to={section.to} sections={section.sections}>
                {section.label}
              </Tab>
            ))}
          </nav>
          <div className="mt-4 sm:mt-6">
            <Outlet />
          </div>
        </>
      )}
      {/* Any repository page with ?commit=<sha> opens the commit over it (CORE-22). */}
      <CommitPanel repo={repo} />
    </Page>
  );
}
