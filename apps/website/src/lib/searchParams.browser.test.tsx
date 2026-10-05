// CORE-258: two address updates before React re-renders keep both changes.
// React Router's functional setSearchParams starts from the params of the last
// render, so the second of two quick updates used to drop the first (a click
// right after another navigation, under load: a copied Atlas link then
// reopened without its lens).

import { act } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, useSearchParams } from "react-router";
import { afterEach, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { useLiveSearchParams } from "./searchParams.ts";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

/** Mount `Page` at `/?keep=1`, then put the test frame's own address back (as renderApp does). */
function mount(Page: () => React.ReactNode) {
  const frame = location.href;
  history.replaceState(null, "", "/?keep=1");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = createBrowserRouter([{ path: "/", Component: Page }]);
  act(() => root.render(<RouterProvider router={router} />));
  unmount = () => {
    act(() => root.unmount());
    router.dispose();
    container.remove();
    history.replaceState(null, "", frame);
  };
}

const set = (key: string, value: string) => (current: URLSearchParams) => {
  const next = new URLSearchParams(current);
  next.set(key, value);
  return next;
};

test("two updates in one turn both reach the address", async () => {
  mount(function Page() {
    const [params, update] = useLiveSearchParams();
    return (
      <>
        <output>{params.toString()}</output>
        <button
          type="button"
          onClick={() => {
            update(set("lens", "in"));
            update(set("links", "related"));
          }}
        >
          Both
        </button>
      </>
    );
  });
  await page.getByRole("button", { name: "Both" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("keep=1&lens=in&links=related");
  expect(new URL(location.href).searchParams.get("lens")).toBe("in");
});

test("React Router's own functional update drops the first (why the hook exists)", async () => {
  mount(function Page() {
    const [params, setParams] = useSearchParams();
    return (
      <>
        <output>{params.toString()}</output>
        <button
          type="button"
          onClick={() => {
            setParams(set("lens", "in"));
            setParams(set("links", "related"));
          }}
        >
          Both
        </button>
      </>
    );
  });
  await page.getByRole("button", { name: "Both" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("keep=1&links=related");
});
