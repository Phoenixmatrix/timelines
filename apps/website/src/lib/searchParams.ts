// Search params whose updates start from the address as it is now.
//
// React Router hands a functional `setSearchParams` the params of the last
// render, not the live address. Two updates before React re-renders (a click
// right after another navigation, easy under load) both start from the same
// old params, so the second one drops the first one's change: a copied link
// then reopens without it (CORE-258). Every app router is a browser router,
// so the live address is `window.location`.

import { useCallback } from "react";
import { useSearchParams, type NavigateOptions } from "react-router";

export type UpdateSearchParams = (
  change: (current: URLSearchParams) => URLSearchParams,
  options?: NavigateOptions,
) => void;

export function useLiveSearchParams(): [URLSearchParams, UpdateSearchParams] {
  const [params, setParams] = useSearchParams();
  const update = useCallback<UpdateSearchParams>(
    (change, options) => setParams(change(new URLSearchParams(window.location.search)), options),
    [setParams],
  );
  return [params, update];
}
