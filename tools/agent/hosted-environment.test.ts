import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Environment } from "./environment.ts";
import { developmentEnvironment } from "../../apps/website/vite/environment.ts";

const preview = "https://gmr-0123456789abcdef.example.workers.dev";
const execute = promisify(execFile);

function owned(root: string, port = 5270): Environment {
  return {
    version: 1,
    id: "gma-mga00000-012345abcdef",
    root,
    dir: join(root, ".gitmatrix-agent"),
    origin: `http://127.0.0.1:${port}`,
    port,
    account: "a".repeat(32),
    created: 1_800_000_000_000,
    expires: 1_800_086_400_000,
    secret: "b".repeat(64),
    dispatchSecret: "c".repeat(64),
    resources: { artifacts: "created", vectors: "deleted", search: "deleted", gateway: "deleted" },
    status: "ready",
    ai: false,
  };
}

function runtime(): NodeJS.ProcessEnv {
  const env = owned("/tmp/hosted-worktree");
  return {
    GITMATRIX_AGENT_ID: env.id,
    GITMATRIX_PORT: String(env.port),
    GITMATRIX_PUBLIC_URL: preview,
    GITMATRIX_REMOTE_HOSTED: "1",
    GITMATRIX_REMOTE_ORIGIN: preview,
    GITMATRIX_STATE_DIR: `${env.dir}/state`,
    GITMATRIX_GM: `${env.root}/apps/cli/target/debug/gm`,
    GITMATRIX_ARTIFACTS_NAMESPACE: env.id,
    GITMATRIX_VECTORIZE_INDEX: env.id,
    GITMATRIX_SEARCH_NAMESPACE: env.id,
    GITMATRIX_AGENT_AI: "disabled",
    GITMATRIX_AGENT_SECRET: env.secret,
    GITMATRIX_CI_DISPATCH_SECRET: env.dispatchSecret,
    GITMATRIX_CI_RUNNER: "local",
    TMPDIR: `/tmp/gitmatrix-agent/workspaces/${env.id}/tmp`,
    XDG_CONFIG_HOME: `${env.dir}/config`,
    XDG_CACHE_HOME: `${env.dir}/cache`,
    XDG_DATA_HOME: `${env.dir}/data`,
  };
}

