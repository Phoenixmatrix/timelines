// One-shot handoffs from the palette to a page, carried in router state so
// nothing typed ends up in a URL. The page consumes and clears its intent.

/** The router-state key for "open the issue creator here". */
export const CREATE_INTENT = "gm.createIssue";

export interface CreateIntent {
  /** A proposed title, possibly empty; the creator's own validation applies. */
  title: string;
}

/** Router state asking the tracker page to open its creator once. */
export function createIntent(title: string): Record<string, CreateIntent> {
  return { [CREATE_INTENT]: { title: title.slice(0, 500) } };
}

/** The create intent in a location's state, if it carries one. */
export function createIntentOf(state: unknown): CreateIntent | null {
  if (!state || typeof state !== "object") return null;
  const intent = (state as Record<string, unknown>)[CREATE_INTENT];
  if (!intent || typeof intent !== "object") return null;
  const title = (intent as { title?: unknown }).title;
  return { title: typeof title === "string" ? title.slice(0, 500) : "" };
}
