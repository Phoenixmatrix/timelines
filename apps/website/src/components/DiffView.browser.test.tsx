// The diff component (CORE-382) in a real browser: its file list jumps to and
// selects a file, files collapse, binary and oversized files say so, hunks
// carry line numbers, and a long line scrolls inside its file, not the page.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { DiffFile } from "../../shared/diff.ts";
import { sidewaysOverflow } from "../testing/atlas.ts";
import { DiffView, EXPANDED_OF_LARGE, LARGE_FILES, initiallyOpen } from "./DiffView.tsx";
import "../styles/app.css";

const text = (
  path: string,
  lines: string[],
  over: Partial<DiffFile> = {},
  start = 10,
): DiffFile => ({
  path,
  status: "modified",
  additions: lines.filter((l) => l.startsWith("+")).length,
  deletions: lines.filter((l) => l.startsWith("-")).length,
  binary: false,
  omitted: false,
  hunks: [
    { oldStart: start, oldLines: lines.length, newStart: start, newLines: lines.length, lines },
  ],
  ...over,
});

async function mount(ui: React.ReactElement) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  await act(async () => root.render(<MemoryRouter>{ui}</MemoryRouter>));
}

const view = () => page.getByRole("region", { name: "Diff" });

test("the file list jumps to a file, opening and selecting it", async () => {
  const picked: string[] = [];
  const files = [
    text("src/a.ts", [" keep", "-old()", "+fresh()"]),
    text("src/deep/b.ts", ["+only()"]),
    text("assets/logo.png", [], { binary: true }),
    text("dump.json", [], { omitted: true }),
  ];
  await mount(
    <DiffView
      files={files}
      truncated
      idPrefix="t"
      blobHref={(path) => `/blob/${path}`}
      onSelectPath={(path) => picked.push(path)}
    />,
  );
  await expect.element(view()).toMatchTextContent(/4 files changed, \+2 −1 \(more not shown\)/);
  // Directory dimmed, basename emphasised, in the list and on the headings.
  const list = page.getByRole("navigation", { name: "Changed files" });
  await expect.element(list.getByRole("button", { name: /b\.ts/ })).toBeVisible();
  // Binary and oversized files say so.
  await expect.element(view().getByText("Binary file.")).toBeVisible();
  await expect.element(view().getByText("Too large to show here.")).toBeVisible();
  // Line numbers follow the signs: context counts both sides, a removal the old only.
  const table = view().getByRole("table", { name: "Changes to src/a.ts" });
  const rows = table.element().querySelectorAll("tbody tr");
  const numbers = [...rows].map((row) =>
    [...row.querySelectorAll("td")].slice(0, 2).map((td) => td.textContent),
  );
  expect(numbers.slice(1)).toEqual([
    ["10", "10"],
    ["11", ""],
    ["", "11"],
  ]);
  await expect
    .element(view().getByRole("link", { name: "View src/a.ts" }))
    .toHaveAttribute("href", "/blob/src/a.ts");

  // Collapse all hides every body; picking a file opens it, marks it, focuses it.
  await view().getByRole("button", { name: "Collapse all" }).click();
  expect(view().element().querySelectorAll("table")).toHaveLength(0);
  await expect.element(view().getByRole("button", { name: "Expand all" })).toBeEnabled();
  await list.getByRole("button", { name: /b\.ts/ }).click();
  expect(picked).toEqual(["src/deep/b.ts"]);
  await expect
    .element(list.getByRole("button", { name: /b\.ts/ }))
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(view().getByRole("table", { name: "Changes to src/deep/b.ts" }))
    .toBeVisible();
  expect(view().element().querySelectorAll("table")).toHaveLength(1);
  expect(document.activeElement?.closest("summary")?.textContent).toContain("b.ts");
  await view().getByRole("button", { name: "Expand all" }).click();
  expect(view().element().querySelectorAll("table")).toHaveLength(2);
  await expect.element(view().getByRole("button", { name: "Expand all" })).toBeDisabled();
});

test("a selected path from outside is opened and scrolled to", async () => {
  const files = Array.from({ length: 20 }, (_, n) => text(`src/f${n}.ts`, [`+line${n}()`]));
  await mount(<DiffView files={files} truncated={false} selectedPath="src/f12.ts" />);
  // Large: only the first few open, plus the chosen one.
  expect(view().element().querySelectorAll("table")).toHaveLength(EXPANDED_OF_LARGE + 1);
  await expect
    .element(view().getByRole("table", { name: "Changes to src/f12.ts" }))
    .toBeInViewport();
  expect(document.activeElement?.closest("summary")?.textContent).toContain("f12.ts");
});

test("big diffs start mostly collapsed, small ones fully open", () => {
  const many = Array.from({ length: LARGE_FILES + 1 }, (_, n) => text(`f${n}`, ["+x"]));
  expect(initiallyOpen(many.slice(0, LARGE_FILES), null).size).toBe(LARGE_FILES);
  expect([...initiallyOpen(many, null)]).toEqual(["f0", "f1", "f2"]);
  const long = [
    text(
      "a",
      Array.from({ length: 1600 }, () => "+x"),
    ),
    text("b", ["+y"]),
  ];
  expect([...initiallyOpen(long, "b")].sort()).toEqual(["a", "b"]);
  const wide = [
    text("a", ["+x"]),
    text(
      "b",
      Array.from({ length: 1600 }, () => "+x"),
    ),
    text("c", ["+y"]),
    text("d", ["+y"]),
    text("e", ["+y"]),
  ];
  expect([...initiallyOpen(wide, null)]).toEqual(["a", "b", "c"]);
});

test("a long line scrolls inside its file, not the page, on a phone", async () => {
  await page.viewport(390, 844);
  try {
    const long = "+" + "const veryLongName = ".repeat(60);
    await mount(
      <div className="px-4">
        <DiffView files={[text("src/long.ts", [long, " short"])]} truncated={false} />
      </div>,
    );
    await expect.element(view().getByRole("table")).toBeVisible();
    expect(sidewaysOverflow()).toBeLessThanOrEqual(0);
    const scroller = view().getByRole("table").element().parentElement!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
  } finally {
    await page.viewport(1280, 900);
  }
});
