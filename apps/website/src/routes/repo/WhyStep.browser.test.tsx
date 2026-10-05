// Why on a line, with its step (CORE-243), in a real browser: a file's line
// opens its why chain, and the chain shows the step context behind the
// commit, linked into the timeline's story. History and blame are canned.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { BlobResponse } from "../../../shared/api.ts";
import type { Step } from "../../../shared/steps.ts";
import type { WhyChain, WhyResponse } from "../../../shared/why.ts";
import { commitId } from "../../testing/atlas.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";

test("a line's why shows the step behind its commit, into the story", async () => {
  const server = await TestServer.start({ world: true });
  await server.repo("orbit", "engine");
  const head = commitId();
  await server.push("orbit/engine", "main", head);
  const [landed, before] = [commitId(), commitId()];
  server.on("GET", "/api/repos/:owner/:name/blob", (): BlobResponse => ({
    ref: "main",
    commitOid: head,
    path: "src/rank.ts",
    size: 30,
    contentType: "text/plain",
    binary: false,
    text: "a\nrankByTitle()\nc\n",
    truncated: false,
  }));
  const step: Step = {
    changeId: "kpqrstuvkpqrstuv",
    commitOid: before,
    summary: "Rank search by title",
    timeline: "search",
    issue: "CORE-7",
    author: {
      id: "agt_bot",
      kind: "agent",
      name: "bot",
      accountable: { id: "acc_ann", slug: "ann", displayName: "Ann", avatarUrl: null },
    },
    committedAt: "2026-10-03T01:00:00.000Z",
    verified: true,
    deleted: false,
    context: {
      instructions: [{ text: "Rank by title", source: "hook" }],
      steering: [{ text: "Keep it simple", source: "hook" }],
      why: "Titles match what people type.\nMore detail.",
      challenges: "The index lacked titles.",
      tests: [{ command: "vp test", exit: 0, summary: "ok", origin: "local" }],
      coverage: { instructions: "hook:claude-code", steering: "hook:claude-code" },
      harness: "claude-code",
      model: null,
    },
    artifacts: [],
  };
  const chain = (oid: string, over: Partial<WhyChain>): WhyChain =>
    ({
      commit: {
        oid,
        message: "Rank search by title (CORE-7)",
        authorName: "Ann",
        authorEmail: "a@x",
        authoredAt: 1_790_000_000,
        parents: [],
      },
      oid,
      lines: [2],
      changeId: "kpqrstuvkpqrstuv",
      changeSource: "push-log",
      refs: [],
      timelines: [],
      merges: [],
      issues: [],
      checkpoints: [],
      approval: null,
      landing: null,
      discussions: {
        available: false,
        reason: "Discussions (CORE-51) aren't available yet.",
        threads: [],
      },
      step: null,
      ...over,
    }) as WhyChain;
  server.on("GET", "/api/repos/:owner/:name/why", (): WhyResponse => ({
    repo: { owner: "orbit", name: "engine", defaultBranch: "main" },
    tracker: { owner: "orbit", readable: true },
    blame: null,
    chains: [chain(landed, { step })],
    people: {},
  }));

  renderApp("/orbit/engine/blob/main/src/rank.ts#L2");
  await userEvent.click(
    page
      .getByRole("group", { name: "Selected source lines" })
      .getByRole("button", { name: "Why?" }),
  );
  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toMatchTextContent(/Step context/);
  await expect
    .element(dialog)
    .toMatchTextContent(new RegExp(`By bot for Ann, recorded on ${before.slice(0, 7)}`));
  await expect.element(dialog).toMatchTextContent(/Why: Titles match what people type\./);
  await expect.element(dialog).toMatchTextContent(/Challenges: The index lacked titles\./);
  await expect.element(dialog).toMatchTextContent(/1 instruction, 1 steering \(hook:claude-code\)/);
  await expect.element(dialog).toMatchTextContent(/1 tests passed/);
  const story = dialog.getByRole("link", { name: "Open in the timeline’s story" });
  await expect
    .element(story)
    .toHaveAttribute(
      "href",
      `/tracker/orbit/timelines/search/story?step=${landed}&repo=orbit%2Fengine`,
    );
});
