import assert from "node:assert/strict";
import type { SpacePage } from "../../apps/website/shared/spaces.ts";

export const contentHeaders = { "X-Gitmatrix-Content-Version": "4" } as const;

/** Resolve fixture scope from the live authorized directory, never from a person's ID. */
export async function fixtureSpace(
  origin: string,
  space: string,
  token: string,
): Promise<SpacePage> {
  const response = await fetch(`${origin}/api/spaces/${encodeURIComponent(space)}`, {
    headers: { ...contentHeaders, authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  assert.equal(response.status, 200, `Fixture Space ${space} must be accessible`);
  const page = (await response.json()) as SpacePage;
  assert.equal(page.contractVersion, 4);
  assert(page.space.id && Number.isInteger(page.migrationEpoch));
  return page;
}

/** Bind new scenario mutations to the authoritative scope and current epoch. */
export async function fixtureMutationBody(
  origin: string,
  path: string,
  token: string | null,
  body: unknown,
): Promise<unknown> {
  const match = /^\/(?:api\/)?tracker\/([^/]+)\/mutate$/.exec(path);
  if (!match || body === undefined) return body;
  assert(token, "Tracker fixture mutations require an authenticated person or agent");
  const scope = await fixtureSpace(origin, decodeURIComponent(match[1]!), token);
  return {
    contractVersion: 4,
    spaceId: scope.space.id,
    migrationEpoch: scope.migrationEpoch,
    ...(body as Record<string, unknown>),
  };
}