// A fresh process makes HOME-derived registry paths and inherited hosted variables
// deterministic without modifying the test runner's environment or real journal.
async function isolated(body: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-hosted-regression-"));
  try {
    const root = join(home, "worktree");
    await mkdir(root);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(GITMATRIX_|GM_|CLOUDFLARE_|NODE_OPTIONS$)/.test(key)) delete env[key];
    }
    Object.assign(env, {
      HOME: home,
      GITMATRIX_REMOTE_HOSTED: "1",
      GITMATRIX_REMOTE_ORIGIN: preview,
      GITMATRIX_AGENT_EXECUTION: "cloudflare",
      GITMATRIX_REMOTE_CREDENTIALS_FILE: join(home, "credentials.json"),
    });
    await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { readFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { command, context, markServer, registry, unitTestEnvironment } from ${JSON.stringify(new URL("./environment.ts", import.meta.url).href)};
      import { developmentEnvironment } from ${JSON.stringify(new URL("../../apps/website/vite/environment.ts", import.meta.url).href)};
      import { readEnvironmentLimits, reserveQuota, releaseQuota } from ${JSON.stringify(new URL("./quota.ts", import.meta.url).href)};
      // Explicit transport fixture only; API invariants use migrated SQLite tests.
      async function quotaFixture(maximum = Infinity) {
        const credentials = { env: {
          CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
          CLOUDFLARE_API_TOKEN: 'fixture-cloudflare-capability',
          GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY: 'https://quota.example',
          GITMATRIX_ENVIRONMENT_QUOTA_TOKEN: 'fixture-quota-capability',
        } };
        await writeFile(process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE, JSON.stringify(credentials));
        const reservations = new Map();
        const published = new Map();
        globalThis.fetch = async (url, options) => {
          if (url === 'http://127.0.0.1:8787/ownership') {
            const value = JSON.parse(options.body).environment;
            published.set(value.id, value);
            return new Response(null, { status: 204 });
          }
          assert.ok(url.startsWith('https://quota.example/api/environments/reservations'));
          assert.equal(options.headers.authorization, 'Bearer fixture-quota-capability');
          assert.equal(options.redirect, 'error');
          if (options.method === 'POST') {
            const value = JSON.parse(options.body);
            assert.equal(published.get(value.id)?.quota?.state, 'pending');
            if (!reservations.has(value.id) && reservations.size >= maximum)
              return Response.json({ error: 'Installation environment limit reached (' + reservations.size + '/' + maximum + '). Destroy unused environments on their owning machines, or ask a site administrator to change gm settings environments set --site --max. Expired reservations still require cleanup.' }, { status: 409 });
            reservations.set(value.id, value);
            return Response.json({ reserved: true, id: value.id });
          }
          const id = url.split('/').at(-1);
          reservations.delete(id);
          return Response.json({ released: true, id });
        };
        return { reservations, published, credentials };
      }
      const env = ${JSON.stringify(owned(root))};
      const preview = ${JSON.stringify(preview)};
      ${body}
    `,
      ],
      { env, timeout: 15_000 },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

await test("hosted quota admission reports safe capacity without exposing HTTP diagnostics", async () => {
  await isolated(`
    const { reservations, published } = await quotaFixture(0);
    const persist = async record => { published.set(record.id, structuredClone(record)); };
    await assert.rejects(reserveQuota(env, 'remote', persist), error => {
      assert.match(error.message, /Installation environment limit reached \\(0\\/0\\)/);
      assert.match(error.message, /owning machines/);
      assert.match(error.message, /site administrator/);
      assert.match(error.message, /Expired reservations still require cleanup/);
      assert.doesNotMatch(error.message, /transport or credentials|Deploy/);
      return true;
    });
    assert.equal(env.quota.state, 'pending');
    assert.equal(reservations.size, 0);
    const capacity = 'Installation environment limit reached (4/4). Destroy unused environments on their owning machines, or ask a site administrator to change gm settings environments set --site --max. Expired reservations still require cleanup.';
    for (const [status, body, expected] of [
      [409, { error: 'Environment reservation belongs to a different owner or configuration.' }, /different owner or configuration/],
      [409, { error: capacity + ' fixture-quota-capability' }, /no recognized capacity diagnostic/],
      [409, { error: capacity.replace('(4/4)', '(4/2147483648)') }, /no recognized capacity diagnostic/],
      [409, { error: capacity.replace('(4/4)', '(4/1.5)') }, /no recognized capacity diagnostic/],
      [409, { error: { message: capacity } }, /no recognized capacity diagnostic/],
      [409, ['fixture-quota-capability'], /no recognized capacity diagnostic/],
      [401, { error: capacity }, /authorization failed \\(401\\)/],
      [403, { error: 'fixture-quota-capability' }, /authorization failed \\(403\\)/],
      [500, { error: capacity }, /Quota request failed \\(500\\)/],
    ]) {
      globalThis.fetch = async () => Response.json(body, { status });
      await assert.rejects(reserveQuota(env, 'remote', persist), error => {
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /fixture-quota-capability|Installation environment limit reached/);
        return true;
      });
      assert.equal(env.quota.state, 'pending');
    }
    globalThis.fetch = async () => new Response('fixture-quota-capability', { status: 409 });
    await assert.rejects(reserveQuota(env, 'remote', persist), /no recognized capacity diagnostic/);
    globalThis.fetch = async () => { throw new Error('fixture-quota-capability'); };
    await assert.rejects(reserveQuota(env, 'remote', persist), error => {
      assert.match(error.message, /transport or credentials/);
      assert.doesNotMatch(error.message, /fixture-quota-capability/);
      return true;
    });
  `);
});

await test("hosted main accepts only its exact HTTPS preview origin on port 5270", () => {
  const result = developmentEnvironment(runtime());
  assert.equal(result.hosted, true);
  assert.equal(result.port, 5270);
  assert.equal(result.host, "127.0.0.1");
  assert.equal(result.publicUrl, preview);
  for (const port of ["5180", "5271", "9229", "19231"]) {
    assert.throws(() => developmentEnvironment({ ...runtime(), GITMATRIX_PORT: port }), /5270/);
  }
  for (const origin of [
    "not a URL",
    preview.replace("https:", "http:"),
    `${preview}/`,
    `${preview}/path`,
    `${preview}?ticket=secret`,
    `${preview}#fragment`,
    preview.replace("https://", "https://user:password@"),
    preview.replace("https://", "https://USER@"),
    preview.replace("gmr-", "GMR-"),
    `${preview}:443`,
    "https://bad host.example",
    "https://*.example.workers.dev",
    "https://.example.workers.dev",
  ]) {
    assert.throws(
      () =>
        developmentEnvironment({
          ...runtime(),
          GITMATRIX_REMOTE_ORIGIN: origin,
          GITMATRIX_PUBLIC_URL: origin,
        }),
      origin,
    );
  }
  assert.throws(
    () =>
      developmentEnvironment({
        ...runtime(),
        GITMATRIX_PUBLIC_URL: "https://another-worktree.example.workers.dev",
      }),
    /preview origin/,
  );
});

