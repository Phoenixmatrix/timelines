import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commandSlug, groupCommands, paramLabel, type GmManifest } from "./gm-reference.ts";

const manifest = JSON.parse(
  readFileSync(new URL("./data/gm-commands.json", import.meta.url), "utf8"),
) as GmManifest;

await test("every command has a unique reference anchor", () => {
  const slugs = new Set<string>();
  for (const command of manifest.commands) {
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
