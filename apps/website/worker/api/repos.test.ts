import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import { issueToken } from "./tokens.ts";
import type { Actor } from "../db.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { repos } from "./repos.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
vi.mock("../knowledge/coordinator.ts", () => ({ notifyKnowledge: vi.fn(async () => {}) }));
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function setup() {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite, env } = fresh;
  closers.push(fresh.close);
  sqlite.exec(`
    BEGIN;
    INSERT INTO accounts(id,kind,slug,display_name,is_site_admin) VALUES
      ('admin','user','admin','Admin',0), ('member','user','member','Member',0),
      ('collaborator','user','collaborator','Collaborator',0), ('operator','user','operator','Operator',1);
    INSERT INTO organizations(id,slug,display_name,kind,default_space_id)
      VALUES('company','company','Company','company','space-a');
    INSERT INTO spaces(id,organization_id,slug,display_name) VALUES
      ('space-a','company','alpha','Alpha'), ('space-b','company','beta','Beta');
    INSERT INTO organization_members(organization_id,account_id,role,origin,granted_by) VALUES
      ('company','admin','owner','bootstrap','admin'), ('company','member','member','explicit','admin');
    INSERT INTO space_grants(space_id,organization_id,account_id,role,repository_role,package_role,origin,granted_by)
      VALUES('space-a','company','member','member','none','read','explicit','admin');
    INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES
      ('private','space-a','private','private','private','https://private'),
      ('public','space-a','public','public','public','https://public'),
      ('sibling','space-b','sibling','public','sibling','https://sibling');
    INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('private','collaborator','admin');
    COMMIT;
  `);
  const credentials = new Map<string, string>();
  for (const id of ["admin", "member", "collaborator", "operator"]) {
    const token = await issueToken(env.DB, id, "repository fixture", "write");
    credentials.set(id, token.id);
  }
  let actor: Actor | null = null;
  const create = vi.fn(async () => ({ defaultBranch: "main", remote: "https://created" }));
  Reflect.set(env, "ARTIFACTS", { create });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/api/repos", repos);
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;
  return {
    sqlite,
    create,
    as(id: string | null) {
      actor = id
        ? {
            id,
            slug: id,
            displayName: id,
            isSiteAdmin: id === "operator",
            credential: { kind: "token", id: credentials.get(id)! },
          }
        : null;
    },
    async request(path: string, body?: unknown) {
      const response = await app.request(
        `/api/repos${path.replace(/^\/(?=\?|$)/, "")}`,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
        env,
        context,
      );
      await Promise.all(pending.splice(0));
      return response;
    },
  };
}

describe("canonical Space repository boundaries", () => {
  test("creation requires immutable Space ID, never a person or legacy owner locator", async () => {
    const t = await setup();
    t.as("member");
    for (const destination of [{ owner: "alpha" }, { spaceId: "" }, { spaceId: 42 }]) {
      expect((await t.request("/", { name: "new", ...destination })).status).toBe(400);
    }
    expect((await t.request("/", { name: "new", spaceId: "alpha" })).status).toBe(404);
    expect(t.create).not.toHaveBeenCalled();
  });

  test("explicit member creation survives a none repository baseline and emits only Space ownership", async () => {
    const t = await setup();
    t.as("member");
    const response = await t.request("/", { name: "new", spaceId: "space-a" });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      name: "new",
      space: { id: "space-a", slug: "alpha", organizationId: "company" },
    });
    expect(body).not.toHaveProperty("owner");
    expect(t.sqlite.prepare("SELECT space_id FROM repos WHERE name='new'").get()).toEqual({
      space_id: "space-a",
    });
    expect((await t.request("/", { name: "new", spaceId: "space-a" })).status).toBe(409);
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  test("Organization ownership and repository collaboration do not grant creation, but Instance power stays separate", async () => {
    const t = await setup();
    for (const person of ["admin", "collaborator"]) {
      t.as(person);
      expect((await t.request("/", { name: person, spaceId: "space-a" })).status).toBe(403);
    }
    t.as("member");
    expect((await t.request("/", { name: "sibling", spaceId: "space-b" })).status).toBe(403);
    t.as("operator");
    expect((await t.request("/", { name: "operator", spaceId: "space-b" })).status).toBe(201);
  });

  test("Space-filtered listing preserves public and collaborator access without exposing siblings or owner access", async () => {
    const t = await setup();
    const names = async () => {
      const body = await (await t.request("/?space=alpha")).json<{ repos: { name: string }[] }>();
      expect(Array.isArray(body.repos)).toBe(true);
      return body.repos.map((repo: { name: string }) => repo.name).sort();
    };
    expect(await names()).toEqual(["public"]);
    t.as("admin");
    expect(await names()).toEqual(["public"]);
    t.as("collaborator");
    expect(await names()).toEqual(["private", "public"]);
    t.sqlite.exec("DELETE FROM repo_collaborators");
    expect(await names()).toEqual(["public"]);
    expect((await t.request("/?space=missing")).status).toBe(404);
    expect((await t.request("/?space=admin")).status).toBe(404);
  });

  test("grant revocation immediately removes repository creation", async () => {
    const t = await setup();
    t.as("member");
    t.sqlite.exec("DELETE FROM space_grants");
    expect((await t.request("/", { name: "revoked", spaceId: "space-a" })).status).toBe(403);
    expect(t.create).not.toHaveBeenCalled();
  });
});
