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
  names,
  previewUrl,
  redact,
  teardown,
  waitForPreview,
  type Cloudflare,
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
        databases.splice(
          databases.findIndex((d) => d.uuid === args[2]),
          1,
        );
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
      GITMATRIX_OWNER: "matrixorg",
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
          record: async () => assert.fail("must fail before record"),
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
    // Empty for teardown's own check, then a repository appears before provisioning.
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
  await assert.rejects(create(deps(fake.cloudflare), job), /forbidden/);
});
