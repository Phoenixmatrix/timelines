// The landing panel (CORE-77) in the timeline inspector, in a real browser,
// against the tracker and timelines routes in memory. Land says why a
// timeline can't land yet (the route's 409: no checkpoint, needs approval,
// not green, stale). An approved checkpoint queues itself and merges; a
// conflict stops it and asks for a sync; Land again queues it afresh; a
// failed merge stops it too. Those runs end as rows a CI run leaves; the
// later states (testing, advancing, partly landed, landed), which need git
// objects and runners the world doesn't have, are canned.

import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { TimelineGraphData } from "../../../shared/timeline-graph.ts";
import type {
  Landing,
  LandingRepo,
  TimelineDetail,
  TimelineStatus,
} from "../../../shared/timelines.ts";
import { commitId, sidewaysOverflow } from "../../testing/atlas.ts";
import { focused, focusOn, press } from "../../testing/focus.ts";
import { renderApp } from "../../testing/render.tsx";
import { reply, TestServer } from "../../testing/server.ts";
import {
  askApproval,
  checkpoint,
  ciRun,
  landing,
  mergeRunEnded,
  mutate,
  timelineWorld,
  type WorldTimeline,
} from "../../testing/timelines.ts";

const short = (oid: string) => oid.slice(0, 7);
const inspector = () => page.getByRole("region", { name: "Selected timeline" });
const panel = () => inspector().getByRole("region", { name: "Landing" });
const landButton = () =>
  panel().getByRole("button", { name: /^Land( checkpoint #\d+)?( again)?$/ });
const repoRow = (name: string) =>
  panel()
    .getByRole("listitem")
    .filter({ has: page.getByText(`orbit/${name}`, { exact: true }) });

function inspect(timeline: WorldTimeline) {
  return renderApp(`/tracker/orbit/timelines?tl=${timeline.slug}`);
}

/** Land, and the reason the route gave for not landing. */
async function refused(reason: string) {
  // Enabled once the timeline's checkpoints have loaded.
  await expect.element(landButton()).toBeEnabled();
  await focusOn(landButton());
  await press("Enter");
  await expect.element(panel().getByRole("alert")).toHaveTextContent(reason);
  // The button stays, enabled and focused, to try again once it's fixed.
  await expect.element(landButton()).toBeEnabled();
  expect(focused()).toMatchObject({ role: "button", name: "Land checkpoint #1" });
}

test("Land says why a timeline can't land yet", async () => {
  const server = await TestServer.start({ world: true });
  const timeline = await timelineWorld(server);

  const app = inspect(timeline);
  await expect
    .element(panel())
    .toMatchTextContent(
      "Lands once a person approves a checkpoint: its compact result is tested before main moves.",
    );
  // Nothing to land yet: the button is off, and the panel says what to do first.
  await expect.element(landButton()).toBeDisabled();
  await expect
    .element(panel())
    .toMatchTextContent("Needs a checkpoint first: push, then gm timeline checkpoint.");
  await expect.element(landButton()).toHaveAccessibleDescription(/Needs a checkpoint first/);

  const view = await checkpoint(server, timeline, "Ranks results");
  app.unmount();
  const second = inspect(timeline);
  // With a checkpoint it names what it lands.
  await expect.element(landButton()).toHaveTextContent("Land checkpoint #1");
  await expect.element(landButton()).toBeEnabled();
  await refused(
    `Checkpoint #1 of search needs a person's approval to land; ask for it with gm issue ask --kind approval --checkpoint ${view.checkpoint.id}.`,
  );
  await askApproval(server, timeline, view.checkpoint.id);
  await refused(
    "Checkpoint #1 of search is waiting for a person's approval; it lands once approved.",
  );
  expect(await landing(server, timeline)).toBeNull();
  second.unmount();

  // An auto timeline lands once green; a failed run on its checkpoint isn't.
  const auto = { ...timeline, slug: "ranking", name: "Ranking" };
  const created = await server.call<TimelineDetail>("POST", "/api/tracker/orbit/timelines", {
    slug: auto.slug,
    name: auto.name,
    policy: "auto",
    repos: ["orbit/engine"],
  });
  // Its own work source in orbit/engine (CORE-255), not search's.
  const source = created.timeline.repos[0]!.source!;
  const engine = {
    ...timeline.repos[0]!,
    sourceId: source.sourceId,
    sourceRef: source.ref,
    tip: commitId(),
  };
  await server.push("orbit/engine", "work", engine.tip, engine.sourceId);
  await ciRun(server, {
    repo: engine,
    number: 3,
    commit: engine.tip,
    ref: "work",
    sourceId: engine.sourceId,
    status: "failed",
  });
  await checkpoint(server, { ...auto, repos: [engine] }, "Ranks by freshness");
  inspect(auto);
  await expect
    .element(panel())
    .toMatchTextContent(
      "Lands once a checkpoint's CI is green: its compact result is tested before main moves.",
    );
  await refused(
    "Checkpoint #1 isn't green: CI run #3 on orbit/engine failed. Push a fix and make a new checkpoint.",
  );

  // Commits since a checkpoint: the world has no push log to say so, so the
  // route's answer is canned.
  server.on("POST", "/api/tracker/:space/timelines/:slug/land", () =>
    reply(
      {
        error: "ranking has commits since checkpoint #1; make a new checkpoint to land them.",
        code: "checkpoint_stale",
      },
      409,
    ),
  );
  await refused("ranking has commits since checkpoint #1; make a new checkpoint to land them.");
});

test("an approved checkpoint lands: queued and merging, a conflict asks for a sync, Land again, a failed merge", async () => {
  const server = await TestServer.start({ world: true });
  const timeline = await timelineWorld(server);
  const view = await checkpoint(server, timeline, "Ranks results");
  const request = await askApproval(server, timeline, view.checkpoint.id);
  await mutate(server, [{ kind: "request.answer", id: request, data: { approved: true } }]);
  const queued = await landing(server, timeline);
  expect(queued).toMatchObject({ state: "merging", trigger: "approval" });
  const first = queued!.repos[0]!.mergeRun!.number;

  // Queued: merging into main, with its merge run, and nothing to press.
  let app = inspect(timeline);
  await expect
    .element(inspector())
    .toMatchTextContent(/Search\s*Landing[\s\S]*Lands\s*after approval/);
  await expect.element(panel()).toMatchTextContent("Checkpoint #1: Preparing the result on main");
  await expect.element(repoRow("engine")).toMatchTextContent("orbit/enginemerging");
  await expect
    .element(repoRow("engine").getByRole("link", { name: `Preparation #${first}` }))
    .toHaveAttribute("href", `/orbit/engine/ci/${first}?tl=search`);
  expect(landButton().elements()).toHaveLength(0);
  app.unmount();

  // The merge job reports a conflict: the landing stops and asks for a sync.
  expect(await mergeRunEnded(server, timeline, "conflict")).toMatchObject({ state: "conflict" });
  app = inspect(timeline);
  await expect.element(panel()).toMatchTextContent("Checkpoint #1: Stopped: conflicts with main");
  await expect.element(repoRow("engine")).toMatchTextContent("orbit/engineconflict");
  await expect
    .element(panel())
    .toMatchTextContent(
      `Checkpoint #1 conflicts with orbit/engine's main (CI run #${first} lists the files). Explicitly sync/rebase the owned work source, resolve conflicts, and renew the checkpoint and approval.`,
    );
  await expect
    .element(inspector())
    .toMatchTextContent(/Search\s*Active[\s\S]*Lands\s*after approval/);

  // Land again, by keyboard: the same approved checkpoint's landing, retried.
  const again = panel().getByRole("button", { name: "Land checkpoint #1 again" });
  await focusOn(again);
  const mark = server.requests.length;
  await press("Enter");
  await expect.element(panel()).toMatchTextContent("Checkpoint #1: Preparing the result on main");
  // The button went with the stop: focus is on where the landing stands now.
  await expect
    .poll(() => focused())
    .toMatchObject({ role: "p", name: "Checkpoint #1: Preparing the result on main" });
  expect(
    server
      .since(mark)
      .filter(
        (r) => r.method === "POST" && r.url.pathname === "/api/tracker/orbit/timelines/search/land",
      ),
  ).toHaveLength(1);
  const retry = await landing(server, timeline);
  expect(retry).toMatchObject({ state: "merging", trigger: "request" });
  // The same checkpoint's landing is retried in place (CORE-255): it keeps any
  // published outcome or CAS intent, and its merge starts afresh.
  expect(retry!.id).toBe(queued!.id);
  const second = retry!.repos[0]!.mergeRun!.number;
  expect(second).toBeGreaterThan(first);
  await expect
    .element(repoRow("engine").getByRole("link", { name: `Preparation #${second}` }))
    .toBeVisible();
  expect(landButton().elements()).toHaveLength(0);
  // The timeline is landing again: the inspector re-read it.
  await expect
    .element(inspector())
    .toMatchTextContent(/Search\s*Landing[\s\S]*Lands\s*after approval/);
  app.unmount();

  // This merge fails outright: stopped, with what to do.
  expect(await mergeRunEnded(server, timeline, "failed")).toMatchObject({ state: "failed" });
  inspect(timeline);
  await expect.element(panel()).toMatchTextContent("Checkpoint #1: Stopped");
  await expect.element(repoRow("engine")).toMatchTextContent("orbit/enginefailed");
  await expect
    .element(panel())
    .toMatchTextContent(
      `The merge into orbit/engine's main failed (CI run #${second}). Land again to retry.`,
    );
  await expect
    .element(panel().getByRole("button", { name: "Land checkpoint #1 again" }))
    .toBeEnabled();
});

describe("the later states, with the runs that merged and tested them", () => {
  const merge = { engine: commitId(), web: commitId() };

  /**
   * A two-repository timeline whose landing (canned: the world has no runner
   * or objects to get it there) is `state`, the timeline `status`.
   */
  async function landed(
    state: Landing["state"],
    status: TimelineStatus,
    repos: Record<"engine" | "web", Partial<LandingRepo>>,
    reason: string | null = null,
  ) {
    const server = await TestServer.start({ world: true });
    const timeline = await timelineWorld(server, { names: ["engine", "web"] });
    const view = await checkpoint(server, timeline, "Ranks results");
    const request = await askApproval(server, timeline, view.checkpoint.id);
    await mutate(server, [{ kind: "request.answer", id: request, data: { approved: true } }]);
    const queued = await landing(server, timeline);
    if (!queued) throw new Error("Approving the checkpoint did not create its landing");
    const canned: Landing = {
      id: "ld_canned",
      timelineId: view.timeline.id,
      slug: timeline.slug,
      checkpointId: view.checkpoint.id,
      checkpointNumber: 1,
      state,
      reason,
      trigger: "request",
      requestedBy: { actorId: "acc_marco", accountableId: "acc_marco", agentId: null },
      authority: queued.authority,
      version: 4,
      createdAt: "2026-10-04T10:00:00.000Z",
      updatedAt: "2026-10-04T10:05:00.000Z",
      repos: timeline.repos.map((repo) => ({
        // Each repository's approved work source, as the checkpoint measured it.
        source: view.checkpoint.repos.find((pinned) => pinned.id === repo.id)!.source,
        id: repo.id,
        space: repo.space,
        name: repo.name,
        commit: repo.tip,
        base: repo.main,
        merge: null,
        attempt: 1,
        state: "merging",
        mergeRun: null,
        gateRun: null,
        reason: null,
        ...repos[repo.name as "engine" | "web"],
      })),
    };
    server.on("GET", "/api/tracker/:space/timelines/:slug/landing", { landing: canned });
    server.on("GET", "/api/tracker/:space/timeline-graph", async () => {
      const data = await server.call<TimelineGraphData>("GET", "/api/tracker/orbit/timeline-graph");
      for (const t of data.timelines) if (t.slug === timeline.slug) t.status = status;
      return data;
    });
    inspect(timeline);
    return { server, timeline };
  }

  const run = (number: number) => ({ id: `run${number}`, number });

  test("testing: the merge, and the runs that merged and test it", async () => {
    const { timeline } = await landed("testing", "landing", {
      engine: { state: "testing", merge: merge.engine, mergeRun: run(3), gateRun: run(4) },
      web: { state: "tested", merge: merge.web, mergeRun: run(5), gateRun: run(6) },
    });
    await expect.element(panel()).toMatchTextContent("Checkpoint #1: Testing the result");
    await expect.element(repoRow("engine")).toMatchTextContent("orbit/enginetesting");
    await expect.element(repoRow("web")).toMatchTextContent("orbit/webpassed");
    await expect
      .element(
        repoRow("engine").getByRole("link", {
          name: `compact candidate ${short(merge.engine)}`,
        }),
      )
      .toHaveAttribute("href", `/orbit/engine?commit=${merge.engine}&tl=search`);
    // The approved work itself is read from its owned source, never canonical.
    const engine = timeline.repos.find((repo) => repo.name === "engine")!;
    await expect
      .poll(() =>
        new URL(
          repoRow("engine")
            .getByRole("link", { name: `approved source ${short(engine.tip)}` })
            .element()
            .getAttribute("href")!,
          location.origin,
        ).searchParams.get("source"),
      )
      .toBe(engine.sourceId);
    await expect
      .element(repoRow("engine").getByRole("link", { name: "Preparation #3" }))
      .toHaveAttribute("href", "/orbit/engine/ci/3?tl=search");
    await expect
      .element(repoRow("engine").getByRole("link", { name: "Gates #4" }))
      .toHaveAttribute("href", "/orbit/engine/ci/4?tl=search");
    await expect
      .element(repoRow("web").getByRole("link", { name: "Gates #6" }))
      .toHaveAttribute("href", "/orbit/web/ci/6?tl=search");
    expect(landButton().elements()).toHaveLength(0);
  });

  test("advancing: every merge passed; mains move one at a time", async () => {
    await landed("advancing", "landing", {
      engine: { state: "advanced", merge: merge.engine, mergeRun: run(3), gateRun: run(4) },
      // Not started yet: a run without its number isn't a link.
      web: { state: "tested", merge: merge.web, mergeRun: run(5), gateRun: { id: "g", number: 0 } },
    });
    await expect.element(panel()).toMatchTextContent("Checkpoint #1: Advancing main");
    await expect.element(repoRow("engine")).toMatchTextContent("orbit/enginemain advanced");
    await expect.element(repoRow("web")).toMatchTextContent("orbit/webpassed");
    await expect
      .element(repoRow("web").getByRole("link", { name: "Preparation #5" }))
      .toBeVisible();
    expect(repoRow("web").getByRole("link", { name: /Gates/ }).elements()).toHaveLength(0);
    expect(landButton().elements()).toHaveLength(0);
  });

  test("partly landed: one main advanced, the other merges again", async () => {
    await landed("merging", "partly_landed", {
      engine: { state: "advanced", merge: merge.engine, mergeRun: run(3), gateRun: run(4) },
      web: { state: "merging", attempt: 2, mergeRun: run(7) },
    });
    await expect
      .element(inspector())
      .toMatchTextContent(/Search\s*Partly landed[\s\S]*Lands\s*after approval/);
    await expect.element(panel()).toMatchTextContent("Checkpoint #1: Preparing the result on main");
    await expect.element(repoRow("engine")).toMatchTextContent("orbit/enginemain advanced");
    await expect.element(repoRow("web")).toMatchTextContent("orbit/webmerging");
    await expect
      .element(repoRow("web").getByRole("link", { name: "Preparation #7" }))
      .toHaveAttribute("href", "/orbit/web/ci/7?tl=search");
    expect(landButton().elements()).toHaveLength(0);
  });

  test("landed: every main advanced, and there's nothing left to land", async () => {
    await landed("landed", "landed", {
      engine: { state: "advanced", merge: merge.engine, mergeRun: run(3), gateRun: run(4) },
      web: { state: "advanced", merge: merge.web, mergeRun: run(5), gateRun: run(6) },
    });
    await expect.element(panel()).toMatchTextContent("Checkpoint #1: Landed");
    await expect.element(repoRow("engine")).toMatchTextContent("orbit/enginemain advanced");
    await expect.element(repoRow("web")).toMatchTextContent("orbit/webmain advanced");
    await expect
      .element(repoRow("web").getByRole("link", { name: `Landed commit ${short(merge.web)}` }))
      .toHaveAttribute("href", `/orbit/web?commit=${merge.web}&tl=search`);
    expect(landButton().elements()).toHaveLength(0);
  });

  test("a 320px phone: a stopped landing's reason wraps, and Land again is in reach", async () => {
    await page.viewport(320, 720);
    try {
      await landed(
        "conflict",
        "active",
        {
          engine: { state: "conflict", merge: null, mergeRun: run(3) },
          web: { state: "tested", merge: merge.web, mergeRun: run(5), gateRun: run(6) },
        },
        "Checkpoint #1 conflicts with orbit/engine's main (CI run #3 lists the files). Explicitly sync/rebase the owned work source, resolve conflicts, and renew the checkpoint and approval of timeline/search-with-a-long-name-that-does-not-break.",
      );
      await expect.element(panel()).toMatchTextContent("Stopped: conflicts with main");
      const again = panel().getByRole("button", { name: "Land checkpoint #1 again" });
      await expect.element(again).toBeEnabled();
      again.element().scrollIntoView({ block: "center" });
      await expect.element(again).toBeVisible();
      const box = again.element().getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(320);
      expect(box.height, "Land is a 44px touch target").toBeGreaterThanOrEqual(44);
      expect(sidewaysOverflow(), "The timelines page scrolls sideways").toBeLessThanOrEqual(0);
      const section = panel().element();
      expect(section.scrollWidth, "The landing panel overflows").toBeLessThanOrEqual(
        section.clientWidth,
      );
    } finally {
      await page.viewport(1280, 900);
    }
  });
});

test("selecting another timeline never shows the last one's checkpoint on Land (CORE-382)", async () => {
  const server = await TestServer.start({ world: true });
  const timeline = await timelineWorld(server);
  const view = await checkpoint(server, timeline, "Ranks results");
  await server.call("POST", "/api/tracker/orbit/timelines", {
    slug: "other",
    name: "Other",
    repos: ["orbit/engine"],
  });
  // The other timeline's checkpoints are slow to arrive; search's are known.
  let arrive!: () => void;
  const gate = new Promise<void>((resolve) => (arrive = resolve));
  server.on("GET", "/api/tracker/:owner/timelines/:slug/checkpoints", async ({ params }) => {
    if (params.slug === "other") await gate;
    return { checkpoints: params.slug === "other" ? [] : [view] };
  });
  const app = inspect(timeline);
  await expect.element(landButton()).toHaveTextContent("Land checkpoint #1");

  await app.navigate("/tracker/orbit/timelines?tl=other");
  await expect.element(inspector().getByRole("heading", { name: "Other" })).toBeVisible();
  await expect
    .element(inspector().getByRole("button", { name: "Land checkpoint #1" }))
    .not.toBeInTheDocument();
  arrive();
  await expect.element(landButton()).toBeDisabled();
});
