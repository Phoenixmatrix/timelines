// The app's routes, apart from the browser router (router.tsx) so the
// browser-mode tests can mount them in a memory router.

import { redirect, type RouteObject } from "react-router";
import { AppShell } from "./components/AppShell.tsx";
import { PageTitle, PageTitleError, withPageTitles } from "./components/PageTitle.tsx";
import { keepPageUnderPanel } from "./lib/commitPanel.ts";
import { rootLoader } from "./lib/session.ts";
import { scopeOf, timelineScopeMiddleware } from "./lib/timelineScope.ts";
import { Account, accountLoader } from "./routes/Account.tsx";
import { ErrorPage } from "./routes/ErrorPage.tsx";
import { Home, homeLoader } from "./routes/Home.tsx";
import { NewRepo, newRepoAction, newRepoLoader } from "./routes/NewRepo.tsx";
import { Blob, blobLoader } from "./routes/repo/Blob.tsx";
import { ciAction, ciLoader, CiRun, CiRuns, ciRunLoader } from "./routes/repo/Ci.tsx";
import { Code, codeLoader } from "./routes/repo/Code.tsx";
import { Commits, commitsLoader } from "./routes/repo/Commits.tsx";
import { Atlas, atlasLoader, atlasShouldRevalidate } from "./routes/repo/Atlas.tsx";
import {
  WorkspaceAtlas,
  workspaceAtlasLoader,
  workspaceAtlasShouldRevalidate,
} from "./routes/atlas/WorkspaceAtlas.tsx";
import { RepoPackages, repoPackagesLoader } from "./routes/repo/Packages.tsx";
import { Feeds, feedsAction, feedsLoader } from "./routes/packages/Feeds.tsx";
import { NpmLogin, npmLoginAction, npmLoginLoader } from "./routes/packages/NpmLogin.tsx";
import { AllPackages, allPackagesLoader } from "./routes/packages/AllPackages.tsx";
import { NeedsYou, needsYouLoader } from "./routes/NeedsYou.tsx";
import { OwnerPackages, ownerPackagesLoader } from "./routes/packages/OwnerPackages.tsx";
import { PackageConsole, packageConsoleLoader } from "./routes/packages/PackageConsole.tsx";
import { Wiki, wikiLoader } from "./routes/repo/Wiki.tsx";
import { Releases, releasesLoader } from "./routes/repo/Releases.tsx";
import { TrackerReleases, trackerReleasesLoader } from "./routes/tracker/Releases.tsx";
import { Story, storyLoader } from "./routes/tracker/Story.tsx";
import { TrackerTimelines, trackerTimelinesLoader } from "./routes/tracker/Timelines.tsx";
import { RepoLayout, repoLoader, repoShouldRevalidate } from "./routes/repo/RepoLayout.tsx";
import { Settings, settingsAction, settingsLoader } from "./routes/repo/Settings.tsx";
import { SemanticChanges } from "./routes/repo/SemanticChanges.tsx";
import { SignIn, signInAction, signInLoader } from "./routes/SignIn.tsx";
import { Device, deviceAction, deviceLoader } from "./routes/Device.tsx";
import { Invites, invitesAction, invitesLoader } from "./routes/Invites.tsx";
import { Profile, profileAction, profileLoader } from "./routes/Profile.tsx";
import { Preferences, preferencesLoader } from "./routes/Preferences.tsx";
import { AiProviders, aiProvidersLoader } from "./routes/AiProviders.tsx";
import { AiSettings, aiSettingsLoader } from "./routes/AiSettings.tsx";
import {
  AssistantSkills,
  assistantSkillsAction,
  assistantSkillsLoader,
} from "./routes/AssistantSkills.tsx";
import { SiteAiSettings, siteAiSettingsLoader } from "./routes/SiteAiSettings.tsx";
import { SiteUsage, siteUsageLoader, UsageCosts, usageLoader } from "./routes/UsageCosts.tsx";
import {
  DataRetention,
  retentionLoader,
  SiteRetention,
  siteRetentionLoader,
} from "./routes/DataRetention.tsx";
import { SshKeys, sshKeysAction, sshKeysLoader } from "./routes/SshKeys.tsx";
import { Agents, agentsAction, agentsLoader } from "./routes/Agents.tsx";
import { Tokens, tokensAction, tokensLoader } from "./routes/Tokens.tsx";
import { Tracker, TrackerIndex } from "./routes/tracker/Tracker.tsx";
import {
  releaseNotesIndexLoader,
  timelinesIndexLoader,
  trackerIndexLoader,
  trackerLoader,
} from "./routes/tracker/loaders.ts";
import { RepoTracker, repoTrackerLoader } from "./routes/repo/Tracker.tsx";
import { GoPage, goLoader } from "./refs/GoPage.tsx";