await test("hosted variables never relax ordinary local origin ownership", () => {
  for (const hosted of [undefined, "0", "true"]) {
    assert.throws(
      () =>
        developmentEnvironment({
          ...runtime(),
          GITMATRIX_REMOTE_HOSTED: hosted,
        }),
      /matching loopback/,
    );
    const local = developmentEnvironment({
      ...runtime(),
      GITMATRIX_REMOTE_HOSTED: hosted,
      GITMATRIX_PUBLIC_URL: "http://127.0.0.1:5270",
    });
    assert.equal(local.hosted, false);
    assert.equal(local.publicUrl, "http://127.0.0.1:5270");
  }
  assert.throws(
    () =>
      developmentEnvironment({
        ...runtime(),
        GITMATRIX_REMOTE_ORIGIN: undefined,
      }),
    /matching loopback/,
  );
  assert.throws(
    () =>
      developmentEnvironment({
        ...runtime(),
        GITMATRIX_REMOTE_ORIGIN: undefined,
        GITMATRIX_PORT: "5180",
        GITMATRIX_PUBLIC_URL: "http://127.0.0.1:5180",
      }),
    /dedicated port/,
  );
  const build = developmentEnvironment({
    GITMATRIX_REMOTE_HOSTED: "1",
    GITMATRIX_REMOTE_ORIGIN: preview,
  });
  assert.equal(build.hosted, false);
  assert.equal(build.port, 5180);
  assert.equal(build.publicUrl, "http://localhost:5180");
});

await test("unit subprocesses cannot inherit hosted capabilities or reload the parent credential channel", async () => {
  await isolated(`
    const capabilities = {
      GITMATRIX_REMOTE_HOSTED: '1',
      GITMATRIX_REMOTE_ORIGIN: preview,
      GITMATRIX_AGENT_EXECUTION: 'cloudflare',
      GITMATRIX_AGENT_ID: env.id,
      GITMATRIX_AGENT_SECRET: 'fixture-agent-capability',
      GITMATRIX_REMOTE_OWNERSHIP_URL: 'https://fixture.example/ownership',
      GITMATRIX_REMOTE_CONTROL_TOKEN: 'fixture-control-capability',
      CLOUDFLARE_API_TOKEN: 'fixture-cloudflare-capability',
      CLOUDFLARE_ACCOUNT_ID: env.account,
      CF_API_TOKEN: 'fixture-legacy-cloudflare-capability',
      GM_TOKEN: 'fixture-gm-capability',
      GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY: 'https://quota.example',
      GITMATRIX_ENVIRONMENT_QUOTA_TOKEN: 'fixture-quota-capability',
      GM_SERVER: preview,
    };
    Object.assign(process.env, capabilities);
    const channel = process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE;
    await assert.rejects(readFile(channel), { code: 'ENOENT' });
    const script = 'console.log(JSON.stringify({ keys: Object.keys(process.env), home: process.env.HOME, path: process.env.PATH, leaked: Object.values(process.env).some(value => value.includes("fixture-") && value.endsWith("-capability")) }))';
    // A normal hosted command really would read this channel. Only the explicit
    // unit boundary may remove it; mutating the parent would hide the regression.
    await assert.rejects(command(process.execPath, ['-e', script]), { code: 'ENOENT' });
    const output = JSON.parse(await command(process.execPath, ['-e', script], {
      env: unitTestEnvironment(process.env),
    }));
    for (const key of [...Object.keys(capabilities), 'GITMATRIX_REMOTE_CREDENTIALS_FILE'])
      assert.ok(!output.keys.includes(key), key + ' leaked into the unit subprocess');
    assert.equal(output.leaked, false);
    assert.equal(output.home, process.env.HOME);
    assert.equal(output.path, process.env.PATH);
    assert.equal(process.env.GITMATRIX_REMOTE_HOSTED, '1');
    assert.equal(process.env.CLOUDFLARE_API_TOKEN, capabilities.CLOUDFLARE_API_TOKEN);
    assert.equal(process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE, channel);
  `);
});

