import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { publish, releases } from "./publish-cli.ts";

const version = "a".repeat(40);
function harness(statuses = [404, 404]) {
  const calls: { binary: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const requests: string[] = [];
  const env = {
    GITMATRIX_BRANCH: "main",
    GITMATRIX_URL: "https://registry.example.test",
    GITMATRIX_TOKEN: "test-token",
    GITMATRIX_SPACE: "orbit",
    CARGO_TARGET_DIR: "/tmp/cli-release-cache",
  };
  const run = (binary: string, args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ binary, args, env });
    return binary === "git" ? version : binary === "cargo" ? "" : "{}";
  };
  const request: typeof fetch = async (input, init) => {
    requests.push(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    assert.equal(init?.method, "HEAD");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    return new Response(null, { status: statuses[requests.length - 1]! });
  };
  return {
    calls,
    requests,
    options: { env, platform: "linux" as const, arch: "x64", run, request },
  };
}

await test("Linux CI publishes x86-64 and ARM64; native ARM64 and macOS keep their artifact names", () => {
  assert.deepEqual(releases("linux", "x64"), [
    { platform: "linux-x86_64" },
    { platform: "linux-aarch64", target: "aarch64-unknown-linux-gnu" },
  ]);
  assert.deepEqual(releases("linux", "arm64"), [{ platform: "linux-aarch64" }]);
  assert.deepEqual(releases("darwin", "arm64"), [{ platform: "macos-aarch64" }]);
  assert.throws(() => releases("win32", "x64"), /Unix only/);
});

await test("build both architectures before uploading with the native executable", async () => {
  const { calls, requests, options } = harness();
  await publish(options);
  assert.deepEqual(requests, [
    `https://registry.example.test/generic/orbit/gm/${version}/linux-x86_64/gm`,
    `https://registry.example.test/generic/orbit/gm/${version}/linux-aarch64/gm`,
  ]);
  assert.deepEqual(
    calls.map((c) => c.binary),
    [
      "git",
      "cargo",
      "cargo",
      "/tmp/cli-release-cache/release/gm",
      "/tmp/cli-release-cache/release/gm",
    ],
  );
  assert.deepEqual(calls[2]!.args.slice(-2), ["--target", "aarch64-unknown-linux-gnu"]);
  assert.ok(calls[1]!.args.includes("--locked"));
  assert.ok(calls[2]!.args.includes("--locked"));
  assert.equal(
    calls[2]!.env.CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER,
    "aarch64-linux-gnu-gcc",
  );
  assert.equal(calls[2]!.env.CC_aarch64_unknown_linux_gnu, "aarch64-linux-gnu-gcc");
  assert.equal(calls[2]!.env.AR_aarch64_unknown_linux_gnu, "aarch64-linux-gnu-ar");
  assert.deepEqual(calls[4]!.args, [
    "pkg",
    "upload",
    "/tmp/cli-release-cache/aarch64-unknown-linux-gnu/release/gm",
    `gm/${version}/linux-aarch64/gm`,
    "--space",
    "orbit",
  ]);
});

await test("backfill ARM64 when the native artifact already exists", async () => {
  const { calls, options } = harness([200, 404]);
  await publish(options);
  const uploads = calls.filter((c) => c.args[0] === "pkg");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.binary, "/tmp/cli-release-cache/release/gm");
  assert.equal(uploads[0]!.args[3], `gm/${version}/linux-aarch64/gm`);
});

await test("complete releases skip every build and upload", async () => {
  const { calls, requests, options } = harness([200, 200]);
  await publish(options);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    calls.map((c) => c.binary),
    ["git"],
  );
});

await test("registry authorization and service failures never trigger publication", async () => {
  for (const status of [401, 403, 500]) {
    const { calls, options } = harness([404, status]);
    await assert.rejects(
      publish({ ...options, env: { ...options.env, GITMATRIX_CLI_PROVISION_ARM64: "1" } }),
      new RegExp(`HTTP ${status}`),
    );
    assert.deepEqual(
      calls.map((c) => c.binary),
      ["git"],
    );
  }
});

await test("a failed ARM64 build publishes neither artifact", async () => {
  const { calls, options } = harness();
  await assert.rejects(
    publish({
      ...options,
      env: { ...options.env, GITMATRIX_CLI_PROVISION_ARM64: "1" },
      run: (binary, args, env) => {
        if (args.includes("--target")) throw new Error("cross compiler failed");
        return options.run(binary, args, env);
      },
    }),
    /cross compiler failed/,
  );
  assert.equal(
    calls.some((c) => c.args[0] === "pkg"),
    false,
  );
});

await test("upload failure fails the release instead of reporting success", async () => {
  const { options } = harness();
  await assert.rejects(
    publish({
      ...options,
      run: (binary, args, env) => {
        if (args[0] === "pkg") throw new Error("upload refused");
        return options.run(binary, args, env);
      },
    }),
    /upload refused/,
  );
});

await test("native ARM64 publication uploads its executable from the default target directory", async () => {
  const { calls, options } = harness([404]);
  const { CARGO_TARGET_DIR: _, ...env } = options.env;
  await publish({ ...options, arch: "arm64", env });
  const uploads = calls.filter((c) => c.args[0] === "pkg");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.binary, resolve("apps/cli/target/release/gm"));
  assert.equal(uploads[0]!.args[3], `gm/${version}/linux-aarch64/gm`);
  assert.equal(calls.filter((c) => c.binary === "cargo").length, 1);
});