function TitledShell() {
  return (
    <PageTitle>
      <AppShell />
    </PageTitle>
  );
}

function TitledError() {
  return (
    <PageTitleError>
      <ErrorPage />
    </PageTitleError>
  );
}

function RootError() {
  return (
    <PageTitle>
      <TitledError />
    </PageTitle>
  );
}

function InitialPageTitle() {
  return <PageTitle loading>{null}</PageTitle>;
}

/** The app's routes. */
export const routes: RouteObject[] = withPageTitles([
  {
    id: "root",
    // The timeline scope (?tl=) follows every navigation that doesn't name one.
    middleware: [timelineScopeMiddleware],
    loader: rootLoader,
    // The session only changes through forms (sign in, sign out).
    shouldRevalidate: ({ formMethod, currentUrl, nextUrl, defaultShouldRevalidate }) =>
      formMethod || currentUrl.href === nextUrl.href ? defaultShouldRevalidate : false,
    Component: TitledShell,
    ErrorBoundary: RootError,
    HydrateFallback: InitialPageTitle,
    // Errors render inside the shell so the rail stays put.
    children: [
      {
        ErrorBoundary: TitledError,
        children: [
          { index: true, loader: homeLoader, Component: Home },
          { path: "signin", loader: signInLoader, action: signInAction, Component: SignIn },
          { path: "device", loader: deviceLoader, action: deviceAction, Component: Device },
          { path: "new", loader: newRepoLoader, action: newRepoAction, Component: NewRepo },
          { path: "tracker", loader: trackerIndexLoader, Component: TrackerIndex },
          { path: "timelines", loader: timelinesIndexLoader, Component: TrackerIndex },
          { path: "release-notes", loader: releaseNotesIndexLoader, Component: TrackerIndex },
          { path: "packages", loader: allPackagesLoader, Component: AllPackages },
          { path: "needs-you", loader: needsYouLoader, Component: NeedsYou },
          // Whatever a ref names (CORE-22): redirects, or a chooser when it's ambiguous.
          { path: "-/go/*", loader: goLoader, Component: GoPage },
          {
            path: "tracker/:owner/releases",
            loader: trackerReleasesLoader,
            Component: TrackerReleases,
          },
          {
            path: "tracker/:owner/timelines",
            loader: trackerTimelinesLoader,
            Component: TrackerTimelines,
          },
          {
            path: "tracker/:owner/timelines/:slug/story",
            loader: storyLoader,
            Component: Story,
          },
          {
            path: "tracker/:owner",
            loader: trackerLoader,
            shouldRevalidate: ({
              currentParams,
              nextParams,
              formMethod,
              currentUrl,
              nextUrl,
              defaultShouldRevalidate,
            }) =>
              currentParams.owner !== nextParams.owner ||
              // A timeline's view is its own snapshot (?tl=, CORE-74's "Reopen it there").
              scopeOf(currentUrl.search) !== scopeOf(nextUrl.search) ||
              formMethod ||
              currentUrl.href === nextUrl.href
                ? defaultShouldRevalidate
                : false,
            Component: Tracker,
            children: [{ path: "issues/:issue" }],
          },
          {
            path: "settings/agents",
            loader: agentsLoader,
            action: agentsAction,
            Component: Agents,
          },
          {
            path: "settings/tokens",
            loader: tokensLoader,
            action: tokensAction,
            Component: Tokens,
          },
          {
            path: "settings/profile",
            loader: profileLoader,
            action: profileAction,
            Component: Profile,
          },
          {
            path: "settings/skills",
            loader: assistantSkillsLoader,
            action: assistantSkillsAction,
            Component: AssistantSkills,
          },
          {
            path: "settings/preferences",
            loader: preferencesLoader,
            Component: Preferences,
          },
          {
            path: "settings/ai",
            loader: aiSettingsLoader,
            Component: AiSettings,
          },
          {
            path: "settings/ai-providers",
            loader: aiProvidersLoader,
            Component: AiProviders,
          },
          { path: "settings/site-ai", loader: siteAiSettingsLoader, Component: SiteAiSettings },
          { path: "settings/usage", loader: usageLoader, Component: UsageCosts },
          { path: "settings/site-usage", loader: siteUsageLoader, Component: SiteUsage },
          { path: "settings/retention", loader: retentionLoader, Component: DataRetention },
          {
            path: "settings/site-retention",
            loader: siteRetentionLoader,
            Component: SiteRetention,
          },
          {
            path: "settings/invites",
            loader: invitesLoader,
            action: invitesAction,
            Component: Invites,
          },
          {
            path: "settings/ssh-keys",
            loader: sshKeysLoader,
            action: sshKeysAction,
            Component: SshKeys,
          },
          { path: ":owner", loader: accountLoader, Component: Account },
          {
            path: ":owner/-/packages",
            loader: ownerPackagesLoader,
            Component: OwnerPackages,
          },
          {
            path: ":owner/-/packages/:format/*",
            loader: packageConsoleLoader,
            Component: PackageConsole,
          },
          { path: ":owner/-/feeds", loader: feedsLoader, action: feedsAction, Component: Feeds },
          // The Atlas across selected repositories (CORE-172).
          {
            path: ":owner/-/atlas",
            loader: workspaceAtlasLoader,
            shouldRevalidate: workspaceAtlasShouldRevalidate,
            Component: WorkspaceAtlas,
          },
          {
            path: "cli-auth/npm/:id",
            loader: npmLoginLoader,
            action: npmLoginAction,
            Component: NpmLogin,
          },
          {
            id: "repo",
            path: ":owner/:repo",
            loader: repoLoader,
            shouldRevalidate: repoShouldRevalidate,
            Component: RepoLayout,
            // ?commit= opens the commit panel over any of these (CORE-22) without reloading it.
            children: (
              [
                { index: true, loader: codeLoader, Component: Code },
                { path: "tree/*", loader: codeLoader, Component: Code },
                { path: "blob/*", loader: blobLoader, Component: Blob },
                { path: "commits/*", loader: commitsLoader, Component: Commits },
                { path: "changes", Component: SemanticChanges },
                { path: "wiki/*", loader: wikiLoader, Component: Wiki },
                { path: "releases/*", loader: releasesLoader, Component: Releases },
                // Knowledge is the Semantic Code Atlas (CORE-174): bounded regions, never the whole graph.
                {
                  path: "knowledge",
                  loader: atlasLoader,
                  shouldRevalidate: atlasShouldRevalidate,
                  Component: Atlas,
                },
                // Links from before the cutover keep their view.
                {
                  path: "atlas",
                  loader: ({ request }) => {
                    const url = new URL(request.url);
                    return redirect(
                      `${url.pathname.replace(/\/atlas\/?$/, "/knowledge")}${url.search}`,
                    );
                  },
                },
                { path: "tracker", loader: repoTrackerLoader, Component: RepoTracker },
                { path: "ci", loader: ciLoader, action: ciAction, Component: CiRuns },
                { path: "ci/:number", loader: ciRunLoader, Component: CiRun },
                { path: "packages", loader: repoPackagesLoader, Component: RepoPackages },
                {
                  path: "settings",
                  loader: settingsLoader,
                  action: settingsAction,
                  Component: Settings,
                },
              ] satisfies RouteObject[]
            ).map(keepPageUnderPanel),
          },
          {
            path: "*",
            loader: () => {
              throw new Response(null, { status: 404 });
            },
          },
        ],
      },
    ],
  },
]);