await test("hosted contexts preserve loopback consumers and isolate ephemeral previews", async () => {
  await isolated(`
    const quota = await quotaFixture();
    const main = await context(env);
    assert.equal(main.origin, 'http://127.0.0.1:5270');
    assert.equal(main.env.GM_SERVER, main.origin);
    assert.equal(main.env.GITMATRIX_PUBLIC_URL, preview);
    assert.equal(main.env.GITMATRIX_REMOTE_ORIGIN, preview);
    assert.equal(developmentEnvironment(main.env).hosted, true);
    const runs = [];
    for (const [index, port] of [19231, 19232].entries()) {
      const id = 'gma-mga00000-' + (index ? '112345abcdef' : '212345abcdef');
      const runRecord = { ...env, id, port,
        origin: 'http://127.0.0.1:' + port,
        dir: join(env.dir, 'runs', id),
      };
      delete runRecord.quota;
      const run = await context(runRecord);
      const config = developmentEnvironment(run.env);
      assert.equal(run.origin, 'http://127.0.0.1:' + port);
      assert.equal(run.env.GM_SERVER, run.origin);
      assert.equal(run.env.GITMATRIX_PUBLIC_URL, run.origin);
      assert.equal(run.env.GITMATRIX_REMOTE_ORIGIN, undefined);
      assert.equal(run.env.GITMATRIX_REMOTE_HOSTED, '1');
      assert.equal(run.env.GITMATRIX_AGENT_EXECUTION, 'local');
      assert.equal(run.env.GITMATRIX_REMOTE_CREDENTIALS_FILE, process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE);
      assert.equal(config.hosted, false);
      assert.equal(config.port, port);
      assert.notEqual(config.port, 5270);
      assert.notEqual(config.port, 9229);
      runs.push(run);
    }
    assert.notEqual(runs[0].env.GITMATRIX_PORT, runs[1].env.GITMATRIX_PORT);
    assert.notEqual(runs[0].env.GITMATRIX_STATE_DIR, runs[1].env.GITMATRIX_STATE_DIR);
    assert.notEqual(runs[0].env.TMPDIR, runs[1].env.TMPDIR);
    assert.equal(quota.reservations.size, 3, 'main and nested apps each consume global capacity');
    for (const value of quota.published.values()) {
      assert.equal(value.quota.state, 'reserved');
      assert.equal(JSON.stringify(value).includes('fixture-quota-capability'), false);
    }
  `);
});

await test("hosted quota refreshes only the pinned authority and preserves ambiguous reservations", async () => {
  await isolated(`
    const fixture = await quotaFixture();
    const snapshots = [];
    const persist = async record => {
      const snapshot = JSON.parse(JSON.stringify(record));
      snapshots.push(snapshot);
      fixture.published.set(record.id, snapshot);
    };
    process.env.GM_SERVER = 'https://product.example';
    process.env.GM_TOKEN = 'fixture-product-capability';
    const record = { id: 'gmr-' + 'a'.repeat(24), root: env.root,
      account: env.account, expires: env.expires };
    const transport = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      assert.equal(snapshots.at(-1).quota.state, 'pending');
      await transport(url, options);
      throw new Error('ambiguous network failure');
    };
    await assert.rejects(reserveQuota(record, 'remote', persist), /No admission fallback/);
    assert.equal(record.quota.state, 'pending');
    assert.equal(fixture.reservations.size, 1);
    const renewed = fixture.credentials;
    renewed.env.GITMATRIX_ENVIRONMENT_QUOTA_TOKEN = 'renewed-quota-capability';
    await writeFile(process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE, JSON.stringify(renewed));
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'https://quota.example/api/environments/reservations');
      assert.equal(options.headers.authorization, 'Bearer renewed-quota-capability');
      assert.equal(JSON.parse(options.body).backend, 'remote');
      return Response.json({ id: record.id, reserved: true });
    };
    await reserveQuota(record, 'remote', persist);
    assert.equal(record.quota.state, 'reserved');
    assert.equal(calls, 1);
    renewed.env.GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY = 'https://rotated.example';
    await writeFile(process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE, JSON.stringify(renewed));
    await assert.rejects(releaseQuota(record, persist), /pinned reservation/);
    assert.equal(calls, 1, 'a rotated credential must never reach the old authority');
    assert.equal(record.quota.authority, 'https://quota.example');
    assert.equal(record.quota.state, 'reserved');
    renewed.env.GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY = 'https://quota.example';
    await writeFile(process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE, JSON.stringify(renewed));
    for (const response of [{}, { id: 'wrong', released: true }, { id: record.id, released: false }]) {
      globalThis.fetch = async () => Response.json(response);
      await assert.rejects(releaseQuota(record, persist), /acknowledge/);
      assert.equal(record.quota.state, 'reserved');
    }
    globalThis.fetch = async (url, options) => {
      assert.equal(options.method, 'DELETE');
      assert.equal(url, 'https://quota.example/api/environments/reservations/' + record.id);
      return Response.json({ id: record.id, released: true });
    };
    await releaseQuota(record, persist);
    assert.equal(snapshots.at(-1).quota.state, 'released');
    await assert.rejects(reserveQuota(record, 'remote', persist), /cannot be reused/);
    assert.ok(!JSON.stringify(snapshots).includes('capability'));
  `);
});

