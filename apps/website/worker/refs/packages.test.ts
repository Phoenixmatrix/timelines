import { Hono } from "hono";
import { beforeEach, expect, test } from "vite-plus/test";
import type { RefResolution, ResolveRefsResponse } from "../../shared/refs.ts";
import { makeHarness, type Harness } from "../../registry/testing/harness.ts";
import type { AppEnv } from "../auth.ts";
import { refs } from "./api.ts";

let h: Harness;
let feeds: Record<string, string>;
let added = 0;

/** A package with versions in a feed, as publishing would leave it. */
function addPackage(feed: string, name: string, versions: string[]) {
  const id = `pkg_${++added}`;
  const at = "2026-10-01T00:00:00.000Z";
  h.db.applySql(
    `INSERT INTO packages (id, repo_id, name, normalized_name, created_at, updated_at)
     VALUES ('${id}', '${feeds[feed]}', '${name}', '${name.toLowerCase()}', '${at}', '${at}')`,
  );
  for (const version of versions)
    h.db.applySql(
      `INSERT INTO versions (id, package_id, version, created_at)
       VALUES ('${id}-${version}', '${id}', '${version}', '${at}')`,
    );
}

async function feed(input: Record<string, unknown>) {
  const response = await h.createRepo(input);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** Resolve as whoever holds `token`: the registry authenticates the request itself. */
async function resolve(token: string, list: string[], space?: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", null);
    await next();
  });
  app.route("/api/refs", refs);
  const response = await app.request(
    "/api/refs/resolve",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ refs: list, context: { space } }),
    },
    h.env,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as ResolveRefsResponse).results;
}

const paths = (results: RefResolution[]) =>
  results.map((r) =>
    r.status === "resolved"
      ? r.target.path
      : r.status === "ambiguous"
        ? r.candidates.map((c) => c.path)
        : null,
  );

beforeEach(async () => {
  h = await makeHarness();
  added = 0;
  feeds = {
    // The harness's Space `test`: private feeds, read through explicit grants.
    generic: await feed({ key: "test", format: "generic", kind: "local", visibility: "private" }),
    npm: await feed({ key: "test", format: "npm", kind: "local", visibility: "private" }),
    pub: await feed({
      space: "pubco",
      key: "pubco",
      format: "npm",
      kind: "local",
      visibility: "public",
    }),
  };
  addPackage("generic", "shared", ["1.0.0"]);
  addPackage("npm", "shared", ["1.0.0", "2.0.0"]);
  addPackage("npm", "@test/ui", ["0.3.1"]);
  addPackage("pub", "left-pad", ["1.3.0"]);
});

test("pkg@version resolves in the page Space's readable feeds", async () => {
  h.grant("mia", "write");
  const member = h.token("mia");
  expect(
    paths(
      await resolve(
        member,
        ["shared@2.0.0", "@test/ui@0.3.1", "shared@1.0.0", "shared@9.9.9"],
        "test",
      ),
    ),
  ).toEqual([
    "/test/-/packages/npm/shared?version=2.0.0",
    "/test/-/packages/npm/%40test/ui?version=0.3.1",
    // The same name and version in two formats: a chooser.
    ["/test/-/packages/generic/shared?version=1.0.0", "/test/-/packages/npm/shared?version=1.0.0"],
    null,
  ]);
  // Without a Space in context nothing is guessed.
  expect(paths(await resolve(member, ["shared@2.0.0"]))).toEqual([null]);
});

test("private feeds stay text for outsiders; public ones resolve", async () => {
  const outsider = h.token("olly");
  expect(paths(await resolve(outsider, ["shared@2.0.0"], "test"))).toEqual([null]);
  expect(paths(await resolve(outsider, ["left-pad@1.3.0", "left-pad@v1.3.0"], "pubco"))).toEqual([
    "/pubco/-/packages/npm/left-pad?version=1.3.0",
    "/pubco/-/packages/npm/left-pad?version=1.3.0",
  ]);
});

test("repository collaboration does not grant private package references", async () => {
  h.collaborate("collaborator");
  expect(paths(await resolve(h.token("collaborator"), ["shared@2.0.0"], "test"))).toEqual([null]);
});

test("independent package read survives a none repository baseline, not grant revocation", async () => {
  h.grant("reader", "read");
  const token = h.token("reader");
  expect(paths(await resolve(token, ["shared@2.0.0"], "test"))).toEqual([
    "/test/-/packages/npm/shared?version=2.0.0",
  ]);
  h.grant("reader", "none");
  expect(paths(await resolve(token, ["shared@2.0.0"], "test"))).toEqual([null]);
});
