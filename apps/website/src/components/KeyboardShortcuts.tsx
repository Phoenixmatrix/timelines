import { Dialog } from "@base-ui/react/dialog";
import { QuestionIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { readTrackerShortcuts } from "../routes/tracker/preferences.ts";
import { dialogMotion, fadeMotion, link, Tip } from "./ui.tsx";

/** Global navigation mirrors the rail; no palette or assistant provider is needed. */
export function KeyboardShortcuts({ showButton = true }: { showButton?: boolean }) {
  const location = useLocation();
  const tracker = useMatch("/tracker/:owner/*");
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const params = new URLSearchParams(location.search);
  const owner =
    tracker?.params.owner ??
    (location.pathname.startsWith("/settings/")
      ? (params.get("owner") ??
        (location.pathname === "/settings/preferences" ? params.get("tracker") : null))
      : null);
  const issues = owner ? `/tracker/${encodeURIComponent(owner)}` : "/tracker";
  const preferences = owner
    ? `/settings/preferences?tracker=${encodeURIComponent(owner)}`
    : "/settings/preferences";
  const focusedPage = location.pathname === "/signin" || location.pathname === "/device";
  const enabled = readTrackerShortcuts();

  const show = () => {
    restoreFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  };

  useEffect(() => {
    let pendingUntil = 0;
    const cancel = () => {
      pendingUntil = 0;
    };
    const onKey = (event: KeyboardEvent) => {
      // The dialog owns Escape/Tab; its popup stops other keys bubbling to
      // page shortcuts without blocking the dialog's own focused controls.
      if (open) {
        cancel();
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=combobox], [role=listbox], [role=menu]",
        ) ||
        document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')
      ) {
        cancel();
        return;
      }
      if (event.key === "?") {
        cancel();
        event.preventDefault();
        event.stopPropagation();
        show();
        return;
      }
      if (event.shiftKey || !readTrackerShortcuts()) {
        cancel();
        return;
      }
      if (pendingUntil) {
        const inTime = performance.now() < pendingUntil;
        cancel();
        const destination =
          event.key === "i"
            ? issues
            : event.key === "p"
              ? "/packages"
              : event.key === "h"
                ? "/"
                : null;
        if (inTime && destination) {
          event.preventDefault();
          event.stopPropagation();
          void navigate(destination);
        }
        return;
      }
      if (event.key === "g") {
        pendingUntil = performance.now() + 1000;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("focusin", cancel);
    document.addEventListener("compositionstart", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("focusin", cancel);
      document.removeEventListener("compositionstart", cancel);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, [open, location.key, location.pathname, location.search, issues, navigate]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {showButton && (
        <Tip label="Keyboard shortcuts (?)" side="right">
          <button
            type="button"
            className="mk-place max-sm:before:hidden"
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="?"
            onClick={show}
          >
            <QuestionIcon size={22} aria-hidden />
          </button>
        </Tip>
      )}
      <Dialog.Portal>
        <Dialog.Backdrop className={`mk-backdrop ${fadeMotion}`} />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-3">
          <Dialog.Popup
            initialFocus={close}
            finalFocus={() => restoreFocus.current}
            onKeyDown={(event) => {
              if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
            }}
            className={`max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-pane bg-pane p-5 shadow-float ${dialogMotion}`}
          >
            <Dialog.Title className="m-0 text-title">Keyboard shortcuts</Dialog.Title>
            <Dialog.Description className="mt-2 text-body-sm text-ink-muted">
              Shortcuts stay out of text fields and other dialogs. Press Escape to close this help.
            </Dialog.Description>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-body-sm">
              <dt>
                <kbd>?</kbd>
              </dt>
              <dd className="m-0">Show keyboard shortcuts</dd>
              {!focusedPage && (
                <>
                  <dt>
                    <kbd>Ctrl / ⌘ K</kbd>
                  </dt>
                  <dd className="m-0">Search and commands</dd>
                  <dt>
                    <kbd>Ctrl / ⌘ J</kbd>
                  </dt>
                  <dd className="m-0">Open or close the assistant</dd>
                </>
              )}
            </dl>
            <h3 className="mt-5 mb-2 text-body font-semibold">
              Character navigation · {enabled ? "on" : "off"}
            </h3>
            <p className="mt-0 text-body-sm text-ink-muted">
              Enable in{" "}
              <Link className={link} to={preferences} onClick={() => setOpen(false)}>
                Preferences
              </Link>
              . For a g command, press the two keys within one second.
            </p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-body-sm">
              <dt>
                <kbd>g i</kbd>
              </dt>
              <dd className="m-0">Go to issues{owner ? ` in ${owner}` : ""}</dd>
              <dt>
                <kbd>g p</kbd>
              </dt>
              <dd className="m-0">Go to packages</dd>
              <dt>
                <kbd>g h</kbd>
              </dt>
              <dd className="m-0">Go home</dd>
              <dt>
                <kbd>c / n</kbd>
              </dt>
              <dd className="m-0">Capture an issue in the tracker</dd>
              <dt>
                <kbd>/</kbd>
              </dt>
              <dd className="m-0">Filter issues in the tracker</dd>
              <dt>
                <kbd>j / k</kbd>
              </dt>
              <dd className="m-0">Next / previous issue or Story step</dd>
              <dt>
                <kbd>Escape</kbd>
              </dt>
              <dd className="m-0">Close the selected issue in the tracker</dd>
            </dl>
            <p className="text-body-sm text-ink-muted">
              In Story, Right / Down goes to the next visible step; Left / Up goes to the previous
              visible step. Escape closes the step. These keys work without character navigation.
            </p>
            <Dialog.Close ref={close} className="mk-btn mk-btn--secondary mt-2 min-h-11">
              Close
            </Dialog.Close>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
