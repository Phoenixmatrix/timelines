import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Snapshot } from "../../apps/website/shared/tracker.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";
import { contentHeaders, fixtureSpace } from "./content-fixtures.ts";

/** Real seeded grants: Organization ownership alone never authorizes private Space content. */
export async function spaceBoundaryScenario(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  json: <T>(
    path: string,
    token: string | null,
    method?: string,
    body?: unknown,
    statuses?: number[],
  ) => Promise<T>,
  record: (value: unknown) => void,
) {
  const marco = fixtures.tokens.marco;
  const jun = fixtures.tokens.jun;
  const sam = fixtures.tokens.sam;
  const orbit = await fixtureSpace(ctx.origin, "orbit", marco);
  const research = await fixtureSpace(ctx.origin, "orbit-research", jun);
  const nova = await fixtureSpace(ctx.origin, "nova", sam);
  const novaResearch = await fixtureSpace(ctx.origin, "nova-research", sam);
  assert.equal(orbit.space.organizationId, research.space.organizationId);
  assert.equal(nova.space.organizationId, novaResearch.space.organizationId);
  assert.notEqual(orbit.space.organizationId, nova.space.organizationId);
  assert.equal(
    new Set([orbit.space.id, research.space.id, nova.space.id, novaResearch.space.id]).size,
    4,
  );
  for (const version of [undefined, "3"]) {
    const response = await fetch(`${ctx.origin}/api/tracker/orbit/snapshot`, {
      headers: {
        authorization: `Bearer ${marco}`,
        ...(version ? { "X-Gitmatrix-Content-Version": version } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 426, "Missing/obsolete clients must not read a widened view");
    assert.equal(((await response.json()) as { code: string }).code, "client_upgrade_required");
  }
  await json("/api/repos/orbit-research/boundary-private", jun);
  await json("/api/repos/nova/boundary-private", sam);
  const denied = [
    { space: "orbit-research", token: marco }, // Organization owner, no grant.
    { space: "nova", token: marco },
    { space: "nova-research", token: marco },
    { space: "nova-research", token: sam }, // Explicit repo:none, independent package:read.
  ];
  for (const { space, token } of denied) {
    for (const suffix of ["", "/atlas/overview", "/knowledge/status"]) {
      const read = async (name: string) => {
        const response = await fetch(`${ctx.origin}/api/repos/${space}/${name}${suffix}`, {
          headers: { ...contentHeaders, authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        });
        return { status: response.status, body: await response.text() };
      };
      const hidden = await read("boundary-private");
      const missing = await read(`absent-${randomUUID()}`);
      assert.equal(hidden.status, 404);
      assert.deepEqual(
        hidden,
        missing,
        "Private and absent repository content must be byte-identical",
      );
    }
    const git = await fetch(
      `${ctx.origin}/${space}/boundary-private.git/info/refs?service=git-upload-pack`,
      {
        headers: { authorization: `Bearer ${token}` }, // Native Git is not a JSON content client.
        signal: AbortSignal.timeout(30_000),
      },
    );
    assert(
      [403, 404].includes(git.status),
      "Native Git must enforce the same Space repository baseline",
    );
    await git.arrayBuffer();
  }
  for (const space of ["orbit-research", "nova", "nova-research"]) {
    await json(`/api/tracker/${space}/snapshot`, marco, "GET", undefined, [403]);
    await json(`/api/spaces/${space}/ai-providers`, marco, "GET", undefined, [404]);
  }

  const team = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  const foreign = randomUUID();
  const issue = randomUUID();
  const tag = randomUUID().slice(0, 8);
  await json("/api/tracker/orbit/mutate", marco, "POST", {
    operationId: randomUUID(),
    mutations: [
      {
        kind: "team.create",
        id: team,
        data: { key: `S${tag.slice(0, 4).toUpperCase()}`, name: "Space fixture" },
      },
      { kind: "project.create", id: first, data: { slug: `first-${tag}`, name: "First" } },
      { kind: "project.create", id: second, data: { slug: `second-${tag}`, name: "Second" } },
      {
        kind: "issue.create",
        id: issue,
        data: { teamId: team, projectIds: [first, second], title: "Two same-Space Projects" },
      },
    ],
  });
  await json("/api/tracker/orbit-research/mutate", jun, "POST", {
    operationId: randomUUID(),
    mutations: [
      {
        kind: "project.create",
        id: foreign,
        data: { slug: `foreign-${tag}`, name: "Other Space" },
      },
    ],
  });
  const before = (await json<Snapshot>("/api/tracker/orbit/snapshot", marco)).issues.find(
    (value) => value.id === issue,
  )!;
  assert.equal(before.teamId, team);
  assert.deepEqual(new Set(before.projectIds), new Set([first, second]));
  for (const invalid of [
    { contractVersion: 3, code: "client_upgrade_required" },
    { migrationEpoch: orbit.migrationEpoch + 1, code: "migration_epoch_mismatch" },
    { spaceId: research.space.id, code: "space_mismatch" },
  ]) {
    const { code, ...scope } = invalid;
    const failure = await json<{ code: string }>(
      "/api/tracker/orbit/mutate",
      marco,
      "POST",
      {
        ...scope,
        operationId: randomUUID(),
        mutations: [
          {
            kind: "issue.update",
            id: issue,
            expectedVersion: before.version,
            data: { title: "Must not commit" },
          },
        ],
      },
      [409],
    );
    assert.equal(failure.code, code);
  }
  await json(
    "/api/tracker/orbit/mutate",
    marco,
    "POST",
    {
      operationId: randomUUID(),
      mutations: [
        {
          kind: "issue.update",
          id: issue,
          expectedVersion: before.version,
          data: { projectIds: [first, foreign] },
        },
      ],
    },
    [400, 404, 409, 422],
  );
  const after = (await json<Snapshot>("/api/tracker/orbit/snapshot", marco)).issues.find(
    (value) => value.id === issue,
  )!;
  assert.deepEqual(
    after,
    before,
    "A cross-Space Project association fails atomically without changing issue/key/team",
  );
  record({
    spaces: [orbit.space.id, research.space.id, nova.space.id, novaResearch.space.id],
    denied: denied.length,
    issue,
    projects: [first, second],
  });
}
