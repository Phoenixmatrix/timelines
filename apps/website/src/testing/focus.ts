// Keyboard and focus helpers for browser-mode tests: drive the page as a
// keyboard user would, and read where focus is.

import { expect } from "vite-plus/test";
import { browserCommands } from "./server.ts";
import { userEvent, type Locator } from "vite-plus/test/browser";

export interface Focused {
  role: string;
  name: string;
  href: string | null;
}

/** The accessible name (label or text) of whatever has focus, its role and href. */
export function focused(): Focused {
  const el = document.activeElement as HTMLElement | null;
  return {
    role: el?.getAttribute("role") ?? el?.tagName.toLowerCase() ?? "",
    name: (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim(),
    href: el?.getAttribute("href") ?? null,
  };
}

/** Keys as userEvent.keyboard spells them: "Tab", "Shift+Tab", "ArrowDown", "Enter", "Control+k". */
export async function press(key: string): Promise<void> {
  const parts = key.split("+");
  const last = parts.pop()!;
  const single = last.length === 1 ? last : `{${last}}`;
  await userEvent.keyboard(
    `${parts.map((m) => `{${m}>}`).join("")}${single}${parts
      .reverse()
      .map((m) => `{/${m}}`)
      .join("")}`,
  );
}

/** Press `key` until focus lands on something matching, as a keyboard user would. */
export async function pressUntil(
  key: string,
  match: (f: Focused) => boolean,
  label: string,
  limit = 60,
): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (match(focused())) return;
    await press(key);
    // Let the page finish reacting before reading where focus went.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const last = focused();
  expect(
    match(last),
    `Keyboard never reached ${label} with ${key}; focus is on ${JSON.stringify(last)}`,
  ).toBe(true);
}

/** Move focus to what `locator` finds, once it's there (as Tab would, without the walk). */
export async function focusOn(locator: Locator): Promise<void> {
  await expect.element(locator).toBeInTheDocument();
  (locator.element() as HTMLElement).focus();
}

/** A real touch tap on what `locator` finds. */
export async function tap(locator: Locator): Promise<void> {
  await expect.element(locator).toBeVisible();
  await browserCommands.tap(locator.selector);
}
