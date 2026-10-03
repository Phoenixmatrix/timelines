import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { previewKey } from "../../apps/website/vite/preview.ts";
import {
  accessLink,
  bounded,
  create,
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

/** A Cloudflare account in memory: D1s, buckets, namespaces and Previews. */
function fakeCloudflare(state: {
  databases?: { uuid: string; name: string }[];
  buckets?: Record<string, string[]>;
  namespaces?: Record<string, string[]>;
  previews?: string[];
}) {
  const databases = state.databases ?? [];
  const buckets = state.buckets ?? {};
  const namespaces = state.namespaces ?? {};
  const previews = new Set(state.previews ?? []);
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
        if (!bucket) throw new Error("HTTP 404: The specified bucket does not exist.");
        return JSON.stringify(bucket.slice(0, 2).map((key) => ({ key })));
      }
      if (command === "r2 objects bulk-delete") {
        const name = flag(args, "--bucket-name");
        const keys = JSON.parse(flag(args, "--body")) as string[];
        buckets[name] = buckets[name]!.filter((key) => !keys.includes(key));
        return "";
      }
      if (command === "r2 buckets delete") {
        if (!buckets[args[3]!]) throw new Error("HTTP 404: no such bucket");
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
        delete namespaces[args[3]!];
        return "";
      }
      if (command === "artifacts namespaces create") {
        namespaces[flag(args, "--namespace")] = [];
        return "{}";
      }
      if (command.startsWith("previews deploy")) {
        assert.ok(env, "previews deploy gets the preview's resources");
        previews.add(args[2]!);
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
      const name = decodeURIComponent(path.split("/").pop()!);
      if (!previews.delete(name))
        return { status: 404, body: { errors: [{ code: 10025, message: "Preview not found" }] } };
      return { status: 200, body: { success: true } };
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
    { slug: "faster-search", account: "acct", env: {} },
  );
  assert.equal(url, "https://timeline-faster-search-gitmatrix.example.workers.dev");
  // The old Preview went first, then the old data; the other timeline's survived.
  assert.equal(
    fake.calls[0],
    "DELETE /accounts/acct/workers/workers/gitmatrix/previews/timeline-faster-search",
  );
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
  });
  assert.deepEqual(steps, [
    `wait ${url} timeline-faster-search`,
    `seed ${url} db-1`,
    `gm deploy record --url ${url}/?preview_key=${previewKey("s".repeat(64))}`,
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
  const seen: string[] = [];
  await waitForPreview(
    "https://p.example",
    { name: "timeline-x", secret: "k" },
    {
      delayMs: 0,
      request: (async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        seen.push(`${url} ${headers.get("authorization")} ${headers.get("x-preview-key")}`);
        return answers.shift()!();
      }) as typeof fetch,
    },
  );
  assert.equal(seen.length, 4);
  assert.equal(seen[0], `https://p.example/api/dev/environment Bearer k ${previewKey("k")}`);
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

await test("the access link carries a derived key that nothing prints", () => {
  const secret = "q".repeat(64);
  const key = previewKey(secret);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, secret);
  assert.equal(accessLink("https://p.example", key), `https://p.example/?preview_key=${key}`);
  hide(secret);
  hide(key);
  assert.equal(
    redact(`recorded ${accessLink("https://p.example", key)} with ${secret}`),
    "recorded https://p.example/?preview_key=[hidden] with [hidden]",
  );
});
