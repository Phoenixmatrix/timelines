import { popMotion } from "./ui.tsx";
import { Menu } from "@base-ui/react/menu";
import {
  ChatCenteredDotsIcon,
  FingerprintIcon,
  GearSixIcon,
  GitBranchIcon,
  HandWavingIcon,
  KeyIcon,
  ListChecksIcon,
  MoonIcon,
  PackageIcon,
  RobotIcon,
  ScrollIcon,
  NewspaperIcon,
  SignInIcon,
  SignOutIcon,
  SlidersHorizontalIcon,
  SunIcon,
  UserCircleIcon,
  UserSwitchIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useFetcher,
  useLocation,
  useMatch,
  useNavigation,
  useMatches,
} from "react-router";
import { AssistantDock, preloadAssistant } from "../assistant/Dock.tsx";
import { AssistantProvider, useAssistant } from "../assistant/state.tsx";
import { PaletteProvider, SearchButton } from "../palette/Palette.tsx";
import { useViewer } from "../lib/session.ts";
import { applyTheme, storedTheme, type Theme } from "../lib/theme.ts";
import { scopeOf, scopeSpace } from "../lib/timelineScope.ts";
import { needsYouBadge, needsYouLabel, useNeedsYou } from "../lib/needs-you.ts";
import { Monogram } from "./Monogram.tsx";
import { GitmatrixLogo, TimelinesMark } from "./GitmatrixLogo.tsx";
import { TimelineBanner } from "./TimelineScope.tsx";
import { ScopeMenu } from "./ScopeMenu.tsx";
import { KeyboardShortcuts } from "./KeyboardShortcuts.tsx";
import { Tip, Toasts } from "./ui.tsx";

function Place({
  to,
  label,
  end,
  also,
  active,
  children,
}: {
  to: string;
  label: string;
  end?: boolean;
  active?: boolean;
  /** Other pages that belong to this place and light it up too. */
  also?: RegExp;
  children: (active: boolean) => React.ReactNode;
}) {
  const { pathname } = useLocation();
  const className = "mk-place max-sm:before:hidden";
  const current = active ?? (also?.test(pathname) ? true : undefined);
  return (
    <Tip label={label} side="right">
      {current !== undefined ? (
        <Link
          to={to}
          className={className}
          aria-current={current ? "page" : undefined}
          aria-label={label}
        >
          {children(current)}
        </Link>
      ) : (
        <NavLink to={to} end={end} className={className} aria-label={label}>
          {({ isActive }) => children(isActive)}
        </NavLink>
      )}
    </Tip>
  );
}

