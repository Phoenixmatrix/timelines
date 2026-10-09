// Refreshes the gm reference's snapshot (src/data/gm-commands.json) from this
// checkout's gm source, so the site documents the gm on this commit (CORE-115).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const json = execFileSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--manifest-path",
    resolve(root, "../cli/Cargo.toml"),
    "--",
    "cli",
    "commands",
    "-o",
    "json",
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
);
const manifest = JSON.parse(json) as { commands: unknown[] };
writeFileSync(resolve(root, "src/data/gm-commands.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.commands.length} commands to src/data/gm-commands.json.`);
