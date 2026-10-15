import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  forgetAllRepoData,
  forgetRepoData,
  forgetTimelineReads,
  repoData,
  requestSource,
  routeData,
  setRepoDataByteLimit,
} from "./repoData.ts";
import { accessChanged } from "./session.ts";
import { signInAction } from "../routes/SignIn.tsx";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
let reads: string[] = [];
let status = 200;
/** Makes each response about this much longer. */
let pad = "";
/** A read's status (by default `status`), and what happens as it is made. */
let statusOf: (input: string) => number = () => status;
let onRead: (input: string) => void = () => {};

beforeEach(() => {
  forgetAllRepoData();
  reads = [];
  status = 200;
  pad = "";
  statusOf = () => status;
  onRead = () => {};
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      reads.push(input);
      onRead(input);
      const answer = statusOf(input);
      return new Response(
        JSON.stringify(
          answer === 200
            ? { read: reads.length, pad: input.includes("huge") ? "x".repeat(2000) : pad }
            : { error: "no" },
        ),
        {
          status: answer,
          headers: { "content-type": "application/json" },
        },
      );
    }),
  );
});

afterEach(() => {
  setRepoDataByteLimit();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a branch read is reused for 15 seconds, then read again", async () => {
  await repoData.tree("orbit", "demo", "main/src");
  vi.advanceTimersByTime(14_000);
  await repoData.tree("orbit", "demo", "main/src");
  expect(reads).toHaveLength(1);
  vi.advanceTimersByTime(2_000);
  await repoData.tree("orbit", "demo", "main/src");
  expect(reads).toHaveLength(2);
});

test("the key is the whole request: another path, ref, repository or source is its own read", async () => {
  await repoData.tree("orbit", "demo", "main/src");
  await repoData.tree("orbit", "demo", "main/docs");
  await repoData.tree("orbit", "other", "main/src");
  await repoData.tree("nova", "demo", "main/src");
  await repoData.tree("orbit", "demo", "main/src", "src_work");
  expect(reads).toHaveLength(5);
});

const blobRead = "/api/repos/orbit/demo/blob?at=" + encodeURIComponent(`${COMMIT}/README.md`);
const detailRead = "/api/repos/orbit/demo?metadata=1";

test("a commit-id read is kept, but reauthorized by the repository's metadata after 15 seconds", async () => {
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  vi.advanceTimersByTime(24 * 60 * 60_000);
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  // The blob itself isn't read again; the repository's metadata is.
  expect(reads).toEqual([blobRead, detailRead]);
  // Through a work source it is a short-lived read like a branch's.
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`, "src_work");
  vi.advanceTimersByTime(16_000);
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`, "src_work");
  expect(reads.filter((read) => read.includes("source=src_work"))).toHaveLength(2);
});

test("within 15 seconds of a successful read of its repository, a commit-id read asks nothing", async () => {
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  vi.advanceTimersByTime(14_000);
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  expect(reads).toEqual([blobRead]);
  // Another read of the repository (here its branches, 20 s later) authorizes it afresh.
  vi.advanceTimersByTime(6_000);
  await repoData.tree("orbit", "demo", "main");
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  expect(reads).toHaveLength(2);
});

test("a commit-id read whose repository is refused on reauthorization drops it and fails", async () => {
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  await repoData.blob("orbit", "other", `${COMMIT}/README.md`);
  vi.advanceTimersByTime(16_000);
  status = 403;
  const refused = await routeData(repoData.blob("orbit", "demo", `${COMMIT}/README.md`)).catch(
    (error: unknown) => error,
  );
  // The error a loader shows: the metadata read's refusal.
  expect(refused).toMatchObject({ init: { status: 403 } });
  expect(reads.at(-1)).toBe(detailRead);
  status = 200;
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  expect(reads.at(-1)).toBe(blobRead);
});

test("the cache is bounded by size, and expired branch reads go first", async () => {
  pad = "x".repeat(60);
  // Each entry is about 75 bytes: two fit.
  setRepoDataByteLimit(160);
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  await repoData.tree("orbit", "demo", "main/a");
  vi.advanceTimersByTime(16_000);
  // The expired branch read is dropped to make room, not the blob.
  await repoData.tree("orbit", "demo", "main/b");
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  expect(reads.filter((read) => read === blobRead)).toHaveLength(1);
  // Three live entries don't fit: the least recently used goes.
  await repoData.tree("orbit", "demo", "main/c");
  await repoData.tree("orbit", "demo", "main/b");
  expect(reads.filter((read) => read.includes("main%2Fb"))).toHaveLength(2);
});

test("a response larger than the whole budget is returned but not kept, and evicts nothing", async () => {
  setRepoDataByteLimit(1000);
  await repoData.blob("orbit", "demo", `${COMMIT}/a`);
  await repoData.blob("orbit", "demo", `${COMMIT}/b`);
  const huge = await repoData.blob("orbit", "demo", `${COMMIT}/huge`);
  expect(JSON.stringify(huge).length).toBeGreaterThan(1000);
  const before = reads.length;
  await repoData.blob("orbit", "demo", `${COMMIT}/a`);
  await repoData.blob("orbit", "demo", `${COMMIT}/b`);
  expect(reads.slice(before)).toEqual([]);
  await repoData.blob("orbit", "demo", `${COMMIT}/huge`);
  expect(reads.slice(before)).toHaveLength(1);
});

