import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

type Release = { platform: string; target?: string };
type Run = (binary: string, args: string[], env: NodeJS.ProcessEnv) => string;

export function releases(platform: NodeJS.Platform, arch: string): Release[] {
  if (platform === "win32") throw new Error("CLI artifacts currently support Unix only.");
  const os = platform === "darwin" ? "macos" : platform;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
  const native = { platform: `${os}-${cpu}` };
  return platform === "linux" && arch === "x64"
    ? [native, { platform: "linux-aarch64", target: "aarch64-unknown-linux-gnu" }]
    : [native];
}

const execute: Run = (binary, args, env) =>
  execFileSync(binary, args, {
    env,
    encoding: "utf8",
    timeout: 1_800_000,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

// Version by the CLI source tree (Cargo.lock included). Check each platform:
// an existing x86-64 release must not prevent backfilling its ARM64 artifact.
export async function publish({
  env: sourceEnv = process.env,
  platform = process.platform,
  arch = process.arch,
  nativeBinary = process.argv[2],
  run = execute,
  request = fetch,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  nativeBinary?: string;
  run?: Run;
  request?: typeof fetch;
} = {}): Promise<void> {
  if (sourceEnv.GITMATRIX_BRANCH !== "main") {
    console.log(JSON.stringify({ event: "cli.publish.skipped", reason: "not-main" }));
    return;
  }
  const server = sourceEnv.GITMATRIX_URL;
  const token = sourceEnv.GITMATRIX_TOKEN;
  const space = sourceEnv.GITMATRIX_SPACE;
  if (!server || !token || !space)
    throw new Error("CLI publication requires CI registry credentials.");
  const env = {
    ...sourceEnv,
    GM_SERVER: server,
    GM_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: `http.${server.replace(/\/$/, "")}/.extraHeader`,
    GIT_CONFIG_VALUE_1: `Authorization: Bearer ${token}`,
  };
  const version = run("git", ["rev-parse", "HEAD:apps/cli"], env);
  if (!/^[a-f0-9]{40}$/.test(version)) throw new Error("No apps/cli tree at HEAD.");
  const missing: Release[] = [];
  for (const release of releases(platform, arch)) {
    const target = `gm/${version}/${release.platform}/gm`;
    // Only a genuine 404 permits publication; auth/network failures fail CI.
    const status = await request(`${server.replace(/\/$/, "")}/generic/${space}/${target}`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.status);
    if (status === 200) {
      console.log(
        JSON.stringify({
          event: "cli.publish.skipped",
          reason: "already-published",
          version,
          platform: release.platform,
        }),
      );
    } else if (status === 404) missing.push(release);
    else throw new Error(`Checking for ${target} returned HTTP ${status}.`);
  }
  if (!missing.length) return;

  // CI explicitly opts into package installation; standalone callers keep using
  // their preinstalled cross toolchain. Never provision for native-only releases.
  if (
    sourceEnv.GITMATRIX_CLI_PROVISION_ARM64 === "1" &&
    platform === "linux" &&
    arch === "x64" &&
    missing.some((release) => release.target === "aarch64-unknown-linux-gnu")
  ) {
    run("apt-get", ["update"], env);
    run(
      "apt-get",
      [
        "install",
        "-y",
        "--no-install-recommends",
        "gcc-aarch64-linux-gnu",
        "libc6-dev-arm64-cross",
      ],
      env,
    );
    run("rustup", ["target", "add", "aarch64-unknown-linux-gnu"], env);
  }

  // Always use a host executable to upload, including when only ARM64 is missing.
  run("cargo", ["build", "--locked", "--release", "--manifest-path", "apps/cli/Cargo.toml"], env);
  const output = sourceEnv.CARGO_TARGET_DIR ?? "apps/cli/target";
  const gm = resolve(nativeBinary ?? join(output, "release/gm"));
  // Finish every build before publishing, so a failed cross-build cannot make a
  // new version visible with only its native artifact. Reruns fill any upload gaps.
  for (const release of missing) {
    if (!release.target) continue;
    run(
      "cargo",
      [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        "apps/cli/Cargo.toml",
        "--target",
        release.target,
      ],
      {
        ...env,
        CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "aarch64-linux-gnu-gcc",
        CC_aarch64_unknown_linux_gnu: "aarch64-linux-gnu-gcc",
        AR_aarch64_unknown_linux_gnu: "aarch64-linux-gnu-ar",
      },
    );
  }
  for (const release of missing) {
    const binary = release.target ? resolve(output, release.target, "release/gm") : gm;
    const target = `gm/${version}/${release.platform}/gm`;
    const artifact = JSON.parse(run(gm, ["pkg", "upload", binary, target, "--space", space], env));
    console.log(
      JSON.stringify({ event: "cli.published", version, platform: release.platform, artifact }),
    );
  }
}

if (import.meta.main) {
  try {
    await publish();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
