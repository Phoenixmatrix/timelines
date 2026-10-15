import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { Snapshot } from "../../../shared/tracker.ts";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";

test("completion evidence is distinct, attributable and optional when finishing or reopening", async () => {
  const server = await TestServer.start({ world: true });
  const repo = await server.repo("orbit", "engine");
  await server.call("POST", "/api/tracker/orbit/mutate", {
    ...(await server.trackerContract("orbit")),
    operationId: crypto.randomUUID(),
    mutations: [
      {
        kind: "team.create",
        id: "team",
        data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
      },
      { kind: "project.create", id: "project", data: { slug: "parcels", name: "Parcels" } },
      { kind: "subscription.add", id: "sub", data: { projectId: "project", repoId: repo.id } },
      {
        kind: "issue.create",
        id: "work",
        data: { teamId: "team", title: "Verify parcels", projectIds: ["project"] },
      },
      {
        kind: "comment.add",
        id: "historical",
        data: { issueId: "work", kind: "evidence", body: "Earlier verification at abc123" },
      },
      {
        kind: "comment.add",
        id: "discussion",
        data: { issueId: "work", kind: "comment", body: "Ordinary discussion" },
      },
    ],
  });
  renderApp("/tracker/orbit/issues/ENG-1");
  const evidence = page.getByRole("region", { name: "Evidence of completion" });
  await expect.element(evidence.getByText("Earlier verification at abc123")).toBeVisible();
  await expect.element(evidence.getByText("Ordinary discussion")).not.toBeInTheDocument();
  await userEvent.click(evidence.getByRole("button", { name: "Add completion evidence" }));
  await userEvent.fill(
    page.getByRole("textbox", { name: "Activity note" }),
    "Verified modulus 65521 at def456",
  );
  await userEvent.click(page.getByRole("button", { name: "Save completion evidence" }));
  await expect.element(evidence.getByText("Verified modulus 65521 at def456")).toBeVisible();
  const before = await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
  expect(before.comments.filter((c) => c.kind === "evidence")).toHaveLength(2);
  expect(before.comments.find((c) => c.body === "Verified modulus 65521 at def456")).toMatchObject({
    actorId: "acc_marco",
  });
  const endpoint = "/api/repos/orbit/engine/knowledge/completion-evidence?q=ENG-1";
  const found = await server.call("GET", endpoint);
  expect(found).toMatchObject({
    evidence: expect.arrayContaining(
      before.comments
        .filter((c) => c.kind === "evidence")
        .map((c) =>
          expect.objectContaining({
            ...c,
            trackerSpace: "orbit",
            url: `/tracker/orbit/issues/ENG-1#evidence-${c.id}`,
          }),
        ),
    ),
    truncated: false,
  });
  // Sam may read the public repository, but is not a tracker member.
  expect(await server.call("GET", endpoint, undefined, "sam")).toMatchObject({ evidence: [] });
  await expect(server.call("GET", endpoint, undefined, null)).rejects.toThrow(/401/);

  await userEvent.click(page.getByRole("button", { name: "Edit issue" }));
  const status = page.getByRole("combobox", { name: "Issue status" });
  await userEvent.selectOptions(status, "done");
  await expect
    .poll(
      async () =>
        (await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot")).issues[0]?.status,
    )
    .toBe("done");
  await userEvent.selectOptions(status, "todo");
  await expect
    .poll(
      async () =>
        (await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot")).issues[0]?.status,
    )
    .toBe("todo");
  const after = await server.call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
  expect(after.comments).toEqual(before.comments);
  await expect.element(evidence.getByText("Earlier verification at abc123")).toBeVisible();
});

test("router evidence citations scroll after issue navigation and hash-only navigation, not refresh", async () => {
  const server = await TestServer.start({ world: true });
  await server.call("POST", "/api/tracker/orbit/mutate", {
    ...(await server.trackerContract("orbit")),
    operationId: crypto.randomUUID(),
    mutations: [
      {
        kind: "team.create",
        id: "team",
        data: { key: "ENG", name: "Engineering", memberIds: ["acc_marco"] },
      },
      {
        kind: "issue.create",
        id: "target",
        data: { teamId: "team", title: "Evidence destination" },
      },
      { kind: "issue.create", id: "origin", data: { teamId: "team", title: "Navigation origin" } },
      ...["first-proof", "second-proof", "last-proof"].map((id) => ({
        kind: "comment.add",
        id,
        data: {
          issueId: "target",
          kind: "evidence",
          body: `${id}\n\n${"A recorded verification paragraph.\n\n".repeat(30)}`,
        },
      })),
    ],
  });
  const app = renderApp("/tracker/orbit/issues/ENG-2");
  await expect.element(page.getByText("Navigation origin", { exact: true }).first()).toBeVisible();
  // Data-router navigation is the path used by assistant citation Links.
  await app.navigate("/tracker/orbit/issues/ENG-1#evidence-first%2Dproof");
  await expect
    .poll(() => {
      const target = document.getElementById("evidence-first-proof");
      return target ? Math.round(target.getBoundingClientRect().top) : -1;
    })
    .toBeGreaterThanOrEqual(0);
  await expect
    .poll(() => document.getElementById("evidence-first-proof")!.getBoundingClientRect().top)
    .toBeLessThan(window.innerHeight / 2);

  await app.navigate("#evidence-second-proof");
  await expect
    .poll(() => document.getElementById("evidence-second-proof")!.getBoundingClientRect().top)
    .toBeLessThan(window.innerHeight / 2);
  expect(
    document.getElementById("evidence-first-proof")!.getBoundingClientRect().bottom,
  ).toBeLessThanOrEqual(
    document.getElementById("evidence-second-proof")!.getBoundingClientRect().top,
  );

  // A background loader refresh must not jump back to the hash after the
  // reader scrolls elsewhere, nor move keyboard focus.
  const first = document.getElementById("evidence-first-proof")!;
  first.scrollIntoView();
  const detail = first.closest("article")!;
  detail.focus({ preventScroll: true });
  const before = first.getBoundingClientRect().top;
  await app.router.revalidate();
  await expect.poll(() => app.router.state.revalidation).toBe("idle");
  expect(Math.abs(first.getBoundingClientRect().top - before)).toBeLessThan(2);
  expect(document.activeElement).toBe(detail);
});