test("an unauthenticated read (401) empties the whole cache", async () => {
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  await repoData.tree("nova", "other", "main");
  status = 401;
  await expect(repoData.tree("orbit", "third", "main")).rejects.toThrow();
  status = 200;
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  await repoData.tree("nova", "other", "main");
  expect(reads).toHaveLength(5);
});

test("a timeline's end drops its detail and the branch reads of its Spaces, not commit reads", async () => {
  const scoped = (path: string) => new Request(`https://gitmatrix.test${path}?tl=work`);
  // requestSource reads the timeline's detail (this stub's isn't one, so it then fails).
  await requestSource("orbit", "demo", scoped("/orbit/demo")).catch(() => null);
  await repoData.tree("orbit", "demo", "main");
  await repoData.tree("nova", "lib", "main");
  await repoData.tree("elsewhere", "lib", "main");
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  const before = reads.length;
  forgetTimelineReads("orbit", ["nova"]);
  await requestSource("orbit", "demo", scoped("/orbit/demo")).catch(() => null);
  await repoData.tree("orbit", "demo", "main");
  await repoData.tree("nova", "lib", "main");
  await repoData.tree("elsewhere", "lib", "main");
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  expect(reads.slice(before)).toEqual([
    "/api/tracker/orbit/timelines/work",
    "/api/repos/orbit/demo/tree?at=main",
    "/api/repos/nova/lib/tree?at=main",
  ]);
});

test("a prefetch still in flight serves the click that follows it", async () => {
  const hover = repoData.detail("orbit", "demo");
  const click = repoData.detail("orbit", "demo");
  expect(click).toBe(hover);
  await click;
  expect(reads).toHaveLength(1);
});

test("sign-in, sign-out or an account switch empties the cache, immutable reads included", async () => {
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  await repoData.tree("orbit", "demo", "main");
  accessChanged();
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  await repoData.tree("orbit", "demo", "main");
  expect(reads).toHaveLength(4);
});

test("a refused read (403) drops everything cached for that repository", async () => {
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  await repoData.blob("orbit", "other", `${COMMIT}/README.md`);
  status = 403;
  await expect(repoData.tree("orbit", "demo", "main")).rejects.toThrow();
  status = 200;
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  await repoData.blob("orbit", "other", `${COMMIT}/README.md`);
  // demo's commit read is asked again; other's stays.
  expect(reads).toHaveLength(4);
});

test("failures are not cached, and forgetting a repository leaves the others", async () => {
  status = 500;
  await expect(repoData.tree("orbit", "demo", "main")).rejects.toThrow();
  status = 200;
  await repoData.tree("orbit", "demo", "main");
  await repoData.tree("orbit", "other", "main");
  forgetRepoData("orbit", "demo");
  await repoData.tree("orbit", "demo", "main");
  await repoData.tree("orbit", "other", "main");
  expect(reads).toHaveLength(4);
});

test("signing out empties the cache", async () => {
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  const signOut = new Request("https://gitmatrix.test/signin?intent=signout", {
    method: "POST",
    body: new FormData(),
  });
  const response = await signInAction({ request: signOut });
  expect((response as Response).headers.get("location")).toBe("/signin");
  expect(reads).toEqual([
    "/api/repos/orbit/demo/blob?at=" + encodeURIComponent(`${COMMIT}/README.md`),
    "/api/session",
  ]);
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  expect(reads).toHaveLength(3);
});

test("a 404 below the repository (no graph node, a dead path, an unknown ref) keeps its cache", async () => {
  statusOf = (input) =>
    input.includes("/knowledge/graph/node") || input.includes("gone") ? 404 : 200;
  // A Code page: the layout's metadata, the tree, then the About rail's graph node (AI off).
  await repoData.detail("orbit", "demo", null, true);
  await repoData.tree("orbit", "demo", `${COMMIT}/src`);
  await expect(repoData.graphNode("orbit", "demo", "repo")).rejects.toThrow();
  await expect(repoData.blob("orbit", "demo", `${COMMIT}/gone.md`)).rejects.toThrow();
  await expect(repoData.history("orbit", "demo", "gone-branch")).rejects.toThrow();
  const before = reads.length;
  await repoData.detail("orbit", "demo", null, true);
  await repoData.tree("orbit", "demo", `${COMMIT}/src`);
  expect(reads.slice(before)).toEqual([]);
});

test("a 404 for the repository itself (lost access) drops its cache", async () => {
  await repoData.tree("orbit", "demo", `${COMMIT}/src`);
  await repoData.tree("orbit", "other", `${COMMIT}/src`);
  statusOf = (input) => (input === "/api/repos/orbit/demo" ? 404 : 200);
  await expect(repoData.detail("orbit", "demo")).rejects.toThrow();
  const before = reads.length;
  await repoData.tree("orbit", "demo", `${COMMIT}/src`);
  await repoData.tree("orbit", "other", `${COMMIT}/src`);
  expect(reads.slice(before)).toEqual([
    "/api/repos/orbit/demo/tree?at=" + encodeURIComponent(`${COMMIT}/src`),
  ]);
});

test("a reauthorization slower than the window serves the entry once it succeeds", async () => {
  await repoData.blob("orbit", "demo", `${COMMIT}/README.md`);
  vi.advanceTimersByTime(60_000);
  // The metadata read takes 16 s.
  onRead = (input) => {
    if (input === detailRead) vi.advanceTimersByTime(16_000);
  };
  await expect(repoData.blob("orbit", "demo", `${COMMIT}/README.md`)).resolves.toBeTruthy();
  expect(reads).toEqual([blobRead, detailRead]);
});
