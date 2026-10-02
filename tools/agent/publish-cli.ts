import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

// Version by the last CLI-source change, not every website/docs push. Full history
// matters: a shallow boundary otherwise looks like it introduced every file.
async function publish(): Promise<void> {
  if (process.env.GITMATRIX_BRANCH !== "main") {
    console.log(JSON.stringify({ event: "cli.publish.skipped", reason: "not-main" }));
    return;
  }
  const server = process.env.GITMATRIX_URL;
  const token = process.env.GITMATRIX_TOKEN;
  const owner = process.env.GITMATRIX_OWNER;
  if (!server || !token || !owner)
    throw new Error("CLI publication requires CI registry credentials.");
  const env = {
    ...process.env,
    GM_SERVER: server,
    GM_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: `http.${server.replace(/\/$/, "")}/.extraHeader`,
    GIT_CONFIG_VALUE_1: `Authorization: Bearer ${token}`,
  };
  const run = (binary: string, args: string[]) =>
    execFileSync(binary, args, {
      env,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (run("git", ["rev-parse", "--is-shallow-repository"]) === "true") {
    run("git", ["fetch", "--quiet", "--unshallow", "origin"]);
  }
  const version = run("git", ["log", "-1", "--format=%H", "HEAD", "--", "apps/cli"]);
  if (!/^[a-f0-9]{40}$/.test(version)) throw new Error("No CLI source commit found.");
  const os = process.platform === "darwin" ? "macos" : process.platform;
  if (process.platform === "win32") throw new Error("CLI artifacts currently support Unix only.");
  const arch =
    process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  const platform = `${os}-${arch}`;
  const target = `gm/${version}/${platform}/gm`;
  // Ask the registry first, so a push that didn't change gm doesn't compile it.
  // Only a genuine 404 permits publication; auth or network failures must fail
  // CI rather than silently skipping the release.
  const status = await fetch(`${server.replace(/\/$/, "")}/generic/${owner}/${target}`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.status);
  if (status === 200) {
    console.log(
      JSON.stringify({
        event: "cli.publish.skipped",
        reason: "already-published",
        version,
        platform,
      }),
    );
    return;
  }
  if (status !== 404) throw new Error(`Checking for ${target} returned HTTP ${status}.`);
  execFileSync("cargo", ["build", "--release", "--manifest-path", "apps/cli/Cargo.toml"], {
    env,
    stdio: "inherit",
  });
  // The CI runner's managed compiler cache moves Cargo's output via CARGO_TARGET_DIR.
  const gm = resolve(
    process.argv[2] ?? join(process.env.CARGO_TARGET_DIR ?? "apps/cli/target", "release/gm"),
  );
  const artifact = JSON.parse(run(gm, ["pkg", "upload", gm, target, "--owner", owner]));
  console.log(JSON.stringify({ event: "cli.published", version, platform, artifact }));
}

try {
  await publish();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
