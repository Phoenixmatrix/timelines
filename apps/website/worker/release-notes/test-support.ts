import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "../db.ts";
import { afterEach, vi } from "vite-plus/test";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { d1 } from "../testing/d1.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));

const fixtures: Array<() => void> = [];
afterEach(() => {
  for (const close of fixtures.splice(0)) close();
});

export async function releaseEnvironment() {
  const fixture = await createFreshSpaceTestEnvironment();
  fixtures.push(fixture.close);
  return fixture;
}

/** Real person credentials and explicit grants; Space and person IDs deliberately differ. */
export function releaseActor(id: string): Actor {
  return {
    id,
    slug: id,
    displayName: id,
    isSiteAdmin: false,
    credential: { kind: "token", id: `token-${id}` },
  };
}

export function seedReleasePerson(sqlite: DatabaseSync, id: string) {
  sqlite
    .prepare("INSERT INTO accounts (id,kind,slug,display_name) VALUES (?,'user',?,?)")
    .run(id, id, id);
  sqlite
    .prepare(
      "INSERT INTO access_tokens (id,user_id,name,scope,token_hash,last_four) VALUES (?,?,'release fixture','write',?,'test')",
    )
    .run(`token-${id}`, id, `hash-${id}`);
}

export async function seedReleaseSpace(
  sqlite: DatabaseSync,
  id: string,
  personId: string,
  personal = false,
) {
  await seedSpaceFixture(d1(sqlite), {
    organization: {
      id: `organization-${id}`,
      slug: `organization-${id}`,
      displayName: id,
      kind: personal ? "personal" : "company",
      ...(personal ? { personalAccountId: personId } : {}),
    },
    space: { id, slug: id, displayName: id },
    actorId: personId,
    members: [
      {
        accountId: personId,
        role: "owner",
        grant: {
          role: "admin",
          repositoryRole: "write",
          packageRole: "write",
        },
      },
    ],
  });
}
