// Point the git CLI at a local Gitmatrix as one persona, with no browser:
//
//   pnpm run git:login priya            # write token, default host
//   pnpm run git:login jun --read       # clone/fetch only
//   GITMATRIX_URL=http://localhost:5180 pnpm run git:login sam
//
// Mints a token through the dev API, then stores it with git's own `store`
// credential helper in ~/.config/gitmatrix/credentials, scoped to this host.
// Running it again switches persona. DEVELOPMENT ONLY: the token is saved in
// plain text.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [persona, ...flags] = process.argv.slice(2);
if (!persona) {
  console.error("Usage: pnpm run git:login <persona> [--read]");
  process.exit(1);
}
const base = new URL(process.env.GITMATRIX_URL ?? "http://localhost:5180");
const scope = flags.includes("--read") ? "read" : "write";

const response = await fetch(new URL("/api/dev/tokens", base), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ persona, scope, name: "git CLI" }),
});
const body = (await response.json()) as { secret?: string; error?: string };
if (!response.ok || !body.secret) {
  console.error(`Could not mint a token: ${body.error ?? response.status}`);
  process.exit(1);
}

const dir = join(homedir(), ".config", "gitmatrix");
mkdirSync(dir, { recursive: true });
const file = join(dir, "credentials");
const key = `credential.${base.origin}`;
const git = (args: string[], input?: string) =>
  execFileSync("git", args, { input, stdio: ["pipe", "inherit", "inherit"] });

// An empty helper entry first clears helpers inherited from other config.
git(["config", "--global", "--replace-all", `${key}.helper`, ""]);
git(["config", "--global", "--add", `${key}.helper`, `store --file=${file}`]);
git(["config", "--global", `${key}.username`, persona]);
// Forget every saved token for this host, then save the new persona's.
const host = `protocol=${base.protocol.replace(":", "")}\nhost=${base.host}\n`;
git(["credential", "reject"], `${host}\n`);
git(["credential", "approve"], `${host}username=${persona}\npassword=${body.secret}\n\n`);

console.log(`git now talks to ${base.origin} as ${persona} (${scope} token).`);
console.log(`API calls: curl -H "Authorization: Bearer ${body.secret}" ${base.origin}/api/session`);
