import { Tooltip } from "@base-ui/react/tooltip";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation, type Location } from "react-router";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { KeyboardShortcuts } from "./KeyboardShortcuts.tsx";
import "../styles/app.css";

function ShortcutFixture({
  showButton,
  onLocationCommitted,
}: {
  showButton: boolean;
  onLocationCommitted: (location: Location) => void;
}) {
  const location = useLocation();
  useEffect(() => {
    onLocationCommitted(location);
  }, [location, onLocationCommitted]);
  return (
    <>
      <KeyboardShortcuts showButton={showButton} />
      <input aria-label="Draft" />
      <div contentEditable aria-label="Editor" />
      <button type="button">Outside</button>
    </>
  );
}

async function mount(initial = "/tracker/orbit/timelines/search/story", showButton = true) {
  let enabled = false;
  const getItem = vi.spyOn(Storage.prototype, "getItem");
  const read = getItem.getMockImplementation()!;
  getItem.mockImplementation(function (this: Storage, key: string) {
    return key === "gitmatrix:tracker-shortcuts" ? String(enabled) : read.call(this, key);
  });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let committedLocation: Location | undefined;
  const onLocationCommitted = (location: Location) => {
    committedLocation = location;
  };
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <ShortcutFixture showButton={showButton} onLocationCommitted={onLocationCommitted} />
        ),
      },
    ],
    { initialEntries: [initial] },
  );
  onTestFinished(async () => {
    await act(async () => root.unmount());
    router.dispose();
    container.remove();
    vi.restoreAllMocks();
  });
  await act(async () =>
    root.render(
      <Tooltip.Provider>
        <RouterProvider router={router} />
      </Tooltip.Provider>,
    ),
  );
  return {
    router,
    enable: (value = true) => {
      enabled = value;
    },
    waitForLocation: async (path: string) => {
      // Router state advances before its transition commits. Wait for the
      // shortcut effect to observe that route before starting another chord.
      await expect
        .poll(() =>
          committedLocation ? committedLocation.pathname + committedLocation.search : undefined,
        )
        .toBe(path);
      await expect.poll(() => committedLocation?.key).toBe(router.state.location.key);
    },
  };
}

const help = () => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const key = async (
  key: string,
  options: KeyboardEventInit = {},
  target: EventTarget = document.body,
) => {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
    );
  });
};

test("help is discoverable, traps and restores focus, and blocks underlying shortcuts", async () => {
  const { router, enable } = await mount();
  enable();
  const button = page.getByRole("button", { name: "Keyboard shortcuts" });
  await userEvent.click(button);
  await expect.element(help()).toBeVisible();
  await expect.element(help().getByRole("button", { name: "Close" })).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  expect(help().element().contains(document.activeElement)).toBe(true);
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(help().element().contains(document.activeElement)).toBe(true);
  const competing = vi.fn();
  window.addEventListener("keydown", competing);
  try {
    await userEvent.keyboard("gij{Control>}k{/Control}{Control>}j{/Control}");
    expect(competing).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toContain("/story");
  } finally {
    window.removeEventListener("keydown", competing);
  }
  await userEvent.keyboard("{Escape}");
  await expect.element(help()).not.toBeInTheDocument();
  await expect.element(button).toHaveFocus();
  await userEvent.keyboard("?");
  await expect.element(help()).toBeVisible();
  await userEvent.click(help().getByRole("button", { name: "Close" }));
  await expect.element(button).toHaveFocus();
});

// Both keys of a chord at once: typed through the browser driver, a loaded CI
// host can space them past the chord's one-second window.
const chord = (keys: string) =>
  act(async () => {
    for (const key of keys)
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
  });

test("opt-in gates all chords; issues retain tracker/settings context, packages and home use rail destinations", async () => {
  const { router, enable, waitForLocation } = await mount();
  await userEvent.keyboard("gigpgh");
  expect(router.state.location.pathname).toContain("/story");
  enable();
  await chord("gi");
  await waitForLocation("/tracker/orbit");
  await chord("gp");
  await waitForLocation("/packages");
  await chord("gh");
  await waitForLocation("/");
  await chord("gi");
  await waitForLocation("/tracker");
  for (const path of [
    "/settings/preferences?tracker=orbit",
    "/settings/usage?space=orbit",
    "/settings/preferences?space=orbit&tracker=other",
  ]) {
    await act(async () => {
      await router.navigate(path);
    });
    await waitForLocation(path);
    await chord("gi");
    await waitForLocation("/tracker/orbit");
  }
});

test("typing, dialogs, composition, modified/repeated keys and canceled/expired chords never navigate", async () => {
  const { router, enable, waitForLocation } = await mount("/packages");
  enable();
  const unchanged = () => expect(router.state.location.pathname).toBe("/packages");
  await userEvent.click(page.getByRole("textbox", { name: "Draft" }));
  await userEvent.keyboard("?gigh");
  await expect.element(help()).not.toBeInTheDocument();
  unchanged();
  await key("?", {}, page.getByLabelText("Editor").element());
  await expect.element(help()).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Outside" }));
  for (const options of [
    { isComposing: true },
    { keyCode: 229 },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { repeat: true },
  ]) {
    await key("?", options);
    await expect.element(help()).not.toBeInTheDocument();
    await key("g");
    await key("h", options);
    unchanged();
  }
  await key("g", { shiftKey: true });
  await key("h");
  unchanged();
  const other = document.body.appendChild(document.createElement("div"));
  other.setAttribute("role", "dialog");
  try {
    await key("?");
    await key("g");
    await key("h");
    await expect.element(help()).not.toBeInTheDocument();
    unchanged();
  } finally {
    other.remove();
  }
  for (const cancel of [
    () => key("Escape"),
    () => key("x"),
    () => key("g", { repeat: true }),
    async () => {
      window.dispatchEvent(new Event("blur"));
    },
    async () => {
      document.dispatchEvent(new Event("compositionstart"));
    },
    async () => {
      document.dispatchEvent(new Event("pointerdown"));
    },
    async () => {
      document.dispatchEvent(new Event("focusin"));
    },
  ]) {
    await key("g");
    await cancel();
    await key("h");
    unchanged();
  }
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  await key("g");
  now.mockReturnValue(1101);
  await key("h");
  unchanged();
  now.mockRestore();
  await key("g");
  await act(async () => {
    await router.navigate("/tracker/orbit");
  });
  await waitForLocation("/tracker/orbit");
  await key("h");
  expect(router.state.location.pathname).toBe("/tracker/orbit");
  await key("g");
  enable(false);
  await key("h");
  expect(router.state.location.pathname).toBe("/tracker/orbit");
  const accelerators = vi.fn();
  window.addEventListener("keydown", accelerators);
  try {
    await key("k", { ctrlKey: true });
    await key("j", { metaKey: true });
    expect(accelerators).toHaveBeenCalledTimes(2);
    for (const [event] of accelerators.mock.calls) expect(event.defaultPrevented).toBe(false);
  } finally {
    window.removeEventListener("keydown", accelerators);
  }
});

test("focused pages have global question-mark help without providers or a rail button", async () => {
  await mount("/signin", false);
  await expect
    .element(page.getByRole("button", { name: "Keyboard shortcuts" }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("?");
  await expect.element(help()).toBeVisible();
  await expect.element(help().getByText("Search and commands")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(help()).not.toBeInTheDocument();
});
