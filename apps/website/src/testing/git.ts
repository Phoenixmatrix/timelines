// Canned git reads for browser-mode tests. The in-memory API's repositories
// have refs but no objects (worker/testing/browser-api.ts): a page that lists
// files or history gets these instead, at `head`.

import type { CommitSummary, HistoryPage, TreeResponse } from "../../shared/api.ts";
import type { TestServer } from "./server.ts";

export function cannedFiles(server: TestServer, head: string, files = ["README.md"]): void {
  const commit: CommitSummary = {
    oid: head,
    message: "Fixture",
    authorName: "Fixture",
    authorEmail: "fixture@gitmatrix.invalid",
    authoredAt: 0,
    parents: [],
  };
  const at = (url: URL) => url.searchParams.get("at") || "main";
  server.on("GET", "/api/repos/:space/:name/tree", ({ url }): TreeResponse => ({
    ref: at(url),
    path: "",
    commit,
    entries: files.map((path) => ({ name: path, path, type: "blob", oid: head })),
    readme: null,
  }));
  server.on("GET", "/api/repos/:space/:name/history", ({ url }): HistoryPage => ({
    ref: at(url),
    head,
    path: "",
    scanned: 1,
    next: null,
    commits: [commit],
    entries: {},
  }));
}
