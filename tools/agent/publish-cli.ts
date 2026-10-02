import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Version by the last CLI-source change, not every website/docs push. Full history
// matters: a shallow boundary otherwise looks like it introduced every file.
function publish(): void {
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
  const gm = resolve(process.argv[2] ?? "apps/cli/target/release/gm");
  try {
    run(gm, [
      "pkg",
      "download",
      target,
      "--owner",
      owner,
      "--dest",
      ".gitmatrix/publish-check",
      "--dry-run",
    ]);
    console.log(
      JSON.stringify({
        event: "cli.publish.skipped",
        reason: "already-published",
        version,
        platform,
      }),
    );
    return;
  } catch (error) {
    // Only a genuine missing artifact permits publication; auth/network failures
    // must fail CI rather than silently skipping the release.
    if (!(error instanceof Error) || !("status" in error) || error.status !== 3) throw error;
  }
  const artifact = JSON.parse(run(gm, ["pkg", "upload", gm, target, "--owner", owner]));
  console.log(JSON.stringify({ event: "cli.published", version, platform, artifact }));
}

try {
  publish();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