function AccountMenu({ preferencesPath }: { preferencesPath: string }) {
  const viewer = useViewer();
  const signOut = useFetcher();
  const [theme, setTheme] = useState<Theme>(storedTheme);
  if (!viewer) return null;

  const chooseTheme = (next: string) => {
    setTheme(next as Theme);
    applyTheme(next as Theme);
  };

  return (
    <Menu.Root>
      <Tip label={`${viewer.displayName}, account`} side="right">
        <Menu.Trigger
          className="grid size-12 place-items-center rounded-full"
          aria-label={`${viewer.displayName}, account menu`}
        >
          <Monogram name={viewer.displayName} src={viewer.avatarUrl} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal>
        {/* Fixed, like the rail it opens from: scrolling the page under the menu can't move it. */}
        <Menu.Positioner
          side="right"
          align="end"
          sideOffset={12}
          positionMethod="fixed"
          className="z-50"
        >
          <Menu.Popup className={`mk-popup ${popMotion}`}>
            <div className="px-2.5 pt-2 pb-1.5">
              <div className="font-semibold">
                <bdi>{viewer.displayName}</bdi>
              </div>
              <div className="text-body-sm text-ink-faint">
                @{viewer.slug}
                {viewer.isSiteAdmin && " · Instance operator"}
              </div>
            </div>
            <div className="mk-menu-sep" />
            <ScopeMenu />
            <div className="mk-menu-sep" />
            <Menu.LinkItem
              closeOnClick
              className="mk-menu-item"
              render={<Link to="/settings/profile" />}
            >
              <UserCircleIcon className="size-4" aria-hidden />
              Profile
            </Menu.LinkItem>
            <Menu.LinkItem
              closeOnClick
              className="mk-menu-item"
              render={<Link to={preferencesPath} />}
            >
              <SlidersHorizontalIcon className="size-4" aria-hidden />
              Preferences
            </Menu.LinkItem>
            <Menu.LinkItem
              closeOnClick
              className="mk-menu-item"
              render={<Link to={`/accounts/${encodeURIComponent(viewer.slug)}`} />}
            >
              <UserCircleIcon className="size-4" aria-hidden />
              Your public profile
            </Menu.LinkItem>
            <div className="mk-menu-sep" />
            <Menu.LinkItem
              closeOnClick
              className="mk-menu-item"
              render={<Link to="/settings/tokens" />}
            >
              <KeyIcon className="size-4" aria-hidden />
              Access tokens
            </Menu.LinkItem>
            <Menu.LinkItem
              closeOnClick
              className="mk-menu-item"
              render={<Link to="/settings/agents" />}
            >
              <RobotIcon className="size-4" aria-hidden />
              Agents
            </Menu.LinkItem>
            <Menu.LinkItem
              closeOnClick
              className="mk-menu-item"
              render={<Link to="/settings/ssh-keys" />}
            >
              <FingerprintIcon className="size-4" aria-hidden />
              SSH keys
            </Menu.LinkItem>
            {viewer.isSiteAdmin && (
              <Menu.LinkItem closeOnClick className="mk-menu-item" render={<Link to="/instance" />}>
                <GearSixIcon className="size-4" aria-hidden />
                Instance
              </Menu.LinkItem>
            )}
            <Menu.LinkItem closeOnClick className="mk-menu-item" render={<Link to="/signin" />}>
              <UserSwitchIcon className="size-4" aria-hidden />
              Switch account
            </Menu.LinkItem>
            <div className="mk-menu-sep" />
            <Menu.RadioGroup value={theme} onValueChange={chooseTheme}>
              <Menu.GroupLabel className="mk-menu-label">Theme</Menu.GroupLabel>
              <Menu.RadioItem value="dark" className="mk-menu-item" closeOnClick={false}>
                <MoonIcon className="size-4" aria-hidden />
                <span className="flex-1">Dark</span>
                <span className="mk-radio-dot" />
              </Menu.RadioItem>
              <Menu.RadioItem value="light" className="mk-menu-item" closeOnClick={false}>
                <SunIcon className="size-4" aria-hidden />
                <span className="flex-1">Light</span>
                <span className="mk-radio-dot" />
              </Menu.RadioItem>
            </Menu.RadioGroup>
            <div className="mk-menu-sep" />
            <Menu.Item
              className="mk-menu-item"
              onClick={() =>
                signOut.submit(null, { method: "post", action: "/signin?intent=signout" })
              }
            >
              <SignOutIcon className="size-4" aria-hidden />
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function AppShell() {
  const viewer = useViewer();
  const needsYou = useNeedsYou(!!viewer);
  const navigation = useNavigation();
  const location = useLocation();
  const tracker = useMatch("/tracker/:space/*");
  const matches = useMatches();
  const routeSpace = matches.at(-1)?.params.space;
  const params = new URLSearchParams(location.search);
  const managingTracker = Boolean(tracker) && params.get("manage") === "true";
  // Timelines and release notes are their own places, though they live under a tracker.
  const trackerPage = tracker?.params["*"]?.split("/")[0];
  const trackerWorkbench =
    Boolean(tracker) && !managingTracker && (!trackerPage || trackerPage === "issues");
  const onTimelines = trackerPage === "timelines" || location.pathname === "/timelines";
  const scoped = scopeOf(location.search);
  // The graph of the Space this page belongs to (a tracker, a repository,
  // a settings page's); else the default one.
  const graphSpace = scopeSpace(location.pathname, location.search);
  const onReleaseNotes = trackerPage === "releases" || location.pathname === "/release-notes";
  const onHighlights = trackerPage === "highlights" || location.pathname === "/highlights";
  // Home lists every readable repository (CORE-416); a repository's pages are in that place too.
  const onRepositories =
    location.pathname === "/" ||
    Boolean(matches.at(-1)?.params.repo) ||
    /^\/[^/]+\/-\/repositories\/new$/.test(location.pathname);
  const requestedSpace =
    tracker?.params.space ??
    routeSpace ??
    (location.pathname === "/settings/preferences"
      ? params.get("tracker")
      : location.pathname.startsWith("/settings/")
        ? params.get("space")
        : null);
  const owner = viewer?.spaces.some((space) => space.slug === requestedSpace)
    ? requestedSpace
    : null;
  const preferencesPath = owner
    ? `/settings/preferences?tracker=${encodeURIComponent(owner)}`
    : "/settings/preferences";
  const settingsPath = preferencesPath;

  // Sign-in and device approval are their own focused pages, outside the shell.
  if (location.pathname === "/signin" || location.pathname === "/device")
    return (
      <>
        <Outlet />
        <KeyboardShortcuts showButton={false} />
        <Toasts />
      </>
    );

  return (
    <AssistantProvider>
      <PaletteProvider>
        <div
          className="flex min-h-dvh max-sm:flex-col sm:pl-[var(--size-rail)]"
          data-scoped={scopeOf(location.search) ? "" : undefined}
        >
          <nav
            aria-label="Places"
            className="mk-rail app-rail sticky top-0 z-20 shrink-0 sm:fixed sm:inset-y-0 sm:left-0"
            onFocusCapture={(event) => {
              const rail = event.currentTarget;
              // Portalled menus/dialogs are not rail tiles. On phones, native
              // focus can leave a partially visible tile clipped; reveal it
              // within this scrollport without moving the document vertically.
              if (!rail.contains(event.target) || rail.scrollWidth <= rail.clientWidth) return;
              const bounds = rail.getBoundingClientRect();
              const target = event.target.getBoundingClientRect();
              const left = bounds.left + rail.clientLeft;
              const right = left + rail.clientWidth;
              if (target.left < left) rail.scrollLeft += target.left - left;
              else if (target.right > right) rail.scrollLeft += target.right - right;
            }}
          >
            {/* Repositories owns the current-page state for "/", so the logo never claims it. */}
            <Place to="/" label="Home" active={false}>
              {() => <GitmatrixLogo markOnly className="size-8" />}
            </Place>
            <SearchButton />
            <KeyboardShortcuts />
            <Place to="/" label="Repositories" active={onRepositories}>
              {(active) => (
                <GitBranchIcon size={22} weight={active ? "fill" : "regular"} aria-hidden />
              )}
            </Place>
            {viewer && (
              <Place
                to={owner ? `/tracker/${encodeURIComponent(owner)}` : "/tracker"}
                label="Issue tracker"
                active={
                  managingTracker || onTimelines || onReleaseNotes || onHighlights
                    ? false
                    : undefined
                }
              >
                {(active) => (
                  <ListChecksIcon size={22} weight={active ? "fill" : "regular"} aria-hidden />
                )}
              </Place>
            )}
            {viewer && (
              // The graph is the place (CORE-402); switching is on its rows, the
              // banner's Switch and the command palette.
              <Place
                to={`${graphSpace ? `/tracker/${encodeURIComponent(graphSpace)}/timelines` : "/timelines"}${scoped ? `?tl=${encodeURIComponent(scoped)}` : ""}`}
                label={scoped ? `Timelines (in ${scoped})` : "Timelines"}
                active={onTimelines}
              >
                {() => (
                  <span className="relative grid place-items-center">
                    <TimelinesMark className="size-7" />
                    {scoped && (
                      <span
                        className="absolute -top-1 -right-1 size-2.5 rounded-full bg-signal ring-2 ring-rail"
                        aria-hidden
                      />
                    )}
                  </span>
                )}
              </Place>
            )}
            {viewer && (
              <Place
                to={owner ? `/tracker/${encodeURIComponent(owner)}/releases` : "/release-notes"}
                label="Release notes"
                active={onReleaseNotes}
              >
                {(active) => (
                  <ScrollIcon size={22} weight={active ? "fill" : "regular"} aria-hidden />
                )}
              </Place>
            )}
            {viewer && (
              <Place
                to={owner ? `/tracker/${encodeURIComponent(owner)}/highlights` : "/highlights"}
                label="Highlights"
                active={onHighlights}
              >
                {(active) => (
                  <NewspaperIcon size={22} weight={active ? "fill" : "regular"} aria-hidden />
                )}
              </Place>
            )}
            {viewer && (
              <Place to="/needs-you" label={needsYouLabel(needsYou)}>
                {(active) => (
                  <>
                    <HandWavingIcon size={22} weight={active ? "fill" : "regular"} aria-hidden />
                    {/* Every request the page shows you (CORE-301): amber, the action color. */}
                    {needsYou?.open ? (
                      <span
                        className="mk-badge absolute -top-1 -right-1"
                        data-testid="needs-you-count"
                        aria-hidden
                      >
                        {needsYouBadge(needsYou.open)}
                      </span>
                    ) : null}
                  </>
                )}
              </Place>
            )}
            {viewer && (
              <Place to="/packages" label="Packages" also={/^\/[^/]+\/-\/(packages|feeds)(\/|$)/}>
                {(active) => (
                  <PackageIcon size={22} weight={active ? "fill" : "regular"} aria-hidden />
                )}
              </Place>
            )}
            <div className="flex-1" />
            {viewer && <AskButton />}
            {viewer && (
              <Place
                to={settingsPath}
                label="Settings"
                active={managingTracker || location.pathname.startsWith("/settings/")}
              >
                {(active) => (
                  <GearSixIcon size={22} weight={active ? "fill" : "regular"} aria-hidden />
                )}
              </Place>
            )}
            {viewer ? (
              <AccountMenu preferencesPath={preferencesPath} />
            ) : (
              <Place to={`/signin?next=${encodeURIComponent(location.pathname)}`} label="Sign in">
                {() => <SignInIcon size={22} aria-hidden />}
              </Place>
            )}
          </nav>
          <main
            className={`min-w-0 flex-1 transition-opacity${trackerWorkbench ? " lg:flex lg:h-dvh lg:flex-col lg:overflow-hidden" : ""}`}
            style={{ opacity: navigation.state === "loading" ? 0.7 : 1 }}
          >
            {trackerWorkbench ? (
              <div className="contents lg:block lg:shrink-0">
                <TimelineBanner />
              </div>
            ) : (
              <TimelineBanner />
            )}
            <Outlet />
          </main>
          {viewer && <AssistantDock />}
          <Toasts />
        </div>
      </PaletteProvider>
    </AssistantProvider>
  );
}

/** Opens and closes the assistant: a toggle, not a place. */
function AskButton() {
  const assistant = useAssistant();
  return (
    <Tip label={`${assistant.open ? "Close" : "Ask"} the assistant (⌘J)`} side="right">
      <button
        type="button"
        className="mk-place max-sm:before:hidden"
        aria-label="Assistant"
        aria-pressed={assistant.open}
        onPointerEnter={preloadAssistant}
        onFocus={preloadAssistant}
        onClick={() => assistant.toggle()}
      >
        <ChatCenteredDotsIcon size={22} weight={assistant.open ? "fill" : "regular"} aria-hidden />
      </button>
    </Tip>
  );
}

/** The page column: comfortable reading width, generous section spacing. */
/**
 * The page column. Reading and settings pages stay narrow; `wide` suits
 * familiar document layouts (code, commits); `full` is for workspaces that
 * get better with room (CI, packages, issues, knowledge, wiki).
 */
export function Page({
  children,
  wide = false,
  full = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
  full?: boolean;
}) {
  const width = full ? "max-w-[120rem]" : wide ? "max-w-6xl" : "max-w-4xl";
  return <div className={`mx-auto w-full px-4 py-5 sm:px-8 sm:py-7 ${width}`}>{children}</div>;
}
