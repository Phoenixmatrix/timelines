// Render the whole app, as main.tsx does, at an address, for a browser-mode
// test ("Testing" in README.md): the real routes, loaders, shell and styles,
// and a browser router, so the address, Back and Forward behave as they do in
// the app (the timeline scope's middleware reads window.location). The test
// frame's own address comes back when the test ends.

import { Toast } from "@base-ui/react/toast";
import { Tooltip } from "@base-ui/react/tooltip";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, type DataRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { expect, onTestFinished } from "vite-plus/test";
import { routes } from "../appRoutes.tsx";
import { refreshTimelines } from "../components/TimelineScope.tsx";
import { forgetAllRepoData } from "../lib/repoData.ts";
import { resetRefResolutions } from "../refs/resolver.ts";
import { applyTheme, storedTheme } from "../lib/theme.ts";
import { scopeLinks } from "../lib/timelineScope.ts";
import "../styles/app.css";

export interface RenderedApp {
  router: DataRouter;
  container: HTMLElement;
  /** The address the app is at, as a URL (origin aside). */
  url(): URL;
  /** Wait until the address satisfies `match`. */
  waitForUrl(match: (url: URL) => boolean): Promise<URL>;
  navigate(to: string | number): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  unmount(): void;
}

/** Mount the app at `path`, for this test only. */
export function renderApp(path: string): RenderedApp {
  // Nothing an earlier test (or world) read is reused.
  forgetAllRepoData();
  resetRefResolutions();
  refreshTimelines();
  applyTheme(storedTheme());
  const frame = location.href;
  history.replaceState(null, "", path);
  const router = createBrowserRouter(routes);
  scopeLinks(router);
  // As index.html does: text inherits the theme's ink, so captures (visual()) look like the app.
  document.body.classList.add("mk-root");
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <Tooltip.Provider delay={400}>
        <Toast.Provider timeout={3000}>
          <RouterProvider router={router} />
        </Toast.Provider>
      </Tooltip.Provider>
    </StrictMode>,
  );
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
    router.dispose();
    container.remove();
    history.replaceState(null, "", frame);
  };
  onTestFinished(unmount);
  const url = () => {
    const { pathname, search, hash } = router.state.location;
    return new URL(`${pathname}${search}${hash}`, location.origin);
  };
  return {
    router,
    container,
    url,
    async waitForUrl(match) {
      await expect.poll(() => match(url()), { timeout: 10_000 }).toBe(true);
      return url();
    },
    navigate: (to) => (typeof to === "number" ? router.navigate(to) : router.navigate(to)),
    back: () => router.navigate(-1),
    forward: () => router.navigate(1),
    unmount,
  };
}
