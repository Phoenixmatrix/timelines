// The gm reference stays true to gm (CORE-115): the snapshot the site renders
// must list exactly the commands, and the examples, that gm's manifest declares.
// When this fails, refresh the snapshot: `vp run site#gm-reference`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commandSlug, groupCommands, paramLabel, type GmManifest } from "./gm-reference.ts";

const manifest = JSON.parse(
  readFileSync(new URL("./data/gm-commands.json", import.meta.url), "utf8"),
) as GmManifest;
const metaSource = readFileSync(new URL("../../cli/src/meta.rs", import.meta.url), "utf8");

/** `meta!("timeline start", …, ex: ["gm timeline start x", …])` entries in meta.rs. */
function declared(): Map<string, string[]> {
  const commands = new Map<string, string[]>();
  for (const match of metaSource.matchAll(/meta!\("([^"]+)",([\s\S]*?)\),\n/g)) {
    const examples = /ex: \[([\s\S]*?)\]$/.exec(match[2]!.trim())?.[1] ?? "";
    commands.set(
      `gm ${match[1]}`,
      [...examples.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string),
    );
  }
  return commands;
}

await test("the snapshot lists every command gm declares, and no other", () => {
  const meta = declared();
  assert.ok(meta.size > 100, `meta.rs declares ${meta.size} commands`);
  assert.deepEqual(
    manifest.commands.map((command) => command.command).sort(),
    [...meta.keys()].sort(),
  );
});

await test("the snapshot's examples are gm's", () => {
  const meta = declared();
  for (const command of manifest.commands)
    assert.deepEqual(command.examples, meta.get(command.command), command.command);
});

await test("every command has a summary, a usage line and a unique anchor", () => {
  const slugs = new Set<string>();
  for (const command of manifest.commands) {
    assert.ok(command.summary.trim(), `${command.command} has a summary`);
    assert.match(command.usage, /^gm /, `${command.command} has a usage line`);
    const slug = commandSlug(command.command);
    assert.ok(!slugs.has(slug), `${slug} is unique`);
    slugs.add(slug);
  }
  assert.equal(commandSlug("gm timeline start"), "gm-timeline-start");
});

await test("commands group by their first word, in the manifest's order", () => {
  const groups = groupCommands(manifest.commands);
  const timeline = groups.find((group) => group.name === "timeline");
  assert.ok(timeline?.commands.some((command) => command.command === "gm timeline start"));
  assert.equal(
    groups.reduce((sum, group) => sum + group.commands.length, 0),
    manifest.commands.length,
  );
});

await test("parameters read the way gm's help writes them", () => {
  const base = { required: false, multiple: false, description: "" };
  assert.equal(paramLabel({ ...base, name: "--dry-run", flag: true }), "--dry-run");
  assert.equal(
    paramLabel({ ...base, name: "--message", short: "-m", flag: false }),
    "-m, --message <message>",
  );
  assert.equal(
    paramLabel({ ...base, name: "--policy", flag: false, choices: ["auto", "approval"] }),
    "--policy <auto|approval>",
  );
  assert.equal(paramLabel({ ...base, name: "SLUG", flag: false }), "SLUG");
});
