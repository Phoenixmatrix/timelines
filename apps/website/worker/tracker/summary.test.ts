// A repository's tracker summary (the About panel's "Issues · N ready") and
// the Space tracker behind it, over the browser tests' in-memory world: real
// explicit Space grants and tracker storage. Formerly a browser test that
// rendered nothing.

import { expect, onTestFinished, test, vi } from "vite-plus/test";
import type { RepoIssueSummary } from "../../shared/api.ts";
import { CONTENT_CONTRACT_HEADER, CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";
import type { Snapshot } from "../../shared/tracker.ts";
import { serve, world } from "../testing/browser-api.ts";

vi.mock("cloudflare:email", () => ({ EmailMessage: class {} }));

async function setup() {
  const { world: id } = (await world("create", { persona: "marco" })) as { world: string };
  onTestFinished(async () => {
    await world("dispose", { world: id });
  });
  const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const served = await serve({
      world: id,
      method,
      url,
      headers: [
        [CONTENT_CONTRACT_HEADER, String(CONTENT_CONTRACT_VERSION)],
        ...(body === undefined ? [] : ([["content-type", "application/json"]] as const)),
      ] as [string, string][],
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (served.status >= 400) throw new Error(`${method} ${url}: ${served.status}`);
    return (served.body ? JSON.parse(served.body) : undefined) as T;
  };
  return { id, call };
}

test("Space teams and repo counts require explicit grants, not public repo visibility", async () => {
  const { id, call } = await setup();
  const repo = (await world("repo", { world: id, space: "orbit", name: "engine" })) as {
    id: string;
  };
  const snapshot = await call<Snapshot>("GET", "/api/tracker/orbit/snapshot");
  await call("POST", "/api/tracker/orbit/mutate", {
    contractVersion: snapshot.contractVersion,
    spaceId: snapshot.spaceId,
    migrationEpoch: snapshot.migrationEpoch,
    operationId: crypto.randomUUID(),
    mutations: [
      { kind: "team.create", id: "eng", data: { key: "ENG", name: "Engineering" } },
      { kind: "project.create", id: "workspace", data: { slug: "engine", name: "Engine" } },
      {
        kind: "subscription.add",
        id: "subscription",
        data: { projectId: "workspace", repoId: repo.id },
      },
      {
        kind: "issue.create",
        id: "ready",
        data: { teamId: "eng", title: "Ready work", status: "todo", projectIds: ["workspace"] },
      },
    ],
  });
  const summary = () => call<RepoIssueSummary>("GET", "/api/repos/orbit/engine/tracker/summary");
  expect((await call<Snapshot>("GET", "/api/tracker/orbit/snapshot")).teams).toEqual([
    expect.objectContaining({ id: "eng", key: "ENG", name: "Engineering" }),
  ]);
  expect(await summary()).toEqual({ ready: 1, projects: 1 });
  expect((await call<Snapshot>("GET", "/api/tracker/marco/snapshot")).teams).toEqual([]);
  // Revoke only the Space grant; Organization membership and the public repository remain.
  await world("sql", {
    world: id,
    statement:
      "DELETE FROM space_grants WHERE space_id = (SELECT id FROM spaces WHERE slug = 'orbit') AND account_id = 'acc_marco'",
  });
  await expect(call("GET", "/api/tracker/orbit/snapshot")).rejects.toThrow("403");
  expect(await summary()).toEqual({ ready: null, projects: 0 });
  expect(
    (await call<{ canManage: boolean }>("GET", "/api/repos/orbit/engine/tracker")).canManage,
  ).toBe(false);
  await world("as", { world: id, persona: "priya" });
  // Site-wide repository administration still does not grant private tracker access.
  await expect(call("GET", "/api/tracker/orbit/snapshot")).rejects.toThrow("403");
  expect(await summary()).toEqual({ ready: null, projects: 0 });
  await world("as", { world: id, persona: null });
  await expect(call("GET", "/api/tracker/orbit/snapshot")).rejects.toThrow("401");
  await expect(call("GET", "/api/tracker/marco/snapshot")).rejects.toThrow("401");
  expect(await summary()).toEqual({ ready: null, projects: 0 });
});
