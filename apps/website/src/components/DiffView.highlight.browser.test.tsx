// DiffView's syntax tokens belong to the diff that produced them (CORE-382):
// the same path in another diff is highlighted afresh.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, onTestFinished, test, vi } from "vite-plus/test";
import type { DiffFile } from "../../shared/diff.ts";
import type { HighlightJob } from "../lib/highlightWorker.ts";
import { DiffView } from "./DiffView.tsx";
import "../styles/app.css";

const started: HighlightJob[][] = [];
vi.mock("../lib/highlightWorker.ts", () => ({
  startHighlight: (
    jobs: HighlightJob[],
    onResult: (key: string, lines: { start: number; end: number; scope: string }[][]) => void,
  ) => {
    started.push(jobs);
    for (const job of jobs) onResult(job.key, [[]]);
    return () => {};
  },
}));

const file = (code: string): DiffFile => ({
  path: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
  omitted: false,
  hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [`+${code}`] }],
});

test("a diff of the same path elsewhere is highlighted again, not with the last one's tokens", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const show = (files: DiffFile[]) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <DiffView files={files} truncated={false} />
        </MemoryRouter>,
      ),
    );
  await show([file("one()")]);
  expect(started.at(-1)?.map((job) => job.text)).toEqual(["one()"]);
  const before = started.length;
  await show([file("two()")]);
  expect(started.length).toBeGreaterThan(before);
  expect(started.at(-1)?.map((job) => [job.key, job.text])).toEqual([["src/a.ts#0", "two()"]]);
});
