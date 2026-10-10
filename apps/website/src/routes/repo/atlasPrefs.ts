// Atlas view settings kept in this browser (CORE-212): conveniences, so a
// failed read or write just doesn't stick.

import { useState } from "react";

/** Whether the map marks what changed in the build it shows. */
export const CHANGES_KEY = "gitmatrix:atlas-changes";
/** The map view's inspector width in px, once dragged; none for the default. */
export const PANE_KEY = "gitmatrix:atlas-pane";

/** A value kept in localStorage under `key`; `null` removes it. */
export function useRemembered<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });
  const remember = (next: T) => {
    setValue(next);
    try {
      if (next === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Private mode or blocked storage: the setting lasts for this page only.
    }
  };
  return [value, remember];
}
