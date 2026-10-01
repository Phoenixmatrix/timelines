// TypeScript 7's Node execve launcher aborts with EBUSY on this WSL runtime.
// Spawn the same installed native compiler instead; no diagnostics are bypassed.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.resolve("typescript/package.json"));
const platformPackage = require.resolve(
  `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
);
const executable = join(
  dirname(platformPackage),
  "lib",
  process.platform === "win32" ? "tsc.exe" : "tsc",
);
const result = spawnSync(executable, ["--noEmit", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
