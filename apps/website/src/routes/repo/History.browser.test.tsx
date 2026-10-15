// A folder's last changes (CORE-451): the client asks for every entry's last
// change in one cover request, and still pages on from `next` when that one
// answer was cut short.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { CommitSummary, HistoryPage, RepoDetail, TreeEntry } from "../../../shared/api.ts";
import { forgetAllRepoData } from "../../lib/repoData.ts";
import { folderHistoryLabel, useHistory, type HistoryState } from "./History.tsx";

const HEAD = "a".repeat(40);
const repo = { space: { slug: "orbit" }, name: "engine", source: null } as unknown as RepoDetail;
const entries: TreeEntry[] = ["LICENSE", "src"].map((name) => ({
  name,
  path: name,
  type: name === "src" ? "tree" : "blob",
  oid: name,
}));
const commit = (oid: string): CommitSummary => ({
  oid,
  message: `Change ${oid}`,
  authorName: "Ann",
  authorEmail: "ann@example.com",
  authoredAt: 1_790_000_000,
  parents: [],
});
const historyPage = (names: string[], next: string | null): HistoryPage => ({
  ref: HEAD,
  head: HEAD,
  path: "",
  scanned: 100,
  next,
  commits: [commit(`${names.join("-")}-commit`)],
  entries: Object.fromEntries(names.map((name) => [name, { latest: commit(name), count: 1 }])),
});

let reads: URL[] = [];
let answers: HistoryPage[] = [];
let unmount: (() => void) | null = null;
beforeEach(() => {
  forgetAllRepoData();
  reads = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      reads.push(new URL(input instanceof Request ? input.url : input, location.origin));
      const answer = answers.shift();
      return answer
        ? Response.json(answer)
        : Response.json({ error: "Unexpected read." }, { status: 500 });
    }),
  );
});
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

function mount() {
  let state: HistoryState | null = null;
  function Probe() {
    state = useHistory(repo, HEAD, "", entries);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return () => state!;
}

test("one cover request answers a folder whose entries all have a last change", async () => {
  answers = [historyPage(["LICENSE", "src"], "b".repeat(40))];
  const state = mount();
  await expect.poll(() => state().loading).toBe(false);
  expect(reads).toHaveLength(1);
  expect(reads[0]!.pathname).toBe("/api/repos/orbit/engine/history");
  expect(reads[0]!.searchParams.get("entries")).toBe("true");
  expect(reads[0]!.searchParams.get("cover")).toBe("1");
  expect(state().history?.entries.LICENSE?.latest.oid).toBe("LICENSE");
});

test("a cut-short answer still pages on from next, with cover", async () => {
  const cursor = "c".repeat(40);
  answers = [historyPage(["src"], cursor), historyPage(["LICENSE"], null)];
  const state = mount();
  await expect.poll(() => reads.length).toBe(2);
  await expect.poll(() => state().loading).toBe(false);
  expect(reads[1]!.searchParams.get("cursor")).toBe(cursor);
  expect(reads[1]!.searchParams.get("cover")).toBe("1");
  expect(Object.keys(state().history?.entries ?? {}).sort()).toEqual(["LICENSE", "src"]);
  expect(reads).toHaveLength(2);
});

test("a folder's history link counts commits only once its history is complete", () => {
  expect(folderHistoryLabel(null)).toBe("History");
  expect(folderHistoryLabel(historyPage(["LICENSE", "src"], "b".repeat(40)))).toBe("History");
  const complete = historyPage(["LICENSE", "src"], null);
  expect(folderHistoryLabel(complete)).toBe("1 commit");
  expect(folderHistoryLabel({ ...complete, commits: Array(447).fill(commit("x")) })).toBe(
    "447 commits",
  );
});
