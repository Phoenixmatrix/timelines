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
import { Wiki, wikiLoader } from "./routes/repo/Wiki.tsx";
import { RepoLayout, repoLoader, repoShouldRevalidate } from "./routes/repo/RepoLayout.tsx";
import { Settings, settingsAction, settingsLoader } from "./routes/repo/Settings.tsx";
import { SignIn, signInAction, signInLoader } from "./routes/SignIn.tsx";
import { Tokens, tokensAction, tokensLoader } from "./routes/Tokens.tsx";

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
          { path: "new", loader: newRepoLoader, action: newRepoAction, Component: NewRepo },
          {
            path: "settings/tokens",
            loader: tokensLoader,
            action: tokensAction,
            Component: Tokens,
          },
          { path: ":owner", loader: accountLoader, Component: Account },
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
              { path: "wiki/*", loader: wikiLoader, Component: Wiki },
              { path: "knowledge", loader: knowledgeLoader, Component: Knowledge },
              { path: "ci", loader: ciLoader, action: ciAction, Component: CiRuns },
              { path: "ci/:number", loader: ciRunLoader, Component: CiRun },
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