await test("hosted quota cannot substitute product identity for a missing protected quota capability", async () => {
  await isolated(`
    process.env.GM_SERVER = 'https://product.example';
    process.env.GM_TOKEN = 'fixture-product-capability';
    await writeFile(process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE, JSON.stringify({ env: {
      CLOUDFLARE_ACCOUNT_ID: env.account, CLOUDFLARE_API_TOKEN: 'fixture-cloudflare-capability',
    } }));
    globalThis.fetch = async () => { throw new Error('quota RPC must not run'); };
    await assert.rejects(readEnvironmentLimits(), /authority and token are required together/);
    await assert.rejects(context(env), /authority and token are required together/);
  `);
});

await test("hosted ownership journal exports resource ownership without local capabilities", async () => {
  await isolated(`
    let recorded;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8787/ownership');
      assert.equal(options.method, 'POST');
      recorded = JSON.parse(options.body);
      return new Response(null, { status: 204 });
    };
    await markServer(env, process.pid);
    assert.deepEqual(recorded, { environment: {
      id: env.id, account: env.account, created: env.created, expires: env.expires,
      resources: env.resources, status: env.status, ai: false,
    } });
    const local = JSON.parse(await readFile(join(env.dir, 'environment.json'), 'utf8'));
    assert.equal(local.secret, env.secret);
    assert.equal(local.server.pid, process.pid);
  `);
});

await test("a hosted journal is on disk before its ownership record, as setup's probe lists it (CORE-374)", async () => {
  await isolated(`
    const { execFileSync } = await import('node:child_process');
    const { journalProbe } = await import(${JSON.stringify(new URL("./remote.ts", import.meta.url).href)});
    const listed = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', journalProbe],
      { encoding: 'utf8' }).trim().split('\\n').at(-1));
    // Nothing journaled yet: the directory is missing, not an error.
    assert.deepEqual(listed(), { event: 'environment.journals', ids: [] });
    let seen;
    globalThis.fetch = async (url) => {
      assert.equal(url, 'http://127.0.0.1:8787/ownership');
      seen = listed().ids;
      return new Response(null, { status: 204 });
    };
    await markServer(env, process.pid);
    // When the ownership record is written, the probe already lists its journal.
    assert.deepEqual(seen, [env.id]);
  `);
});

for (const failure of ["http", "transport"] as const) {
  await test(`hosted ownership ${failure} failure rejects without committing local state`, async () => {
    await isolated(`
      globalThis.fetch = async () => {
        ${failure === "http" ? "return new Response('unavailable', { status: 503 });" : "throw new Error('ownership transport unavailable');"}
      };
      await assert.rejects(markServer(env, process.pid), ${failure === "http" ? "/Remote ownership journal failed \\(503\\)/" : "/ownership transport unavailable/"});
      await assert.rejects(readFile(join(env.dir, 'environment.json')), { code: 'ENOENT' });
      const retained = JSON.parse(await readFile(join(registry, 'environments', env.id + '.json'), 'utf8'));
      assert.equal(retained.id, env.id);
      assert.deepEqual(retained.resources, env.resources);
    `);
  });
}

await test("hosted reservations carry no host and verify a release that removed nothing (CORE-368)", async () => {
  await isolated(`
    const fixture = await quotaFixture();
    const persist = async (value) => { fixture.published.set(value.id, JSON.parse(JSON.stringify(value))); };
    const record = { id: 'gmr-' + 'b'.repeat(24), root: env.root, account: env.account, expires: env.expires };
    await reserveQuota(record, 'remote', persist);
    assert.equal(Object.hasOwn(fixture.reservations.get(record.id), 'host'), false,
      'a hosted child must not claim a host before its parent journal knows it');
    await assert.rejects(readFile(join(registry, 'host.json')), { code: 'ENOENT' });
    let listed = true;
    const transport = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (options.method === 'DELETE') return Response.json({ id: record.id, released: true, removed: false });
      if (options.method === 'GET') {
        assert.equal(url, 'https://quota.example/api/environments');
        return Response.json({ maximum: 4, used: 1, reservations: listed ? [{ id: record.id, host: null }] : [] });
      }
      return transport(url, options);
    };
    await assert.rejects(releaseQuota(record, persist), /still lists it/);
    assert.equal(record.quota.state, 'reserved');
    listed = false;
    await releaseQuota(record, persist);
    assert.equal(record.quota.state, 'released');
  `);
});
