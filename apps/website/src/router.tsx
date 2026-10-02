import { createBrowserRouter } from "react-router";
import { AppShell } from "./components/AppShell.tsx";
import { rootLoader } from "./lib/session.ts";
import { Account, accountLoader } from "./routes/Account.tsx";
import { ErrorPage } from "./routes/ErrorPage.tsx";
import { Home, homeLoader } from "./routes/Home.tsx";
import { NewRepo, newRepoAction, newRepoLoader } from "./routes/NewRepo.tsx";
import { Blob, blobLoader } from "./routes/repo/Blob.tsx";
import { ciAction, ciLoader, CiRun, CiRuns, ciRunLoader } from "./routes/repo/Ci.tsx";
import { Code, codeLoader } from "./routes/repo/Code.tsx";
import { Commits, commitsLoader } from "./routes/repo/Commits.tsx";
import { Knowledge, knowledgeLoader } from "./routes/repo/Knowledge.tsx";
import { RepoPackages, repoPackagesLoader } from "./routes/repo/Packages.tsx";
import { Feeds, feedsAction, feedsLoader } from "./routes/packages/Feeds.tsx";
import { NpmLogin, npmLoginAction, npmLoginLoader } from "./routes/packages/NpmLogin.tsx";
import { AllPackages, allPackagesLoader } from "./routes/packages/AllPackages.tsx";
import { OwnerPackages, ownerPackagesLoader } from "./routes/packages/OwnerPackages.tsx";
import { PackageConsole, packageConsoleLoader } from "./routes/packages/PackageConsole.tsx";
import { Wiki, wikiLoader } from "./routes/repo/Wiki.tsx";
import { RepoLayout, repoLoader, repoShouldRevalidate } from "./routes/repo/RepoLayout.tsx";
import { Settings, settingsAction, settingsLoader } from "./routes/repo/Settings.tsx";
import { SemanticChanges } from "./routes/repo/SemanticChanges.tsx";
import { SignIn, signInAction, signInLoader } from "./routes/SignIn.tsx";
import { Device, deviceAction, deviceLoader } from "./routes/Device.tsx";
import { Invites, invitesAction, invitesLoader } from "./routes/Invites.tsx";
import { Profile, profileAction, profileLoader } from "./routes/Profile.tsx";
import { SshKeys, sshKeysAction, sshKeysLoader } from "./routes/SshKeys.tsx";
import { Agents, agentsAction, agentsLoader } from "./routes/Agents.tsx";
import { Tokens, tokensAction, tokensLoader } from "./routes/Tokens.tsx";
import {
  Tracker,
  trackerLoader,
  TrackerIndex,
  trackerIndexLoader,
} from "./routes/tracker/Tracker.tsx";
import { RepoTracker, repoTrackerLoader } from "./routes/repo/Tracker.tsx";

export const router = createBrowserRouter([
  {
    id: "root",
    loader: rootLoader,
    // The session only changes through forms (sign in, sign out).
    shouldRevalidate: ({ formMethod, currentUrl, nextUrl, defaultShouldRevalidate }) =>
      formMethod || currentUrl.href === nextUrl.href ? defaultShouldRevalidate : false,
    Component: AppShell,
    // Errors render inside the shell so the rail stays put.
    children: [
      {
        ErrorBoundary: ErrorPage,
        children: [
          { index: true, loader: homeLoader, Component: Home },
          { path: "signin", loader: signInLoader, action: signInAction, Component: SignIn },
          { path: "device", loader: deviceLoader, action: deviceAction, Component: Device },
          { path: "new", loader: newRepoLoader, action: newRepoAction, Component: NewRepo },
          { path: "tracker", loader: trackerIndexLoader, Component: TrackerIndex },
          { path: "packages", loader: allPackagesLoader, Component: AllPackages },
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
            children: [
              { index: true, loader: codeLoader, Component: Code },
              { path: "tree/*", loader: codeLoader, Component: Code },
              { path: "blob/*", loader: blobLoader, Component: Blob },
              { path: "commits/*", loader: commitsLoader, Component: Commits },
              { path: "changes", Component: SemanticChanges },
              { path: "wiki/*", loader: wikiLoader, Component: Wiki },
              { path: "knowledge", loader: knowledgeLoader, Component: Knowledge },
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
            ],
          },
        ],
      },
    ],
  },
]);
