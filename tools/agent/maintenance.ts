import { copyFile, mkdir, writeFile, readFile, rm, rename, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { command, registry, listEnvironments } from "./environment.ts";

const unitName = "gitmatrix-agent-cleanup";
const unitDirectory = join(homedir(), ".config", "systemd", "user");

/**
 * What the hourly janitor runs, copied out of the worktree that installs it. Every
 * `setup` reinstalls it, so the runtime imports reachable from environment.ts (which
 * janitor.ts imports) must stay within this list (maintenance.test.ts checks).
 */
export const JANITOR_FILES = [
  "quota.ts",
  "reservations.ts",
  "heavy.ts",
  "cloudflare-delete.ts",
  "environment.ts",
] as const;

/**
 * What the remote janitor copies besides JANITOR_FILES, relative to tools/agent. Its
 * entry.ts imports only Node builtins before dispatch; the runtime imports reachable from
 * it on the cleanup path must stay within both lists (maintenance.test.ts checks).
 */
export const REMOTE_JANITOR_ONLY = [
  "entry.ts",
  "remote.ts",
  "remote-build.ts",
  "remote-environment.ts",
  "remote-sync.ts",
  "remote-protocol.ts",
  "maintenance.ts",
  "types.ts",
  "../remote/cloudflare.config.ts",
] as const;

/** Install outside the worktree: cleanup still runs after a worktree is removed. */
export async function installMaintenance(): Promise<void> {
  // The hosted container's absolute lifetime is enforced by its owning DO alarm.
  if (process.env.GITMATRIX_REMOTE_HOSTED === "1") return;
  if (process.platform !== "linux")
    throw new Error(
      "Automatic cleanup currently requires Linux user systemd; do not provision without a recurring janitor.",
    );
  await command("systemctl", ["--user", "show-environment"]);
  await mkdir(registry, { recursive: true, mode: 0o700 });
  const source = dirname(fileURLToPath(import.meta.url));
  const checkout = dirname(dirname(source));
  const stablePath = [
    dirname(process.execPath),
    ...(process.env.PATH ?? "/usr/bin:/bin").split(":"),
  ]
    .filter(
      (entry) =>
        isAbsolute(entry) &&
        entry !== checkout &&
        !entry.startsWith(`${checkout}/`) &&
        !entry.endsWith("/node_modules/.bin"),
    )
    .join(":");
  const cfPath = (
    await command("which", ["cf"], { env: { ...process.env, PATH: stablePath } })
  ).trim();
  const gmPath = (
    await command("which", ["gm"], { env: { ...process.env, PATH: stablePath } })
  ).trim();
  for (const executable of [process.execPath, cfPath, gmPath]) {
    if ((await realpath(executable)).startsWith(`${checkout}/`))
      throw new Error("Scheduled cleanup requires Node, cf and gm installed outside the worktree.");
  }
  for (const name of JANITOR_FILES) {
    const temporary = join(registry, `${name}.${process.pid}.tmp`);
    await copyFile(join(source, name), temporary);
    await rename(temporary, join(registry, name));
  }
  await writeFile(
    join(registry, "janitor.ts"),
    'import { cleanupExpired } from "./environment.ts";\nawait cleanupExpired();\n',
    { mode: 0o600 },
  );
  await writeFile(join(registry, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
  await mkdir(unitDirectory, { recursive: true });
  const quote = (value: string) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  // No tokens in unit files. cf reads the user's credential store at execution time.
  const service = `[Unit]\nDescription=Delete expired Gitmatrix agent environments\n[Service]\nType=oneshot\nExecStart=${quote(process.execPath)} ${quote(join(registry, "janitor.ts"))}\nEnvironment=${quote(`PATH=${stablePath}`)}\nTimeoutStartSec=20min\n`;
  const timer = `[Unit]\nDescription=Hourly Gitmatrix agent resource cleanup\n[Timer]\nOnCalendar=hourly\nPersistent=true\nRandomizedDelaySec=5min\n[Install]\nWantedBy=timers.target\n`;
  await writeFile(join(unitDirectory, `${unitName}.service`), service);
  await writeFile(join(unitDirectory, `${unitName}.timer`), timer);
  await command("systemctl", ["--user", "daemon-reload"]);
  await command("systemctl", ["--user", "enable", "--now", `${unitName}.timer`]);
  console.log(
    JSON.stringify({
      event: "cleanup.scheduled",
      timer: `${unitName}.timer`,
      interval: "hourly",
      lifetimeHours: 24,
    }),
  );
}

/** Host-side resource cleanup survives both container expiry and worktree removal. */
export async function installRemoteMaintenance(root: string): Promise<void> {
  if (process.platform !== "linux")
    throw new Error("Remote resource cleanup requires Linux user systemd on the host.");
  if (process.env.GITMATRIX_REMOTE_HOSTED === "1")
    throw new Error("Remote maintenance must be installed on the authoritative host.");
  await command("systemctl", ["--user", "show-environment"]);
  const checkout = await realpath(root);
  const stablePath = [
    dirname(process.execPath),
    ...(process.env.PATH ?? "/usr/bin:/bin").split(":"),
  ]
    .filter(
      (entry) =>
        isAbsolute(entry) &&
        entry !== checkout &&
        !entry.startsWith(`${checkout}/`) &&
        !entry.endsWith("/node_modules/.bin"),
    )
    .join(":");
  const cfPath = (
    await command("which", ["cf"], {
      env: { ...process.env, PATH: stablePath },
    })
  ).trim();
  const gmPath = (
    await command("which", ["gm"], { env: { ...process.env, PATH: stablePath } })
  ).trim();
  for (const executable of [process.execPath, cfPath, gmPath]) {
    if ((await realpath(executable)).startsWith(`${checkout}/`))
      throw new Error("Scheduled cleanup requires Node, cf and gm installed outside the worktree.");
  }
  const destination = join(registry, "remote-janitor", "tools", "agent");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  // This entry imports only Node builtins before dispatch. Keep its complete
  // dependency closure outside the worktree, including maintenance's imports.
  for (const name of [...JANITOR_FILES, ...REMOTE_JANITOR_ONLY]) {
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await copyFile(join(checkout, "tools", "agent", name), temporary);
    await rename(temporary, target);
  }
  await writeFile(join(registry, "remote-janitor", "package.json"), '{"type":"module"}\n', {
    mode: 0o600,
  });
  await mkdir(unitDirectory, { recursive: true });
  const quote = (value: string) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
  const name = "gitmatrix-remote-cleanup";
  const service = `[Unit]\nDescription=Delete expired Gitmatrix remote resources\n[Service]\nType=oneshot\nExecStart=${quote(process.execPath)} ${quote(join(destination, "entry.ts"))} --execution cloudflare cleanup --expired\nEnvironment=${quote(`PATH=${stablePath}`)}\nTimeoutStartSec=30min\n`;
  const timer =
    "[Unit]\nDescription=Hourly Gitmatrix remote resource cleanup\n[Timer]\nOnCalendar=hourly\nPersistent=true\nRandomizedDelaySec=5min\n[Install]\nWantedBy=timers.target\n";
  await writeFile(join(unitDirectory, `${name}.service`), service);
  await writeFile(join(unitDirectory, `${name}.timer`), timer);
  await command("systemctl", ["--user", "daemon-reload"]);
  await command("systemctl", ["--user", "enable", "--now", `${name}.timer`]);
  console.log(
    JSON.stringify({
      event: "remote.cleanup.scheduled",
      timer: `${name}.timer`,
      interval: "hourly",
      lifetimeHours: 24,
    }),
  );
}

export async function maintenanceStatus(): Promise<string> {
  if (process.env.GITMATRIX_REMOTE_HOSTED === "1")
    return "Hosted environment expiry is enforced by the remote Durable Object alarm.";
  return command("systemctl", ["--user", "status", `${unitName}.timer`, "--no-pager"]);
}

export async function uninstallMaintenance(): Promise<void> {
  if (process.env.GITMATRIX_REMOTE_HOSTED === "1")
    throw new Error("Hosted expiry cannot be disabled; destroy the remote environment instead.");
  const records = await readFile(join(registry, "janitor.ts"), "utf8").catch(() => "");
  if (!records.includes("cleanupExpired")) throw new Error("No owned janitor installation found.");
  if ((await listEnvironments()).length)
    throw new Error("Destroy all owned environments before disabling automatic cleanup.");
  await command("systemctl", ["--user", "disable", "--now", `${unitName}.timer`]);
  for (const suffix of ["service", "timer"])
    await rm(join(unitDirectory, `${unitName}.${suffix}`), { force: true });
  await command("systemctl", ["--user", "daemon-reload"]);
}
