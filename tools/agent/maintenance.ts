import { copyFile, mkdir, writeFile, readFile, rm, rename, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { command, registry, listEnvironments } from "./environment.ts";

const unitName = "gitmatrix-agent-cleanup";
const unitDirectory = join(homedir(), ".config", "systemd", "user");

/** Install outside the worktree: cleanup still runs after a worktree is removed. */
export async function installMaintenance(): Promise<void> {
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
  for (const executable of [process.execPath, cfPath]) {
    if ((await realpath(executable)).startsWith(`${checkout}/`))
      throw new Error("Scheduled cleanup requires Node and cf installed outside the worktree.");
  }
  const temporary = join(registry, `environment.${process.pid}.ts`);
  await copyFile(join(source, "environment.ts"), temporary);
  await rename(temporary, join(registry, "environment.ts"));
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

export async function maintenanceStatus(): Promise<string> {
  return command("systemctl", ["--user", "status", `${unitName}.timer`, "--no-pager"]);
}

export async function uninstallMaintenance(): Promise<void> {
  const records = await readFile(join(registry, "janitor.ts"), "utf8").catch(() => "");
  if (!records.includes("cleanupExpired")) throw new Error("No owned janitor installation found.");
  if ((await listEnvironments()).length)
    throw new Error("Destroy all owned environments before disabling automatic cleanup.");
  await command("systemctl", ["--user", "disable", "--now", `${unitName}.timer`]);
  for (const suffix of ["service", "timer"])
    await rm(join(unitDirectory, `${unitName}.${suffix}`), { force: true });
  await command("systemctl", ["--user", "daemon-reload"]);
}