await test("branches do not query, build or publish releases", async () => {
  const { calls, requests, options } = harness();
  await publish({ ...options, env: { ...options.env, GITMATRIX_BRANCH: "feature" } });
  assert.deepEqual(calls, []);
  assert.deepEqual(requests, []);
});

await test("opted-in CI provisions ARM64 only for missing ARM64 artifacts before builds and uploads", async () => {
  for (const statuses of [
    [200, 200],
    [404, 200],
    [200, 404],
    [404, 404],
  ]) {
    const { calls, requests, options } = harness(statuses);
    await publish({
      ...options,
      env: { ...options.env, GITMATRIX_CLI_PROVISION_ARM64: "1" },
      run: (binary, args, env) => {
        if (binary !== "git") assert.equal(requests.length, 2);
        return options.run(binary, args, env);
      },
    });
    const armMissing = statuses[1] === 404;
    const nativeMissing = statuses[0] === 404;
    const setups = calls.filter((call) => call.binary === "apt-get" || call.binary === "rustup");
    assert.deepEqual(
      setups.map(({ binary, args }) => [binary, ...args]),
      armMissing
        ? [
            ["apt-get", "update"],
            [
              "apt-get",
              "install",
              "-y",
              "--no-install-recommends",
              "gcc-aarch64-linux-gnu",
              "libc6-dev-arm64-cross",
            ],
            ["rustup", "target", "add", "aarch64-unknown-linux-gnu"],
          ]
        : [],
    );
    const gm = "/tmp/cli-release-cache/release/gm";
    assert.deepEqual(
      calls.map((call) => call.binary),
      [
        "git",
        ...(armMissing ? ["apt-get", "apt-get", "rustup"] : []),
        ...(nativeMissing || armMissing ? ["cargo"] : []),
        ...(armMissing ? ["cargo"] : []),
        ...(nativeMissing ? [gm] : []),
        ...(armMissing ? [gm] : []),
      ],
    );
    const uploads = calls.filter((call) => call.args[0] === "pkg");
    assert.deepEqual(
      uploads.map((call) => call.args[3]),
      [
        ...(nativeMissing ? [`gm/${version}/linux-x86_64/gm`] : []),
        ...(armMissing ? [`gm/${version}/linux-aarch64/gm`] : []),
      ],
    );
    if (armMissing) {
      const builds = calls.filter((call) => call.binary === "cargo");
      assert.equal(builds[0]!.args.includes("--target"), false);
      assert.deepEqual(builds[1]!.args.slice(-2), ["--target", "aarch64-unknown-linux-gnu"]);
      assert.equal(
        uploads.at(-1)!.args[2],
        "/tmp/cli-release-cache/aarch64-unknown-linux-gnu/release/gm",
      );
    }
  }
});

await test("provisioning requires exact opt-in and a supported cross-compilation host", async () => {
  for (const flag of [undefined, "0", "true"]) {
    const { calls, options } = harness();
    await publish({ ...options, env: { ...options.env, GITMATRIX_CLI_PROVISION_ARM64: flag } });
    assert.deepEqual(calls.map((call) => call.binary).slice(0, 3), ["git", "cargo", "cargo"]);
    assert.equal(
      calls.some((call) => call.binary === "apt-get" || call.binary === "rustup"),
      false,
    );
  }
  for (const [platform, arch] of [
    ["linux", "arm64"],
    ["darwin", "x64"],
  ] as const) {
    const { calls, options } = harness([404]);
    await publish({
      ...options,
      platform,
      arch,
      env: { ...options.env, GITMATRIX_CLI_PROVISION_ARM64: "1" },
    });
    assert.deepEqual(
      calls.map((call) => call.binary),
      ["git", "cargo", "/tmp/cli-release-cache/release/gm"],
    );
  }
});

await test("every provisioning failure aborts before building or publishing", async () => {
  for (const failure of ["update", "install", "target"]) {
    const { calls, options } = harness();
    await assert.rejects(
      publish({
        ...options,
        env: { ...options.env, GITMATRIX_CLI_PROVISION_ARM64: "1" },
        run: (binary, args, env) => {
          if ((binary === "apt-get" || binary === "rustup") && args[0] === failure)
            throw new Error(`setup failed: ${failure}`);
          return options.run(binary, args, env);
        },
      }),
      new RegExp(`setup failed: ${failure}`),
    );
    assert.equal(
      calls.some((call) => call.binary === "cargo" || call.args[0] === "pkg"),
      false,
    );
  }
});

await test("HEAD network failures cannot provision or publish even after a missing native artifact", async () => {
  const { calls, options } = harness([404]);
  let heads = 0;
  await assert.rejects(
    publish({
      ...options,
      env: { ...options.env, GITMATRIX_CLI_PROVISION_ARM64: "1" },
      request: async (input, init) => {
        if (++heads === 2) throw new Error("network unavailable");
        return options.request(input, init);
      },
    }),
    /network unavailable/,
  );
  assert.deepEqual(
    calls.map((call) => call.binary),
    ["git"],
  );
});

await test("a native build failure after provisioning cannot publish either artifact", async () => {
  const { calls, options } = harness();
  await assert.rejects(
    publish({
      ...options,
      env: { ...options.env, GITMATRIX_CLI_PROVISION_ARM64: "1" },
      run: (binary, args, env) => {
        if (binary === "cargo") throw new Error("native build failed");
        return options.run(binary, args, env);
      },
    }),
    /native build failed/,
  );
  assert.deepEqual(
    calls.map((call) => call.binary),
    ["git", "apt-get", "apt-get", "rustup"],
  );
});
