import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accessHeaders,
  bounded,
  create,
  deletePreview,
  installGm,
  hide,
  jobFrom,
  liveRecordsPath,
  names,
  previewUrl,
  reconcile,
  reconcileArgs,
  liveDeployments,
  reconcileMain,
  RECONCILE_MAX,
  redact,
  teardown,
  waitForPreview,
  type Cloudflare,
  type Deployments,
  type ReconcileOptions,
} from "./preview.ts";

const WORKER_ID = "826276d4ee384ccd9e1f6635ab45011a";
const accessEnv = {
  GITMATRIX_PREVIEW_ACCESS_ISSUER: "https://preview-tests.cloudflareaccess.com",
  GITMATRIX_PREVIEW_ACCESS_AUD: "preview-tests",
  GITMATRIX_ACCESS_TOKEN: JSON.stringify({
    "cf-access-client-id": "test-client.access",
    "cf-access-client-secret": "test-secret",
  }),
};

/** A Cloudflare account in memory: D1s, buckets, namespaces and Previews. */
function fakeCloudflare(state: {
  databases?: { uuid: string; name: string }[];
  buckets?: Record<string, string[]>;
  namespaces?: Record<string, string[]>;
  previews?: string[];
  /** Namespaces that count a repository no list shows (CORE-302): delete refuses. */
  stuck?: string[];
  /** Creation times by name, for D1s, buckets and (with namespaceTimes) namespaces; else long ago. */
  created?: Record<string, string>;
  /** Whether the namespace listing carries created_at (its shape is undocumented). */
  namespaceTimes?: boolean;
  /** API listings (by path prefix) that fail with HTTP 500. */
  failing?: string[];
}) {
  const stuck = new Set(state.stuck ?? []);
  const databases = state.databases ?? [];
  const buckets = state.buckets ?? {};
  const namespaces = state.namespaces ?? {};
  const previews = new Map(
    (state.previews ?? []).map((name, i) => [name, { id: `pv${i + 1}`, name, slug: name }]),
  );
  const calls: string[] = [];
  let next = 0;
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
  const cloudflare: Cloudflare = {
    async cf(args, env) {
      calls.push(args.join(" "));
      const command = args.slice(0, 3).join(" ");
      if (command.startsWith("d1 list"))
        return JSON.stringify(databases.filter((d) => d.name.includes(flag(args, "--name"))));
      if (command.startsWith("d1 create")) {
        const name = flag(args, "--name");
        if (databases.some((d) => d.name === name)) throw new Error("name already exists");
        const uuid = `db-${++next}`;
        databases.push({ uuid, name });
        return JSON.stringify({ uuid, name });
      }
      if (command.startsWith("d1 delete")) {
        const index = databases.findIndex((d) => d.uuid === args[2]);
        if (index < 0)
          throw new Error("APIError\n[7404] The database could not be found.\n404 Not Found");
        databases.splice(index, 1);
        return "";
      }
      if (command.startsWith("d1 migrations")) return "";
      if (command === "r2 objects list") {
        const bucket = buckets[flag(args, "--bucket-name")];
        if (!bucket)
          throw new Error("APIError\n[10006] The specified bucket does not exist.\n404 Not Found");
        return JSON.stringify(bucket.slice(0, 2).map((key) => ({ key })));
      }
      if (command === "r2 objects bulk-delete") {
        const name = flag(args, "--bucket-name");
        const keys = JSON.parse(flag(args, "--body")) as string[];
        buckets[name] = buckets[name]!.filter((key) => !keys.includes(key));
        return "";
      }
      if (command === "r2 buckets delete") {
        if (!buckets[args[3]!])
          throw new Error("APIError\n[10006] The specified bucket does not exist.\n404 Not Found");
        if (buckets[args[3]!]!.length) throw new Error("bucket not empty");
        delete buckets[args[3]!];
        return "";
      }
      if (command === "r2 buckets create") {
        buckets[flag(args, "--name")] = [];
        return "{}";
      }
      if (command === "artifacts namespaces repos") {
        const namespace = namespaces[flag(args, "--namespace")];
        if (!namespace) throw new Error("HTTP 404: namespace not found");
        if (args[3] === "list") return JSON.stringify(namespace.map((name) => ({ name })));
        namespace.splice(namespace.indexOf(args[4]!), 1);
        return "";
      }
      if (command === "artifacts namespaces delete") {
        if (!namespaces[args[3]!]) throw new Error("HTTP 404: namespace not found");
        if (stuck.has(args[3]!)) throw new Error("[10202] Namespace is not empty (409)");
        delete namespaces[args[3]!];
        return "";
      }
      if (command === "artifacts namespaces create") {
        if (namespaces[flag(args, "--namespace")])
          throw new Error("HTTP 409: namespace already exists");
        namespaces[flag(args, "--namespace")] = [];
        return "{}";
      }
      if (command.startsWith("previews deploy")) {
        assert.ok(env, "previews deploy gets the preview's resources");
        previews.set(args[2]!, { id: `pv${++next}`, name: args[2]!, slug: args[2]! });
        calls.push(`env ${JSON.stringify(env)}`);
        return `${JSON.stringify(
          {
            type: "preview",
            version: 1,
            preview_name: args[2],
            preview_urls: [`https://${args[2]}-gitmatrix.example.workers.dev`],
            deployment_urls: ["https://abc123-gitmatrix.example.workers.dev"],
          },
          null,
          2,
        )}\n`;
      }
      throw new Error(`unexpected cf ${args.join(" ")}`);
    },
    async api(method, path) {
      calls.push(`${method} ${path}`);
      if (state.failing?.some((prefix) => path.startsWith(prefix)))
        return {
          status: 500,
          body: { success: false, errors: [{ code: 10000, message: "down" }] },
        };
      const created = (name: string) => state.created?.[name] ?? "2026-01-01T00:00:00.000Z";
      // Listings come in pages of two, whatever was asked, so tests cover paging.
      const url = new URL(path, "https://api.example");
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const paged = <T>(all: T[]) => ({
        page: all.slice(cursor, cursor + 2),
        next: cursor + 2 < all.length ? String(cursor + 2) : null,
      });
      if (method === "GET" && url.pathname === "/accounts/acct/d1/database") {
        const page = Number(url.searchParams.get("page"));
        const all = databases.filter((d) => d.name.includes(url.searchParams.get("name") ?? ""));
        return {
          status: 200,
          body: {
            success: true,
            result: all
              .slice((page - 1) * 2, page * 2)
              .map((d) => ({ ...d, created_at: created(d.name) })),
            result_info: { page, per_page: 2, total_count: all.length },
          },
        };
      }
      const bucket = /^\/accounts\/acct\/r2\/buckets\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && bucket) {
        const name = decodeURIComponent(bucket[1]!);
        return buckets[name]
          ? { status: 200, body: { success: true, result: { name, creation_date: created(name) } } }
          : {
              status: 404,
              body: { success: false, errors: [{ code: 10006, message: "NoSuchBucket" }] },
            };
      }
      if (method === "GET" && url.pathname === "/accounts/acct/r2/buckets") {
        const contains = url.searchParams.get("name_contains") ?? "";
        const { page, next } = paged(
          Object.keys(buckets).filter((name) => name.includes(contains)),
        );
        return {
          status: 200,
          body: {
            success: true,
            result: { buckets: page.map((name) => ({ name, creation_date: created(name) })) },
            result_info: next ? { cursor: next, per_page: 2 } : { per_page: 2 },
          },
        };
      }
      if (method === "GET" && url.pathname === "/accounts/acct/artifacts/namespaces") {
        const { page, next } = paged(Object.keys(namespaces));
        return {
          status: 200,
          body: {
            success: true,
            result: page.map((name) =>
              state.namespaceTimes ? { name, created_at: created(name) } : { name },
            ),
            result_info: next ? { cursor: next, count: page.length } : { count: page.length },
          },
        };
      }
      const base = "/accounts/acct/workers/workers/";
      if (method === "GET" && path === `${base}gitmatrix`)
        return {
          status: 200,
          body: { success: true, result: { id: WORKER_ID, name: "gitmatrix" } },
        };
      const listing =
        /^GET \/accounts\/acct\/workers\/workers\/(\w+)\/previews\?per_page=(\d+)&page=(\d+)$/.exec(
          `${method} ${path}`,
        );
      if (listing) {
        assert.equal(listing[1], WORKER_ID, "Previews are listed by Worker id");
        // Pages of two, whatever was asked, so tests cover paging.
        const all = [...previews.values()];
        const page = Number(listing[3]);
        return {
          status: 200,
          body: {
            success: true,
            result: all.slice((page - 1) * 2, page * 2),
            result_info: { page, per_page: 2, total_count: all.length },
          },
        };
      }
      const deleting = /^DELETE \/accounts\/acct\/workers\/workers\/(\w+)\/previews\/([^/]+)$/.exec(
        `${method} ${path}`,
      );
      if (deleting && deleting[1] === WORKER_ID) {
        // This fake addresses Previews by id only, so a delete by name would 404.
        const id = decodeURIComponent(deleting[2]!);
        const found = [...previews.entries()].find(([, preview]) => preview.id === id);
        if (!found)
          return { status: 404, body: { errors: [{ code: 10025, message: "Preview not found" }] } };
        previews.delete(found[0]);
        return { status: 200, body: { success: true } };
      }
      throw new Error(`unexpected API ${method} ${path}`);
    },
  };
  return { cloudflare, calls, databases, buckets, namespaces, previews };
}

await test("names derive from the slug alone and fit Cloudflare's limits", () => {
  assert.deepEqual(names("faster-search"), {
    preview: "timeline-faster-search",
    db: "gitmatrix-preview-faster-search",
    registryDb: "gitmatrix-preview-registry-faster-search",
    bucket: "gitmatrix-preview-faster-search",
    artifacts: "gitmatrix-preview-faster-search",
  });
  const long = `${"a".repeat(30)}-${"b".repeat(33)}`;
  assert.equal(long.length, 64);
  const all = names(long);
  assert.ok(all.preview.length <= 53, all.preview);
  for (const name of Object.values(all)) {
    assert.ok(name.length <= 63, name);
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  }
  // Two long slugs that share a prefix still get their own names.
  assert.notEqual(names(`${long.slice(0, 60)}-xyz`).db, names(`${long.slice(0, 60)}-xyw`).db);
  assert.equal(bounded("p-", "short", 63), "p-short");
  assert.throws(() => names("Not_A_Slug"), /isn't a timeline slug/);
  assert.throws(() => names("x".repeat(65)), /isn't a timeline slug/);
});

await test("create tears down, provisions fresh data, deploys in preview mode, seeds and records", async () => {
  const fake = fakeCloudflare({
    // What an earlier create of this timeline left behind.
    databases: [
      { uuid: "old-db", name: "gitmatrix-preview-faster-search" },
      { uuid: "old-registry", name: "gitmatrix-preview-registry-faster-search" },
      // Another timeline whose name contains this one's: left alone.
      { uuid: "other", name: "gitmatrix-preview-faster-search-2" },
    ],
    buckets: { "gitmatrix-preview-faster-search": ["a", "b", "c"] },
    namespaces: { "gitmatrix-preview-faster-search": ["repo-1"] },
    previews: ["timeline-faster-search"],
  });
  const steps: string[] = [];
  const url = await create(
    {
      cloudflare: fake.cloudflare,
      secret: "s".repeat(64),
      wait: async (origin, resources) => {
        steps.push(`wait ${origin} ${resources.name}`);
      },
      seed: async (origin, resources) => {
        steps.push(`seed ${origin} ${resources.db}`);
      },
      record: async (args) => {
        steps.push(`gm ${args.join(" ")}`);
      },
      recorded: async () => assert.fail("only after a failed record"),
    },
    { slug: "faster-search", account: "acct", env: accessEnv },
  );
  assert.equal(url, "https://timeline-faster-search-gitmatrix.example.workers.dev");
  // The old Preview went first (found by name, deleted by id), then the old
  // data; the other timeline's survived.
  assert.deepEqual(fake.calls.slice(0, 4), [
    "GET /accounts/acct/workers/workers/gitmatrix",
    `GET /accounts/acct/workers/workers/${WORKER_ID}/previews?per_page=100&page=1`,
    `DELETE /accounts/acct/workers/workers/${WORKER_ID}/previews/pv1`,
    `GET /accounts/acct/workers/workers/${WORKER_ID}/previews?per_page=100&page=1`,
  ]);
  assert.deepEqual([...fake.previews.keys()], ["timeline-faster-search"]);
  assert.deepEqual(
    fake.databases.map((d) => d.uuid),
    ["other", "db-1", "db-2"],
  );
  assert.deepEqual(fake.buckets, { "gitmatrix-preview-faster-search": [] });
  assert.deepEqual(fake.namespaces, { "gitmatrix-preview-faster-search": [] });
  // Migrations, registry migrations and the SQL seed, on the new databases only.
  assert.deepEqual(
    fake.calls.filter((call) => call.startsWith("d1 migrations")),
    [
      "d1 migrations apply db-1 --dir migrations",
      "d1 migrations apply db-2 --dir registry/migrations",
      "d1 migrations apply db-1 --dir seed",
    ],
  );
  const deploy = fake.calls.indexOf("previews deploy timeline-faster-search");
  assert.ok(deploy > 0);
  assert.deepEqual(JSON.parse(fake.calls[deploy + 1]!.slice(4)), {
    GITMATRIX_PREVIEW_NAME: "timeline-faster-search",
    GITMATRIX_PREVIEW_DB: "db-1",
    GITMATRIX_PREVIEW_REGISTRY_DB: "db-2",
    GITMATRIX_PREVIEW_BUCKET: "gitmatrix-preview-faster-search",
    GITMATRIX_PREVIEW_ARTIFACTS: "gitmatrix-preview-faster-search",
    GITMATRIX_PREVIEW_SECRET: "s".repeat(64),
    GITMATRIX_PREVIEW_ACCESS_ISSUER: accessEnv.GITMATRIX_PREVIEW_ACCESS_ISSUER,
    GITMATRIX_PREVIEW_ACCESS_AUD: accessEnv.GITMATRIX_PREVIEW_ACCESS_AUD,
  });
  assert.deepEqual(steps, [
    `wait ${url} timeline-faster-search`,
    `seed ${url} db-1`,
    `gm deploy record --url ${url}`,
  ]);
});

await test("teardown deletes the Preview and everything create made, and is idempotent", async () => {
  const fake = fakeCloudflare({
    databases: [
      { uuid: "db", name: "gitmatrix-preview-faster-search" },
      { uuid: "reg", name: "gitmatrix-preview-registry-faster-search" },
    ],
    buckets: { "gitmatrix-preview-faster-search": ["blob"] },
    namespaces: { "gitmatrix-preview-faster-search": ["r1", "r2"] },
    previews: ["timeline-faster-search"],
  });
  await teardown(fake.cloudflare, "acct", "faster-search");
  assert.deepEqual(fake.databases, []);
  assert.deepEqual(fake.buckets, {});
  assert.deepEqual(fake.namespaces, {});
  assert.equal(fake.previews.size, 0);
  // Again, with nothing left: nothing fails.
  await teardown(fake.cloudflare, "acct", "faster-search");
});

await test("teardown fails on errors other than absence", async () => {
  const fake = fakeCloudflare({});
  const denied: Cloudflare = {
    ...fake.cloudflare,
    async cf(args, env) {
      if (args[0] === "d1") throw new Error("Authentication error [code: 10000]");
      return fake.cloudflare.cf(args, env);
    },
  };
  await assert.rejects(teardown(denied, "acct", "faster-search"), /Authentication error/);
  const forbidden: Cloudflare = {
    ...fake.cloudflare,
    api: async () => ({ status: 403, body: { errors: [{ code: 10000 }] } }),
  };
  await assert.rejects(teardown(forbidden, "acct", "faster-search"), /HTTP 403/);
});

await test("teardown finds the Preview by name among the Worker's and deletes it by id", async () => {
  const fake = fakeCloudflare({
    // Three pages of two: this timeline's Preview is on the last.
    previews: [
      "timeline-a",
      "timeline-b",
      "timeline-faster-search-2",
      "timeline-c",
      "timeline-faster-search",
    ],
  });
  await deletePreview(fake.cloudflare, "acct", "timeline-faster-search");
  assert.deepEqual(
    [...fake.previews.keys()],
    ["timeline-a", "timeline-b", "timeline-faster-search-2", "timeline-c"],
  );
  assert.deepEqual(
    fake.calls.filter((call) => call.startsWith("DELETE")),
    [`DELETE /accounts/acct/workers/workers/${WORKER_ID}/previews/pv5`],
  );
  assert.ok(
    fake.calls.includes(
      `GET /accounts/acct/workers/workers/${WORKER_ID}/previews?per_page=100&page=3`,
    ),
  );
});

await test("a Preview the list doesn't show is already deleted; no Worker means no Previews", async () => {
  const fake = fakeCloudflare({ previews: ["timeline-other"] });
  await deletePreview(fake.cloudflare, "acct", "timeline-faster-search");
  assert.equal(fake.calls.filter((call) => call.startsWith("DELETE")).length, 0);
  assert.deepEqual([...fake.previews.keys()], ["timeline-other"]);
  const noWorker: Cloudflare = {
    ...fake.cloudflare,
    api: async () => ({
      status: 404,
      body: { errors: [{ code: 10007, message: "Worker not found" }] },
    }),
  };
  await deletePreview(noWorker, "acct", "timeline-faster-search");
});

await test("a delete that 404s or fails while the Preview is still listed is an error", async () => {
  const listed = fakeCloudflare({ previews: ["timeline-faster-search"] });
  // The delete 404s, yet the Preview is still listed: never treated as done.
  const misaddressed: Cloudflare = {
    ...listed.cloudflare,
    api: async (method, path) =>
      method === "DELETE"
        ? { status: 404, body: { errors: [{ code: 10025, message: "Preview not found" }] } }
        : listed.cloudflare.api(method, path),
  };
  await assert.rejects(
    deletePreview(misaddressed, "acct", "timeline-faster-search"),
    /still listed after its delete returned HTTP 404/,
  );
  // A 404 that a fresh list agrees with (a concurrent teardown won) is done.
  const raced: Cloudflare = {
    ...listed.cloudflare,
    api: async (method, path) => {
      if (method !== "DELETE") return listed.cloudflare.api(method, path);
      listed.previews.clear();
      return { status: 404, body: { errors: [{ code: 10025, message: "Preview not found" }] } };
    },
  };
  await deletePreview(raced, "acct", "timeline-faster-search");
  const failing = fakeCloudflare({ previews: ["timeline-faster-search"] });
  const serverError: Cloudflare = {
    ...failing.cloudflare,
    api: async (method, path) =>
      method === "DELETE"
        ? { status: 500, body: { errors: [{ code: 10013, message: "internal" }] } }
        : failing.cloudflare.api(method, path),
  };
  await assert.rejects(
    deletePreview(serverError, "acct", "timeline-faster-search"),
    /Deleting Preview timeline-faster-search returned HTTP 500/,
  );
  // A failed Preview delete still leaves the data to a later teardown, and says why.
  await assert.rejects(teardown(serverError, "acct", "faster-search"), /HTTP 500/);
});

await test("previewUrl reads cf's result", () => {
  assert.equal(
    previewUrl('{"preview_urls":["https://p-gitmatrix.x.workers.dev/"],"deployment_urls":[]}'),
    "https://p-gitmatrix.x.workers.dev",
  );
  assert.equal(
    previewUrl('{"preview_urls":{"workers_dev":"p-gitmatrix.x.workers.dev"}}'),
    "https://p-gitmatrix.x.workers.dev",
  );
  assert.equal(
    previewUrl('{"preview_urls":[],"deployment_urls":["https://d.x.workers.dev"]}'),
    "https://d.x.workers.dev",
  );
  // A log line and cf's raw {preview, deployment} log before the result: the result wins.
  const logged = JSON.stringify(
    {
      preview: { urls: ["https://raw-gitmatrix.x.workers.dev"], note: 'braces "{}" in strings' },
      deployment: { urls: [] },
    },
    null,
    2,
  );
  const result = JSON.stringify({ type: "preview", preview_urls: ["https://p.x.workers.dev"] });
  assert.equal(previewUrl(`building {app}\n${logged}\n${result}\n`), "https://p.x.workers.dev");
  assert.equal(previewUrl(logged), "https://raw-gitmatrix.x.workers.dev");
  assert.throws(() => previewUrl('{"preview_urls":[]}'), /no URL/);
  assert.throws(() => previewUrl(""), /no result/);
});

await test("waitForPreview waits for this deployment's identity", async () => {
  const answers = [
    () => {
      throw new Error("ECONNREFUSED");
    },
    () => Response.json({ error: "Unauthorized." }, { status: 401 }),
    () => Response.json({ id: "timeline-x", ready: false }),
    () => Response.json({ id: "timeline-x", ready: true }),
  ];
  await waitForPreview(
    "https://p.example",
    { name: "timeline-x", secret: "k" },
    {
      delayMs: 0,
      request: (async () => answers.shift()!()) as typeof fetch,
    },
  );
  await assert.rejects(
    waitForPreview(
      "https://p.example",
      { name: "timeline-x", secret: "k" },
      {
        delayMs: 0,
        tries: 2,
        request: (async () => Response.json({}, { status: 503 })) as unknown as typeof fetch,
      },
    ),
    /never came up \(HTTP 503\)/,
  );
});

await test("installGm installs main's newest gm and checks its checksum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-test-"));
  try {
    const binary = new TextEncoder().encode("#!/bin/sh\necho gm\n");
    const digest = createHash("sha256").update(binary).digest("hex");
    const requests: string[] = [];
    const request = (async (url: string, init: RequestInit) => {
      requests.push(`${url} ${new Headers(init.headers).get("authorization")}`);
      if (url.endsWith("/api/packages/matrixorg/generic/gm"))
        return Response.json({ package: { latest: "abc123" } });
      return new Response(binary, { headers: { "x-checksum-sha256": digest } });
    }) as typeof fetch;
    const env = {
      GITMATRIX_URL: "https://gm.example/",
      GITMATRIX_SPACE: "matrixorg",
      GITMATRIX_TOKEN: "gmj_job",
    };
    const path = await installGm(env, directory, { request, arch: "x64" });
    assert.deepEqual(requests, [
      "https://gm.example/api/packages/matrixorg/generic/gm Bearer gmj_job",
      "https://gm.example/generic/matrixorg/gm/abc123/linux-x86_64/gm Bearer gmj_job",
    ]);
    assert.equal(await readFile(path, "utf8"), "#!/bin/sh\necho gm\n");
    assert.equal((await stat(path)).mode & 0o777, 0o755);
    const tampered = (async (url: string) =>
      url.includes("/api/packages/")
        ? Response.json({ package: { latest: "abc123" } })
        : new Response(binary, {
            headers: { "x-checksum-sha256": "0".repeat(64) },
          })) as typeof fetch;
    await assert.rejects(
      installGm(env, directory, { request: tampered, arch: "arm64" }),
      /checksum/,
    );
    assert.equal(await installGm({ GITMATRIX_PREVIEW_GM: "/opt/gm" }, directory), "/opt/gm");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("jobFrom takes only the preview contract's variables", () => {
  const env = {
    GITMATRIX_PREVIEW_ACTION: "create",
    GITMATRIX_TIMELINE: "faster-search",
    CLOUDFLARE_ACCOUNT_ID: "acct",
  };
  assert.deepEqual(jobFrom(env), { action: "create", slug: "faster-search", account: "acct", env });
  assert.throws(() => jobFrom({ ...env, GITMATRIX_PREVIEW_ACTION: "" }), /preview job/);
  assert.throws(() => jobFrom({ ...env, GITMATRIX_TIMELINE: "" }), /GITMATRIX_TIMELINE/);
  assert.throws(() => jobFrom({ ...env, CLOUDFLARE_ACCOUNT_ID: "" }), /CLOUDFLARE_ACCOUNT_ID/);
});

await test("invalid Access configuration cannot replace an existing preview", async () => {
  for (const env of [
    {},
    { ...accessEnv, GITMATRIX_PREVIEW_ACCESS_AUD: "" },
    { ...accessEnv, GITMATRIX_PREVIEW_ACCESS_ISSUER: "https://untrusted.example" },
    { ...accessEnv, GITMATRIX_ACCESS_TOKEN: "not-json" },
    { ...accessEnv, GITMATRIX_ACCESS_TOKEN: "{}" },
  ]) {
    const fake = fakeCloudflare({ previews: ["timeline-faster-search"] });
    await assert.rejects(
      create(
        {
          cloudflare: fake.cloudflare,
          wait: async () => assert.fail("must fail before deploy"),
          seed: async () => assert.fail("must fail before seed"),
          // Only the failed deployment, which leaves the existing preview alone.
          record: async (args) =>
            assert.deepEqual(args, ["deploy", "record", "--status", "failed"]),
          recorded: async () => assert.fail("must fail before record"),
        },
        { slug: "faster-search", account: "acct", env },
      ),
      /GITMATRIX_(?:PREVIEW_ACCESS|ACCESS_TOKEN)/,
    );
    assert.equal(fake.calls.length, 0);
    assert.deepEqual([...fake.previews.keys()], ["timeline-faster-search"]);
  }
});

await test("preview credentials never escape into reported child output", () => {
  const sessionSecret = "private-session-signing-secret";
  hide(sessionSecret);
  accessHeaders(accessEnv);
  assert.equal(
    redact(`${accessEnv.GITMATRIX_ACCESS_TOKEN} test-client.access test-secret ${sessionSecret}`),
    "[hidden] [hidden] [hidden] [hidden]",
  );
});

/** A stuck namespace in a fake that otherwise holds one timeline's old preview. */
function stuckAccount(repos: string[] = []) {
  const name = "gitmatrix-preview-faster-search";
  return fakeCloudflare({
    databases: [
      { uuid: "old-db", name },
      { uuid: "old-registry", name: "gitmatrix-preview-registry-faster-search" },
    ],
    buckets: { [name]: ["a"] },
    namespaces: { [name]: repos },
    previews: ["timeline-faster-search"],
    stuck: [name],
  });
}

function captureStderr() {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore() {
      process.stderr.write = original as typeof process.stderr.write;
    },
  };
}

const deps = (cloudflare: Cloudflare) => ({
  cloudflare,
  seed: async () => {},
  record: async () => {},
  recorded: async () => false as boolean | null,
  wait: async () => {},
  secret: "s".repeat(64),
});
const job = { slug: "faster-search", account: "acct", env: accessEnv as NodeJS.ProcessEnv };

await test("teardown deletes a stuck namespace's repositories, then orphans the namespace", async () => {
  const fake = stuckAccount(["old-repo"]);
  const stderr = captureStderr();
  try {
    await teardown(fake.cloudflare, "acct", "faster-search");
  } finally {
    stderr.restore();
  }
  const event = JSON.parse(stderr.lines.join("").trim().split("\n")[0]!);
  assert.equal(event.event, "preview.namespace.orphaned");
  assert.equal(event.namespace, "gitmatrix-preview-faster-search");
  assert.deepEqual(fake.databases, []);
  assert.deepEqual(fake.buckets, {});
  assert.equal(fake.previews.size, 0);
  // Left behind, but with nothing listable in it.
  assert.deepEqual(fake.namespaces, { "gitmatrix-preview-faster-search": [] });
});

await test("create reuses a stuck namespace, and a revival clears the last create's repositories", async () => {
  const fake = stuckAccount(["old-repo"]);
  let seeded = 0;
  const seeding = {
    ...deps(fake.cloudflare),
    // Seeding creates repositories in the preview's namespace, as the fixtures do.
    seed: async (_origin: string, resources: { artifacts: string }) => {
      fake.namespaces[resources.artifacts]!.push(`r-${++seeded}`);
    },
  };
  const stderr = captureStderr();
  try {
    await create(seeding, job);
    assert.deepEqual(fake.namespaces, { "gitmatrix-preview-faster-search": ["r-1"] });
    await create(seeding, job);
  } finally {
    stderr.restore();
  }
  assert.deepEqual(fake.namespaces, { "gitmatrix-preview-faster-search": ["r-2"] });
  assert.ok(!fake.calls.some((call) => call.startsWith("artifacts namespaces create")));
  assert.equal(fake.previews.size, 1);
  assert.equal(fake.databases.length, 2);
});

await test("create refuses a leftover namespace that lists repositories again", async () => {
  const fake = stuckAccount();
  const base = fake.cloudflare.cf.bind(fake.cloudflare);
  let refused = false;
  let lists = 0;
  fake.cloudflare.cf = async (args, env) => {
    const command = args.slice(0, 3).join(" ");
    if (command === "artifacts namespaces delete")
      return base(args, env).catch((error: unknown) => {
        refused = true;
        throw error;
      });
    // Empty for teardown's own check, then a repository appears before
    // provisioning, and stays listed however often it's deleted.
    if (refused && command === "artifacts namespaces repos" && args[3] === "list")
      return JSON.stringify(++lists > 1 ? [{ name: "late" }] : []);
    return base(args, env);
  };
  const stderr = captureStderr();
  try {
    await assert.rejects(create(deps(fake.cloudflare), job), /still lists repositories/);
  } finally {
    stderr.restore();
  }
  // The rollback deleted the databases and bucket, and gave up on the
  // namespace rather than deleting "late" forever (CORE-385).
  assert.deepEqual(fake.databases, []);
  assert.deepEqual(fake.buckets, {});
  const events = stderr.lines
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const failed = events.find((event) => event.event === "preview.create.rollback-failed");
  assert.match(failed.error, /still lists repository late/);
});

await test("a namespace Cloudflare won't delete fails teardown when a fresh list shows a repository", async () => {
  const fake = fakeCloudflare({ namespaces: { "gitmatrix-preview-faster-search": [] } });
  const base = fake.cloudflare.cf.bind(fake.cloudflare);
  let lists = 0;
  fake.cloudflare.cf = async (args, env) => {
    const command = args.slice(0, 3).join(" ");
    if (command === "artifacts namespaces delete") throw new Error("namespace is not empty");
    // Empty while repositories are deleted; a repository appears by the final check.
    if (command === "artifacts namespaces repos" && args[3] === "list")
      return JSON.stringify(++lists > 1 ? [{ name: "r" }] : []);
    return base(args, env);
  };
  await assert.rejects(
    teardown(fake.cloudflare, "acct", "faster-search"),
    /namespace is not empty/,
  );
});

await test("create still fails when the namespace create fails for another reason", async () => {
  const fake = fakeCloudflare({});
  const base = fake.cloudflare.cf.bind(fake.cloudflare);
  fake.cloudflare.cf = async (args, env) => {
    if (args.slice(0, 3).join(" ") === "artifacts namespaces create")
      throw new Error("HTTP 403: forbidden");
    return base(args, env);
  };
  const stderr = captureStderr();
  try {
    await assert.rejects(create(deps(fake.cloudflare), job), /forbidden/);
  } finally {
    stderr.restore();
  }
  // The databases and bucket it had made went with it (CORE-385).
  assert.deepEqual(fake.databases, []);
  assert.deepEqual(fake.buckets, {});
});

await test("a create that fails after deploying deletes what it made (CORE-385)", async () => {
  for (const stage of ["deploy", "wait", "seed", "record"] as const) {
    const fake = fakeCloudflare({});
    const base = fake.cloudflare.cf.bind(fake.cloudflare);
    fake.cloudflare.cf = async (args, env) => {
      if (stage === "deploy" && args[0] === "previews") throw new Error("deploy broke");
      return base(args, env);
    };
    const broken = async () => {
      throw new Error(`${stage} broke`);
    };
    const stderr = captureStderr();
    try {
      await assert.rejects(
        create(
          { ...deps(fake.cloudflare), ...(stage === "deploy" ? {} : { [stage]: broken }) },
          job,
        ),
        new RegExp(`${stage} broke`),
      );
    } finally {
      stderr.restore();
    }
    assert.equal(fake.previews.size, 0, stage);
    assert.deepEqual(fake.databases, [], stage);
    assert.deepEqual(fake.buckets, {}, stage);
    assert.deepEqual(fake.namespaces, {}, stage);
    const events = stderr.lines
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).event, "preview.create.rolled-back", stage);
  }
});

await test("a failed rollback reports what it left, and the create's own error", async () => {
  const fake = fakeCloudflare({});
  const base = fake.cloudflare.cf.bind(fake.cloudflare);
  let deployed = false;
  fake.cloudflare.cf = async (args, env) => {
    if (args[0] === "previews") deployed = true;
    // Once deployed, the only D1 calls are the rollback's deletes.
    else if (deployed && args[0] === "d1")
      throw new Error(`Authentication error [code: 10000] ${"s".repeat(64)}`);
    return base(args, env);
  };
  const stderr = captureStderr();
  try {
    await assert.rejects(
      create(
        {
          ...deps(fake.cloudflare),
          seed: async () => {
            throw new Error("seed broke");
          },
        },
        job,
      ),
      /seed broke/,
    );
  } finally {
    stderr.restore();
  }
  const events = stderr.lines
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const failed = events.find((event) => event.event === "preview.create.rollback-failed");
  assert.ok(failed, "the rollback's failure is reported");
  assert.equal(failed.preview, "timeline-faster-search");
  assert.equal(failed.db, "gitmatrix-preview-faster-search");
  assert.match(failed.error, /Authentication error/);
  assert.ok(!JSON.stringify(events).includes("s".repeat(64)), "no secret in the report");
});

await test("a failed create records the failure before it cleans up", async () => {
  const fake = fakeCloudflare({});
  const order: string[] = [];
  const base = fake.cloudflare.cf.bind(fake.cloudflare);
  fake.cloudflare.cf = async (args, env) => {
    if (args[0] === "d1" && args[1] === "delete") order.push("rollback");
    return base(args, env);
  };
  const stderr = captureStderr();
  try {
    await assert.rejects(
      create(
        {
          ...deps(fake.cloudflare),
          seed: async () => {
            throw new Error("seed broke");
          },
          record: async (args) => {
            order.push(args.join(" "));
          },
        },
        job,
      ),
      /seed broke/,
    );
  } finally {
    stderr.restore();
  }
  assert.equal(order[0], "deploy record --status failed");
  assert.ok(order.includes("rollback"));
});

await test("a record call that may have stored the live record keeps the preview", async () => {
  for (const [stored, failedRecord] of [
    [true, false],
    [null, true],
    [false, true],
  ] as const) {
    const fake = fakeCloudflare({});
    const records: string[] = [];
    const stderr = captureStderr();
    try {
      await assert.rejects(
        create(
          {
            ...deps(fake.cloudflare),
            record: async (args) => {
              records.push(args.join(" "));
              if (args.includes("--url")) throw new Error("gm timed out");
            },
            recorded: async (url) => {
              assert.equal(url, "https://timeline-faster-search-gitmatrix.example.workers.dev");
              return stored;
            },
          },
          job,
        ),
        /gm timed out/,
      );
    } finally {
      stderr.restore();
    }
    const kept = stored !== false;
    assert.equal(fake.previews.size, kept ? 1 : 0, String(stored));
    assert.equal(fake.databases.length, kept ? 2 : 0, String(stored));
    assert.equal(records.includes("deploy record --status failed"), failedRecord, String(stored));
    const events = stderr.lines
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      events.at(-1).event,
      kept ? "preview.create.kept" : "preview.create.rolled-back",
      String(stored),
    );
  }
});

await test("a failed record call is checked in the job's own source and run", () => {
  assert.equal(
    liveRecordsPath({
      GITMATRIX_REPOSITORY: "matrixorg/timelines",
      GITMATRIX_SOURCE_ID: "work-abc",
      GITMATRIX_RUN_NUMBER: "583",
    }),
    "/repos/matrixorg/timelines/deployments?run=583&status=active&source=work-abc&limit=100",
  );
  // Without the job's variables nobody can tell: the preview is kept.
  assert.equal(liveRecordsPath({ GITMATRIX_REPOSITORY: "matrixorg/timelines" }), null);
  assert.equal(
    liveRecordsPath({
      GITMATRIX_REPOSITORY: "../x",
      GITMATRIX_SOURCE_ID: "s",
      GITMATRIX_RUN_NUMBER: "1",
    }),
    null,
  );
});

// reconcile (CORE-372)

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
/** A creation time `hours` before NOW, as Cloudflare lists it. */
const HOURS_AGO = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();
const RECENT = "2026-10-11T11:30:00.000Z";

/** Every resource names() gives a slug, as the fake account holds them. */
function resourcesOf(slug: string, uuid = slug) {
  const all = names(slug);
  return {
    databases: [
      { uuid: `${uuid}-db`, name: all.db },
      { uuid: `${uuid}-registry`, name: all.registryDb },
    ],
    buckets: { [all.bucket]: ["k"] },
    namespaces: { [all.artifacts]: ["r"] },
  };
}

function account(slugs: string[], extra: Parameters<typeof fakeCloudflare>[0] = {}) {
  const merged = slugs.map((slug) => resourcesOf(slug));
  return fakeCloudflare({
    ...extra,
    databases: [...merged.flatMap((r) => r.databases), ...(extra.databases ?? [])],
    buckets: Object.assign({}, ...merged.map((r) => r.buckets), extra.buckets),
    namespaces: Object.assign({}, ...merged.map((r) => r.namespaces), extra.namespaces),
  });
}

/** Deployment records in any source; live-timelines answers the live ones' slugs. */
function fakeDeployments(
  records: { id: number; timeline: string | null; status?: string; source?: string }[],
  options: { fail?: boolean | number } = {},
) {
  let asked = 0;
  const deployments: Deployments = {
    async liveTimelines() {
      asked++;
      if (options.fail === true) throw new Error("Listing live timelines returned HTTP 503.");
      if (typeof options.fail === "number")
        throw new Error(`Listing live timelines returned HTTP ${options.fail}.`);
      return [
        ...new Set(
          records
            .filter((r) => ["active", "sleeping"].includes(r.status ?? "active"))
            .flatMap((r) => (r.timeline ? [r.timeline] : [])),
        ),
      ].toSorted();
    },
  };
  return { deployments, asked: () => asked };
}

async function reconciling(
  fake: ReturnType<typeof fakeCloudflare>,
  deployments: Deployments,
  options: Partial<ReconcileOptions> = {},
) {
  const events: Record<string, unknown>[] = [];
  const result = await reconcile({
    cloudflare: fake.cloudflare,
    account: "acct",
    deployments,
    now: NOW,
    log: (event) => events.push(event),
    ...options,
  });
  const of = (name: string) => events.filter((event) => event.event === name);
  return { result, events, of };
}

function left(fake: ReturnType<typeof fakeCloudflare>) {
  return [
    ...fake.databases.map((d) => d.name),
    ...Object.keys(fake.buckets),
    ...Object.keys(fake.namespaces),
  ].toSorted();
}

await test("reconcile keeps live previews' resources and deletes every page of orphans", async () => {
  const live = ["alive", "asleep", "third"];
  const dead = ["gone", "gone-too"];
  const fake = account([...live, ...dead], {
    previews: live.map((slug) => names(slug).preview),
    // Not a preview's: never listed for deletion.
    databases: [{ uuid: "prod", name: "gitmatrix" }],
  });
  const { deployments, asked } = fakeDeployments([
    { id: 1, timeline: "alive" },
    { id: 2, timeline: "alive", source: "work-a" },
    { id: 3, timeline: "third" },
    { id: 4, timeline: "asleep", status: "sleeping" },
    // A record with no timeline (production) says nothing about previews.
    { id: 5, timeline: null },
  ]);
  const { result, of } = await reconciling(fake, deployments);
  assert.equal(result.skipped, undefined);
  assert.equal(asked(), 1);
  const doomed = dead.flatMap((slug) => {
    const all = names(slug);
    return [
      `database ${all.db}`,
      `database ${all.registryDb}`,
      `bucket ${all.bucket}`,
      `namespace ${all.artifacts}`,
    ];
  });
  assert.deepEqual(result.deleted.toSorted(), doomed.toSorted());
  assert.equal(of("preview.reconcile.deleted").length, 8);
  assert.equal(of("preview.reconcile.candidate").length, 8);
  assert.deepEqual(
    left(fake),
    [
      ...live.flatMap((slug) => [
        names(slug).db,
        names(slug).registryDb,
        names(slug).bucket,
        names(slug).artifacts,
      ]),
      "gitmatrix",
    ].toSorted(),
  );
});

await test("reconcile leaves young resources and their same-named siblings", async () => {
  const fake = account(["alive", "fresh", "stale"], {
    previews: [names("alive").preview],
    // A create in flight (perhaps in another source): its D1 is new, and its
    // namespace, whose listing carries no time, shares the D1's name.
    created: { [names("fresh").db]: RECENT },
  });
  const { deployments } = fakeDeployments([{ id: 1, timeline: "alive" }]);
  const { result, of } = await reconciling(fake, deployments);
  const fresh = names("fresh");
  assert.ok(left(fake).includes(fresh.db));
  assert.ok(left(fake).includes(fresh.artifacts));
  assert.ok(
    of("preview.reconcile.skipped").some(
      (e) => e.name === fresh.artifacts && e.reason === "created recently",
    ),
  );
  // The registry D1 is old: nothing says a create still owns it.
  assert.ok(result.deleted.includes(`database ${fresh.registryDb}`));
  assert.ok(result.deleted.includes(`namespace ${names("stale").artifacts}`));
  // With creation times, a namespace's own age counts too.
  const timed = account(["alive", "new"], {
    previews: [names("alive").preview],
    namespaceTimes: true,
    created: { [names("new").artifacts]: RECENT },
  });
  const again = await reconciling(
    timed,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
  );
  assert.ok(!again.result.deleted.some((d) => d.includes(names("new").artifacts)));
  assert.ok(again.result.deleted.includes(`database ${names("new").registryDb}`));
});

await test("reconcile deletes the D1 it listed, and leaves a create's that replaced it", async () => {
  // The reviewer's repro: x's D1 is listed as uuid "old"; before reconcile
  // reaches it, a create starts and recreates it as "new".
  const fake = account(["alive", "x", "gone"], { previews: [names("alive").preview] });
  const x = names("x");
  fake.databases.find((d) => d.name === x.db)!.uuid = "old";
  const api = fake.cloudflare.api.bind(fake.cloudflare);
  let listed = false;
  fake.cloudflare.api = async (method, path) => {
    const reply = await api(method, path);
    if (path.startsWith("/accounts/acct/artifacts/namespaces") && !listed) {
      // Reconcile's listings are done: the create runs.
      listed = true;
      fake.databases.find((d) => d.uuid === "old")!.uuid = "new";
    }
    return reply;
  };
  const { result, of } = await reconciling(
    fake,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
  );
  // Only the listed uuid was asked for; the create's D1, bucket and namespace stay.
  const deletes = fake.calls.filter((call) => call.startsWith("d1 delete"));
  assert.ok(deletes.includes("d1 delete old --force"));
  assert.ok(!deletes.some((call) => call.includes(" new ")));
  assert.ok(fake.databases.some((d) => d.uuid === "new" && d.name === x.db));
  for (const name of [x.bucket, x.artifacts]) assert.ok(left(fake).includes(name), name);
  assert.equal(
    of("preview.reconcile.skipped").filter((e) => e.reason === "a D1 of its name exists now")
      .length,
    2,
  );
  // Nothing stops the true orphan: its D1 went first, then its bucket and namespace.
  assert.ok(result.deleted.includes(`namespace ${names("gone").artifacts}`));
  assert.ok(result.deleted.includes(`bucket ${names("gone").bucket}`));
});

await test("the D1 recheck reads every page, and fails closed", async () => {
  // Many D1s contain "x"'s name (substring matches): the exact one is on the
  // last page, so a lookup that read one page would miss it.
  const x = names("x");
  const fake = account(["alive", "x"], {
    previews: [names("alive").preview],
    databases: Array.from({ length: 7 }, (_, i) => ({ uuid: `c${i}`, name: `${x.db}-${i}` })),
    // Young, so they stay listed through the recheck.
    created: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`${x.db}-${i}`, RECENT])),
  });
  // x's own D1 is made after the listing (as by a create), so it lists last.
  const api = fake.cloudflare.api.bind(fake.cloudflare);
  const own = fake.databases.findIndex((d) => d.name === x.db);
  const [made] = fake.databases.splice(own, 1);
  let listed = false;
  fake.cloudflare.api = async (method, path) => {
    const reply = await api(method, path);
    if (path.startsWith("/accounts/acct/artifacts/namespaces") && !listed) {
      listed = true;
      fake.databases.push(made!);
    }
    return reply;
  };
  const { of } = await reconciling(
    fake,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
  );
  for (const name of [x.bucket, x.artifacts]) assert.ok(left(fake).includes(name), name);
  assert.ok(
    of("preview.reconcile.skipped").some((e) => e.reason === "a D1 of its name exists now"),
  );
  // Eight matches in pages of two: the recheck read every page.
  const rechecks = fake.calls.filter((call) =>
    call.startsWith(`GET /accounts/acct/d1/database?name=${x.db}&`),
  );
  assert.ok(
    rechecks.some((call) => call.endsWith("&page=4")),
    rechecks.join("\n"),
  );
  // A lookup that fails leaves the bucket and namespace too.
  const failing = account(["alive", "y"], { previews: [names("alive").preview] });
  const y = names("y");
  failing.databases.splice(
    failing.databases.findIndex((d) => d.name === y.db),
    1,
  );
  const base = failing.cloudflare.api.bind(failing.cloudflare);
  // Only the recheck (by y's exact name) fails; the listings work.
  failing.cloudflare.api = async (method, path) =>
    path.startsWith(`/accounts/acct/d1/database?name=${y.db}&`)
      ? { status: 500, body: { success: false } }
      : base(method, path);
  const failed = await reconciling(
    failing,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
  );
  assert.equal(failed.result.skipped, undefined);
  for (const name of [y.bucket, y.artifacts]) assert.ok(left(failing).includes(name), name);
  assert.equal(failed.result.failures.length, 2);
});

await test("reconcile ignores a live timeline names() rejects, and goes on", async () => {
  const fake = account(["alive", "gone"], { previews: [names("alive").preview] });
  const long = "x".repeat(65);
  const { result, of } = await reconciling(
    fake,
    fakeDeployments([
      { id: 1, timeline: "alive" },
      { id: 2, timeline: long },
      { id: 3, timeline: "Not_A_Slug" },
    ]).deployments,
  );
  assert.equal(result.skipped, undefined);
  assert.deepEqual(
    of("preview.reconcile.ignored_slug").map((e) => e.timeline),
    [JSON.stringify("Not_A_Slug"), JSON.stringify(long)].toSorted(),
  );
  assert.equal(result.deleted.length, 4);
  assert.ok(left(fake).includes(names("alive").db));
});

await test("reconcile deletes at most --max per run", async () => {
  const dead = ["a1", "a2", "a3"];
  const fake = account(["alive", ...dead], { previews: [names("alive").preview] });
  const { result, of } = await reconciling(
    fake,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
    { max: 5 },
  );
  assert.equal(result.deleted.length, 5);
  assert.equal(result.candidates.length, 12);
  assert.equal(
    of("preview.reconcile.skipped").filter((e) => e.reason === "over --max 5").length,
    7,
  );
  assert.equal(RECONCILE_MAX, 20);
});

await test("reconcile fails closed: a listing error deletes nothing", async () => {
  for (const failing of [
    { deployments: true as boolean | number },
    // A server older than live-timelines.
    { deployments: 404 },
    { path: "/accounts/acct/artifacts/namespaces" },
    { path: "/accounts/acct/d1/database" },
    { path: "/accounts/acct/r2/buckets" },
    { path: "/accounts/acct/workers/workers/" },
  ]) {
    const fake = account(["alive", "gone"], {
      previews: [names("alive").preview],
      failing: failing.path ? [failing.path] : [],
    });
    const before = left(fake);
    const { deployments } = fakeDeployments([{ id: 1, timeline: "alive" }], {
      fail: failing.deployments,
    });
    const { result, of } = await reconciling(fake, deployments);
    assert.equal(result.skipped, "a listing failed", JSON.stringify(failing));
    assert.deepEqual(left(fake), before);
    assert.equal(of("preview.reconcile.skipped").length, 1);
    assert.ok(!fake.calls.some((call) => / delete |DELETE|bulk-delete/.test(call)));
  }
});

await test("reconcile fails closed with no live record while the Worker has Previews", async () => {
  const fake = account(["alive", "gone"], { previews: [names("alive").preview] });
  const before = left(fake);
  const { result } = await reconciling(fake, fakeDeployments([]).deployments);
  assert.match(result.skipped ?? "", /no live deployment records/);
  assert.deepEqual(left(fake), before);
  // A timeline names() rejects owns nothing: it doesn't count as live.
  const odd = await reconciling(
    fake,
    fakeDeployments([{ id: 1, timeline: "Not A Slug" }]).deployments,
  );
  assert.match(odd.result.skipped ?? "", /no live deployment records/);
  assert.deepEqual(left(fake), before);
  // No records and no Previews: everything is an orphan.
  const empty = account(["gone"]);
  const none = await reconciling(empty, fakeDeployments([]).deployments);
  assert.equal(none.result.deleted.length, 4);
});

await test("reconcile reports live timelines whose Preview isn't listed, and acts on nothing of theirs", async () => {
  const fake = account(["alive", "capped", "dozing"], {
    previews: [names("alive").preview],
  });
  const before = left(fake);
  const { deployments } = fakeDeployments([
    { id: 1, timeline: "alive" },
    { id: 2, timeline: "capped" },
    { id: 3, timeline: "capped" },
    // Sleeping: its Preview may be gone on purpose; reported all the same.
    { id: 5, timeline: "dozing", status: "sleeping" },
  ]);
  const { result, of } = await reconciling(fake, deployments);
  // Not listed isn't deleted (CORE-216): reported once per timeline, and the
  // records' own expiry tears it down.
  assert.deepEqual(
    of("preview.reconcile.preview_missing").map((e) => [e.timeline, e.preview]),
    [
      ["capped", names("capped").preview],
      ["dozing", names("dozing").preview],
    ],
  );
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(left(fake), before);
  // Read only: nothing but GETs reached the API.
  assert.ok(
    fake.calls.filter((call) => /^[A-Z]+ /.test(call)).every((call) => call.startsWith("GET ")),
  );
});

await test("reconcile keeps another source's live timeline with no Preview listed at all", async () => {
  // Since CORE-255 a timeline's records live in its work source. Its slug
  // comes back from live-timelines all the same, with the Worker listing no
  // Previews (CORE-216, or asleep), so nothing of it may go.
  const fake = account(["elsewhere", "gone"]);
  const { result, of } = await reconciling(
    fake,
    fakeDeployments([{ id: 1, timeline: "elsewhere", source: "work-b" }]).deployments,
  );
  assert.equal(result.skipped, undefined);
  for (const name of Object.values(names("elsewhere")))
    if (name !== names("elsewhere").preview) assert.ok(left(fake).includes(name), name);
  assert.equal(result.deleted.length, 4);
  assert.deepEqual(
    of("preview.reconcile.preview_missing").map((e) => e.timeline),
    ["elsewhere"],
  );
});

await test("Previews are listed to an empty or short page, never to total_count", async () => {
  const all = ["p1", "p2", "p3", "p4", "p5", "p6"].map((slug) => names(slug).preview);
  for (const shape of ["no total_count", "no result_info", "a wrong total_count"] as const) {
    // p6's D1 is old enough to delete, too young for its Preview to go (CORE-388).
    const fake = account(["alive", "p6"], {
      previews: all,
      created: { [names("p6").db]: HOURS_AGO(3) },
    });
    const base = fake.cloudflare.api.bind(fake.cloudflare);
    fake.cloudflare.api = async (method, path) => {
      const reply = await base(method, path);
      if (!/\/previews\?/.test(path)) return reply;
      const body = { ...(reply.body as { result_info: Record<string, unknown> }) };
      if (shape === "no total_count")
        body.result_info = { ...body.result_info, total_count: undefined };
      else if (shape === "no result_info") delete (body as { result_info?: unknown }).result_info;
      else body.result_info = { ...body.result_info, total_count: 2 };
      return { ...reply, body };
    };
    // p6's Preview is on the last page (of three, in pages of two), with no
    // record: its resources stay only if every page was read.
    const { result } = await reconciling(
      fake,
      fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
    );
    assert.deepEqual(result.deleted, [], shape);
    assert.ok(left(fake).includes(names("p6").db), shape);
    const pages = fake.calls.filter((call) => /\/previews\?/.test(call)).length;
    // A full last page needs one more, empty, to end.
    assert.equal(pages, 4, shape);
  }
});

await test("a short page ends a listing only once total_count is reached, and a repeated page throws", async () => {
  const previewPages = (calls: string[]) =>
    calls.filter((call) => /\/previews\?/.test(call)).length;
  const five = ["p1", "p2", "p3", "p4", "p5"].map((slug) => names(slug).preview);
  for (const [total, pages] of [
    [5, 3], // short third page, total reached: done
    [9, 4], // short third page, but total says more: read on to the empty page
    [undefined, 3], // no total: the short page ends it
  ] as const) {
    const fake = account(["alive"], { previews: five });
    const base = fake.cloudflare.api.bind(fake.cloudflare);
    fake.cloudflare.api = async (method, path) => {
      const reply = await base(method, path);
      if (!/\/previews\?/.test(path)) return reply;
      const body = reply.body as { result_info: Record<string, unknown> };
      return {
        ...reply,
        body: { ...body, result_info: { ...body.result_info, total_count: total } },
      };
    };
    // deletePreview (create's and teardown's) finds the Preview on the last page.
    await deletePreview(fake.cloudflare, "acct", names("p5").preview);
    assert.ok(!fake.previews.has(names("p5").preview), String(total));
    // Its own two listings (find, then confirm it's gone with one fewer).
    assert.ok(previewPages(fake.calls) >= pages, `${total}: ${previewPages(fake.calls)}`);
  }
  // A server that answers the same page whatever is asked would loop forever.
  const looping = account(["alive", "gone"], { previews: five });
  const base = looping.cloudflare.api.bind(looping.cloudflare);
  looping.cloudflare.api = (method, path) =>
    base(method, /\/previews\?/.test(path) ? path.replace(/&page=\d+/, "&page=1") : path);
  await assert.rejects(
    deletePreview(looping.cloudflare, "acct", names("p5").preview),
    /repeated a page/,
  );
  const before = left(looping);
  const { result } = await reconciling(
    looping,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
  );
  assert.equal(result.skipped, "a listing failed");
  assert.deepEqual(left(looping), before);
});

await test("a full last page ends the Previews listing when the next page is refused or repeated", async () => {
  // At exactly a multiple of the page size (as at the 500-Preview cap) every
  // listing asks for one page more; a server that refuses it, or answers the
  // last page again, has already shown all it counted.
  const four = ["p1", "p2", "p3", "p4"].map((slug) => names(slug).preview);
  for (const past of ["refused", "repeated"] as const) {
    const fake = account(["alive"], { previews: four });
    const base = fake.cloudflare.api.bind(fake.cloudflare);
    fake.cloudflare.api = async (method, path) => {
      if (!/\/previews\?/.test(path) || !/&page=3\b/.test(path)) return base(method, path);
      if (past === "refused") return { status: 400, body: { success: false, errors: [] } };
      return base(method, path.replace(/&page=3\b/, "&page=2"));
    };
    await deletePreview(fake.cloudflare, "acct", names("p4").preview);
    assert.ok(!fake.previews.has(names("p4").preview), past);
  }
  // Below the counted total, a refused page is still an error.
  const short = account(["alive"], { previews: four });
  const base = short.cloudflare.api.bind(short.cloudflare);
  short.cloudflare.api = async (method, path) =>
    /\/previews\?/.test(path) && /&page=2\b/.test(path)
      ? { status: 500, body: { success: false, errors: [] } }
      : base(method, path);
  await assert.rejects(
    deletePreview(short.cloudflare, "acct", names("p4").preview),
    /returned HTTP 500/,
  );
});

await test("reconcile stops inside a deletion at its deadline, and no resource goes first every run", async () => {
  // A bucket that never empties (its objects come back): without a deadline
  // the loop would run forever, and every later teardown with it.
  const fake = account(["alive", "stuck", "other"], { previews: [names("alive").preview] });
  const stuck = names("stuck").bucket;
  const cf = fake.cloudflare.cf.bind(fake.cloudflare);
  let lists = 0;
  fake.cloudflare.cf = async (args, env) => {
    if (args.slice(0, 3).join(" ") === "r2 objects list" && args.includes(stuck)) lists++;
    if (args.slice(0, 3).join(" ") === "r2 objects bulk-delete" && args.includes(stuck)) return "";
    return cf(args, env);
  };
  let now = 0;
  const clock = () => (now += 1_000);
  // The stuck name first.
  const first = (name: string) => (groups: { name: string }[][]) =>
    groups.toSorted((a, b) => Number(b[0]!.name === name) - Number(a[0]!.name === name));
  const run = await reconciling(fake, fakeDeployments([{ id: 1, timeline: "alive" }]).deployments, {
    clock,
    budgetMs: 60_000,
    order: first(stuck) as never,
  });
  assert.ok(lists > 0 && lists < 60, String(lists));
  assert.ok(
    run.result.failures.some((f) => f.startsWith(`bucket ${stuck}`) && /ran out of time/.test(f)),
  );
  assert.ok(run.of("preview.reconcile.skipped").some((e) => e.reason === "out of time"));
  // Another run in another order gets to the rest first.
  now = 0;
  const next = await reconciling(
    fake,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
    {
      clock,
      budgetMs: 60_000,
      order: first(names("other").db) as never,
    },
  );
  assert.ok(next.result.deleted.includes(`bucket ${names("other").bucket}`));
  assert.ok(next.result.deleted.includes(`namespace ${names("other").artifacts}`));
});

await test("reconcile leaves a bucket recreated since it was listed", async () => {
  const created: Record<string, string> = {};
  const fake = account(["alive", "x"], { previews: [names("alive").preview], created });
  const x = names("x");
  // x's D1 is gone already (a create's teardown); its bucket is recreated
  // after reconcile's listing.
  fake.databases.splice(
    fake.databases.findIndex((d) => d.name === x.db),
    1,
  );
  const api = fake.cloudflare.api.bind(fake.cloudflare);
  fake.cloudflare.api = async (method, path) => {
    const reply = await api(method, path);
    if (path.startsWith("/accounts/acct/artifacts/namespaces")) created[x.bucket] = RECENT;
    return reply;
  };
  const { result, of } = await reconciling(
    fake,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
  );
  assert.deepEqual(fake.buckets[x.bucket], ["k"]);
  assert.ok(!fake.calls.some((call) => call.startsWith("r2 objects") && call.includes(x.bucket)));
  assert.ok(
    of("preview.reconcile.skipped").some(
      (e) => e.name === x.bucket && /isn't the one listed/.test(String(e.reason)),
    ),
  );
  assert.ok(!result.deleted.includes(`bucket ${x.bucket}`));
});

await test("reconcile --dry-run logs candidates and changes nothing", async () => {
  const fake = account(["alive", "gone", "capped"], { previews: [names("alive").preview] });
  const before = left(fake);
  const { deployments } = fakeDeployments([
    { id: 1, timeline: "alive" },
    { id: 2, timeline: "capped" },
  ]);
  const { result, of } = await reconciling(fake, deployments, { dryRun: true });
  assert.deepEqual(left(fake), before);
  assert.equal(result.candidates.length, 4);
  assert.equal(of("preview.reconcile.candidate").length, 4);
  assert.equal(of("preview.reconcile.deleted").length, 0);
  assert.equal(of("preview.reconcile").at(-1)?.dryRun, true);
});

await test("reconcile never deletes a live name, even one another slug also maps to (CORE-377)", async () => {
  // "registry-foo"'s D1 has the name of "foo"'s registry D1.
  const fake = account(["registry-foo", "foo"], {
    previews: [names("registry-foo").preview],
  });
  assert.equal(names("registry-foo").db, names("foo").registryDb);
  const { result } = await reconciling(
    fake,
    fakeDeployments([{ id: 1, timeline: "registry-foo" }]).deployments,
  );
  assert.ok(left(fake).includes(names("registry-foo").db));
  assert.ok(result.deleted.includes(`database ${names("foo").db}`));
  assert.ok(!result.deleted.includes(`database ${names("foo").registryDb}`));
});

await test("reconcile keeps what a Preview without a readable record may own", async () => {
  // A Preview no live record explains, whose D1 is under a day old: a create
  // that may still record it, or failed recently. It and its data stay.
  const elsewhere = account(["alive", "other-source", "gone"], {
    previews: [names("alive").preview, names("other-source").preview],
    created: { [names("other-source").db]: HOURS_AGO(3) },
  });
  const kept = await reconciling(
    elsewhere,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
  );
  for (const name of Object.values(names("other-source")))
    if (name !== names("other-source").preview) assert.ok(left(elsewhere).includes(name), name);
  assert.equal(kept.result.deleted.length, 4);
  // A Preview names() didn't make could own anything.
  const foreign = account(["alive", "gone"], {
    previews: [names("alive").preview, "someone-elses"],
  });
  const before = left(foreign);
  const all = await reconciling(
    foreign,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
  );
  assert.deepEqual(all.result.deleted, []);
  assert.deepEqual(left(foreign), before);
  // A hashed name looks like a plain one, so a long slug's names can't be
  // read back; its hashed Preview still protects all of them.
  for (const long of [`${"l".repeat(40)}-${"m".repeat(20)}`, `${"k".repeat(45)}`]) {
    const hashed = account(["alive", long, "gone"], {
      previews: [names("alive").preview, names(long).preview],
      created: { [names(long).db]: HOURS_AGO(3) },
    });
    assert.ok(!names(long).preview.endsWith(long));
    const unknown = await reconciling(
      hashed,
      fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
    );
    for (const name of [names(long).db, names(long).registryDb, names(long).artifacts])
      assert.ok(left(hashed).includes(name), name);
    assert.ok(
      unknown
        .of("preview.reconcile.skipped")
        .some((e) => e.name === names(long).db && /no live record explains/.test(String(e.reason))),
    );
    assert.ok(unknown.result.deleted.includes(`database ${names("gone").db}`));
  }
});

await test("reconcile reports an orphaned namespace Cloudflare won't delete, and goes on", async () => {
  const fake = account(["alive", "stuck-one", "gone"], {
    previews: [names("alive").preview],
    stuck: [names("stuck-one").artifacts],
  });
  const stderr = captureStderr();
  try {
    const { result, of } = await reconciling(
      fake,
      fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
    );
    assert.ok(
      of("preview.reconcile.deleted").some(
        (e) => e.name === names("stuck-one").artifacts && e.outcome === "orphaned",
      ),
    );
    assert.ok(result.deleted.includes(`namespace ${names("gone").artifacts}`));
    assert.deepEqual(result.failures, []);
  } finally {
    stderr.restore();
  }
});

await test("reconcile takes --dry-run and --max", () => {
  assert.deepEqual(reconcileArgs([]), { dryRun: false, max: 20 });
  assert.deepEqual(reconcileArgs(["--dry-run", "--max", "3"]), { dryRun: true, max: 3 });
  for (const bad of [["--max"], ["--max", "0"], ["--max", "x"], ["--force"]])
    assert.throws(() => reconcileArgs(bad), /reconcile \[--dry-run\] \[--max N\]/);
});

await test("liveDeployments asks live-timelines with the job's credential, and a timeout", async () => {
  const requests: { url: string; auth: string | null; signal: boolean }[] = [];
  let answer: Response = Response.json({ timelines: ["a", "b"] });
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      auth: new Headers(init?.headers).get("authorization"),
      signal: init?.signal instanceof AbortSignal,
    });
    return answer;
  }) as typeof fetch;
  const live = liveDeployments(
    {
      GITMATRIX_URL: "https://gm.example/",
      GITMATRIX_REPOSITORY: "matrixorg/timelines",
      GITMATRIX_TOKEN: "gmj_secret",
    },
    request,
  );
  assert.deepEqual(await live.liveTimelines(), ["a", "b"]);
  assert.deepEqual(requests, [
    {
      url: "https://gm.example/api/repos/matrixorg/timelines/deployments/live-timelines",
      auth: "Bearer gmj_secret",
      signal: true,
    },
  ]);
  // An older server has no such route: an error, so reconcile skips.
  answer = Response.json({ error: "Not found" }, { status: 404 });
  await assert.rejects(live.liveTimelines(), /HTTP 404/);
  answer = Response.json({ timelines: [1] });
  await assert.rejects(live.liveTimelines(), /isn't a list of slugs/);
  assert.throws(
    () => liveDeployments({ GITMATRIX_URL: "https://gm.example" }),
    /GITMATRIX_REPOSITORY/,
  );
});

await test("reconcileMain never fails its job: setup errors are logged as skipped", async () => {
  const events: Record<string, unknown>[] = [];
  const log = (event: Record<string, unknown>) => events.push(event);
  await reconcileMain(["--max", "nope"], {}, log);
  await reconcileMain([], {}, log);
  await reconcileMain([], { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "t" }, log);
  assert.deepEqual(
    events.map((e) => [e.event, e.reason]),
    Array(3).fill(["preview.reconcile.skipped", "an error stopped it"]),
  );
  assert.match(String(events[0]?.error), /reconcile \[--dry-run\]/);
  assert.match(String(events[1]?.error), /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(String(events[2]?.error), /GITMATRIX_URL/);
});

await test("a rollback stops at its deadline when a bucket won't empty", async () => {
  const fake = fakeCloudflare({});
  const bucket = names("faster-search").bucket;
  const base = fake.cloudflare.cf.bind(fake.cloudflare);
  let deployed = false;
  let lists = 0;
  fake.cloudflare.cf = async (args, env) => {
    const command = args.slice(0, 3).join(" ");
    if (args[0] === "previews") deployed = true;
    // After the deploy, the bucket's objects come back however often they're deleted.
    if (deployed && command === "r2 objects list" && args.includes(bucket)) {
      lists++;
      return JSON.stringify([{ key: "back" }]);
    }
    if (deployed && command === "r2 objects bulk-delete") return "";
    return base(args, env);
  };
  let now = 0;
  const stderr = captureStderr();
  try {
    await assert.rejects(
      create(
        {
          ...deps(fake.cloudflare),
          seed: async () => {
            throw new Error("seed broke");
          },
          clock: () => (now += 60_000),
        },
        job,
      ),
      /seed broke/,
    );
  } finally {
    stderr.restore();
  }
  assert.ok(lists > 0 && lists < 20, String(lists));
  const events = stderr.lines
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const failed = events.find((event) => event.event === "preview.create.rollback-failed");
  assert.match(failed.error, /ran out of time/);
  // The rest went: the Preview and the databases.
  assert.equal(fake.previews.size, 0);
  assert.deepEqual(fake.databases, []);
});

await test("reconcile deletes a day-old Preview no live record explains, then its data (CORE-388)", async () => {
  const fake = account(["alive", "failed", "fresh", "dataless", "timeless"], {
    previews: [
      names("alive").preview,
      names("failed").preview,
      names("fresh").preview,
      "timeline-dataless-preview",
      names("timeless").preview,
    ],
    // fresh's create may still record it: under a day. timeless's D1 doesn't say.
    created: { [names("fresh").db]: HOURS_AGO(3), [names("timeless").db]: "unknown" },
  });
  // A Preview whose D1s are gone tells no age: kept.
  fake.databases.splice(
    0,
    fake.databases.length,
    ...fake.databases.filter((d) => !d.name.includes("dataless")),
  );
  const { result, of } = await reconciling(
    fake,
    fakeDeployments([
      { id: 1, timeline: "alive" },
      { id: 2, timeline: "failed", status: "failed" },
    ]).deployments,
  );
  assert.deepEqual(
    [...fake.previews.keys()].toSorted(),
    [
      names("alive").preview,
      names("fresh").preview,
      "timeline-dataless-preview",
      names("timeless").preview,
    ].toSorted(),
  );
  // The Preview first, then everything it may have owned.
  assert.equal(result.deleted[0], `preview ${names("failed").preview}`);
  for (const name of [names("failed").db, names("failed").registryDb, names("failed").bucket])
    assert.ok(!left(fake).includes(name), name);
  // fresh's data stays with its Preview.
  assert.ok(left(fake).includes(names("fresh").db));
  const reasons = Object.fromEntries(
    of("preview.reconcile.skipped")
      .filter((e) => e.kind === "preview")
      .map((e) => [e.name, e.reason]),
  );
  assert.equal(reasons[names("fresh").preview], "a D1 it may own is under a day old");
  assert.equal(reasons["timeline-dataless-preview"], "no D1 it may own tells its age");
  assert.equal(reasons[names("timeless").preview], "a D1 it may own has no creation time");
});

await test("reconcile never deletes a live timeline's Preview, however old its D1 (CORE-388)", async () => {
  const fake = account(["alive", "asleep"], {
    previews: [names("alive").preview, names("asleep").preview],
  });
  const { result } = await reconciling(
    fake,
    fakeDeployments([
      { id: 1, timeline: "alive", source: "work-a" },
      { id: 2, timeline: "asleep", status: "sleeping" },
    ]).deployments,
  );
  assert.deepEqual(result.deleted, []);
  assert.equal(fake.previews.size, 2);
});

await test("reconcile deletes the Preview it listed, never one a create deployed since", async () => {
  const fake = account(["alive", "failed"], {
    previews: [names("alive").preview, names("failed").preview],
  });
  const listedId = fake.previews.get(names("failed").preview)!.id;
  const base = fake.cloudflare.api.bind(fake.cloudflare);
  let replaced = false;
  fake.cloudflare.api = async (method, path) => {
    // A create tears the listed Preview down and deploys anew between the
    // listing and the delete.
    if (method === "DELETE" && !replaced) {
      replaced = true;
      fake.previews.set(names("failed").preview, {
        id: "pv-new",
        name: names("failed").preview,
        slug: names("failed").preview,
      });
    }
    return base(method, path);
  };
  const { result } = await reconciling(
    fake,
    fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
  );
  assert.ok(replaced);
  assert.notEqual(listedId, "pv-new");
  // The old id was already gone (404, and not listed): the new Preview stays.
  assert.equal(fake.previews.get(names("failed").preview)?.id, "pv-new");
  assert.ok(result.deleted.includes(`preview ${names("failed").preview}`));
});

await test("a Preview still listed after its delete keeps its data (CORE-216)", async () => {
  for (const answer of [200, 404]) {
    const fake = account(["alive", "failed"], {
      previews: [names("alive").preview, names("failed").preview],
    });
    const base = fake.cloudflare.api.bind(fake.cloudflare);
    fake.cloudflare.api = async (method, path) =>
      // The delete answers, but the Preview stays listed.
      method === "DELETE"
        ? { status: answer, body: { success: answer === 200 } }
        : base(method, path);
    const { result, of } = await reconciling(
      fake,
      fakeDeployments([{ id: 1, timeline: "alive" }]).deployments,
    );
    assert.ok(fake.previews.has(names("failed").preview), String(answer));
    assert.ok(!result.deleted.includes(`preview ${names("failed").preview}`), String(answer));
    assert.ok(
      of("preview.reconcile.failed").some(
        (e) => e.name === names("failed").preview && e.error === "still listed after its delete",
      ),
      String(answer),
    );
    // Its data stays with it.
    for (const name of [names("failed").db, names("failed").bucket, names("failed").artifacts])
      assert.ok(left(fake).includes(name), `${answer} ${name}`);
  }
});

await test("stale Previews count toward --max and the deadline, and a dry run lists their data", async () => {
  const slugs = ["a", "b", "c"];
  const make = () =>
    account(["alive", ...slugs], {
      previews: [names("alive").preview, ...slugs.map((slug) => names(slug).preview)],
    });
  const deployments = fakeDeployments([{ id: 1, timeline: "alive" }]).deployments;
  const capped = make();
  const one = await reconciling(capped, deployments, { max: 1, order: (groups) => groups });
  assert.equal(one.result.deleted.length, 1);
  assert.equal(capped.previews.size, 3);
  assert.ok(one.of("preview.reconcile.skipped").some((e) => e.reason === "over --max 1"));

  const late = make();
  let now = 0;
  const timed = await reconciling(late, deployments, {
    clock: () => (now += 60_000),
    budgetMs: 90_000,
  });
  assert.ok(timed.of("preview.reconcile.skipped").some((e) => e.reason === "out of time"));
  assert.ok(late.previews.size > 1);

  const dry = make();
  const listed = await reconciling(dry, deployments, { dryRun: true });
  assert.equal(dry.previews.size, 4);
  for (const slug of slugs) {
    assert.ok(listed.result.candidates.includes(`preview ${names(slug).preview}`), slug);
    assert.ok(listed.result.candidates.includes(`database ${names(slug).db}`), slug);
  }
  assert.deepEqual(listed.result.deleted, []);
});
