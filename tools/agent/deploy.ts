import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

// Deploy what changed on main since the deployed Worker versions, from CI.
//
// Every deploy tags its Worker version with the commit it was built from
// (`workers/tag`); the next run diffs from that commit. Migrations apply
// before the Worker deploys. The CI image can't be rebuilt here (a Sandbox
// has no Docker), so the deploy reuses the deployed version's image and a
// changed ci/Dockerfile fails the job after everything else has shipped.
//
// The public site (apps/site, CORE-115) is a Worker of its own, assets only,
// on timelines.fward.dev: it deploys the same way, from its own tag.

const WORKER = "gitmatrix";
const root = resolve(import.meta.dirname, "../..");
const website = join(root, "apps/website");
/** The website's own cf: pinned, patched, and not on PATH in CI. */
const cf = join(website, "node_modules/.bin/cf");
const SITE_WORKER = "gitmatrix-site";
const site = join(root, "apps/site");

/** Migration directories (relative to apps/website) and the D1 binding they target. */
const MIGRATIONS = [
  { prefix: "apps/website/migrations/", dir: "migrations", binding: "DB" },
  {
    prefix: "apps/website/registry/migrations/",
    dir: "registry/migrations",
    binding: "REGISTRY_DB",
  },
] as const;

export interface Plan {
  /** The Worker's code, assets or dependencies changed. */
  worker: boolean;
  /** The CI image's build context changed. */
  image: boolean;
  /** Migration directories with new or changed files. */
  migrations: (typeof MIGRATIONS)[number][];
}

/** Changes that never reach the deployed Worker. */
function inert(path: string): boolean {
  return (
    /\.(md|test\.tsx?)$/.test(path) ||
    path.startsWith("apps/website/.impeccable/") ||
    path.startsWith("apps/website/seed/") ||
    path.startsWith("apps/website/scripts/")
  );
}

/** What a set of changed paths (relative to the repository root) needs deployed. */
export function plan(changed: string[]): Plan {
  const migrations = MIGRATIONS.filter((m) => changed.some((path) => path.startsWith(m.prefix)));
  const image = changed.some((path) => path.startsWith("apps/website/ci/"));
  const worker = changed.some(
    (path) =>
      !inert(path) &&
      !path.startsWith("apps/website/ci/") &&
      !MIGRATIONS.some((m) => path.startsWith(m.prefix)) &&
      (path.startsWith("apps/website/") || path.startsWith("packages/") || shared(path)),
  );
  return { worker, image, migrations };
}

/** Shared inputs: a change here can change any Worker's build. */
function shared(path: string): boolean {
  return (
    path.startsWith("patches/") ||
    ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(path)
  );
}

/** Whether changed paths reach the public site: its sources (docs included) or shared inputs. */
export function sitePlan(changed: string[]): boolean {
  return changed.some(
    (path) =>
      (path.startsWith("apps/site/") &&
        !/\.test\.tsx?$/.test(path) &&
        path !== "apps/site/README.md") ||
      shared(path),
  );
}

function run(command: string, args: string[], cwd = root, env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

/** Run with output streamed into the job log. */
function stream(command: string, args: string[], cwd = root, env?: NodeJS.ProcessEnv): void {
  execFileSync(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
}

interface Deployed {
  tag: string | null;
  image: string;
  databases: Record<string, string>;
}

/** The version serving traffic: its commit tag, CI image and D1 ids. */
function deployed(): Deployed {
  const { deployments } = JSON.parse(
    run(cf, ["workers", "deployments", "list", "--worker", WORKER], website),
  ) as { deployments: { versions: { version_id: string; percentage: number }[] }[] };
  const current = deployments[0]?.versions.toSorted((a, b) => b.percentage - a.percentage)[0];
  if (!current) throw new Error(`${WORKER} has no deployment to compare with.`);
  const version = JSON.parse(
    run(cf, ["workers", "versions", "get", current.version_id, "--worker-id", WORKER], website),
  ) as {
    annotations?: Record<string, string>;
    bindings: { type: string; name: string; id?: string }[];
    containers?: { images: Record<string, string> }[];
  };
  const image = version.containers?.[0]?.images.default;
  if (!image) throw new Error(`Deployed version ${current.version_id} has no CI image.`);
  const tag = version.annotations?.["workers/tag"] ?? null;
  return {
    tag,
    image,
    databases: Object.fromEntries(
      version.bindings.filter((b) => b.type === "d1" && b.id).map((b) => [b.name, b.id!]),
    ),
  };
}

function knownCommit(sha: string | null): sha is string {
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return false;
  try {
    run("git", ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** `--plan` prints what would deploy and changes nothing, from any checkout. */
function deploy(planOnly: boolean): void {
  if (!planOnly && process.env.GITMATRIX_BRANCH !== "main") {
    console.log(JSON.stringify({ event: "deploy.skipped", reason: "not-main" }));
    return;
  }
  // CI's checkout is shallow (the last 50 commits), and the deployed commit is
  // almost always among them; if it isn't, knownCommit fails and everything deploys.
  const head = run("git", ["rev-parse", "HEAD"]);
  deployWebsite(head, planOnly);
  deploySite(head, planOnly);
}

/** The commit the site's live version was built from; null when it has never deployed. */
function siteTag(): string | null {
  let listed: string;
  try {
    listed = execFileSync(cf, ["workers", "deployments", "list", "--worker", SITE_WORKER], {
      cwd: site,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output = String((error as { stdout?: string; stderr?: string }).stderr ?? "");
    if (/does not exist|\[10007\]/.test(output)) return null;
    throw error;
  }
  const { deployments } = JSON.parse(listed) as {
    deployments: { versions: { version_id: string; percentage: number }[] }[];
  };
  const current = deployments[0]?.versions.toSorted((a, b) => b.percentage - a.percentage)[0];
  if (!current) return null;
  const version = JSON.parse(
    run(cf, ["workers", "versions", "get", current.version_id, "--worker-id", SITE_WORKER], site),
  ) as { annotations?: Record<string, string> };
  return version.annotations?.["workers/tag"] ?? null;
}

/** Build the site and deploy its assets-only Worker when anything it's built from changed. */
function deploySite(head: string, planOnly: boolean): void {
  const tag = siteTag();
  if (tag === head) {
    console.log(JSON.stringify({ event: "deploy.site.skipped", reason: "already-deployed", head }));
    return;
  }
  const base = knownCommit(tag) ? tag : null;
  const todo = base
    ? sitePlan(run("git", ["diff", "--name-only", base, head]).split("\n").filter(Boolean))
    : true;
  console.log(JSON.stringify({ event: "deploy.site.plan", base, head, site: todo }));
  if (planOnly || !todo) return;
  stream("vp", ["run", "--no-cache", "site#build"]);
  const subject = run("git", ["log", "-1", "--format=%s", head]);
  stream(
    join(site, "node_modules/.bin/cf"),
    ["deploy", "--prebuilt", "--tag", head, "--message", subject.slice(0, 100)],
    site,
  );
  console.log(JSON.stringify({ event: "deploy.site", head }));
}

function deployWebsite(head: string, planOnly: boolean): void {
  const current = deployed();
  if (current.tag === head) {
    console.log(JSON.stringify({ event: "deploy.skipped", reason: "already-deployed", head }));
    return;
  }
  // Without a known base, ship everything but the image, which only a Docker host can build.
  const base = knownCommit(current.tag) ? current.tag : null;
  const todo = base
    ? plan(run("git", ["diff", "--name-only", base, head]).split("\n").filter(Boolean))
    : { worker: true, image: false, migrations: [...MIGRATIONS] };
  console.log(
    JSON.stringify({
      event: "deploy.plan",
      base,
      head,
      worker: todo.worker,
      image: todo.image,
      migrations: todo.migrations.map((m) => m.dir),
    }),
  );

  if (planOnly) return;

  for (const migration of todo.migrations) {
    const id = current.databases[migration.binding];
    if (!id) throw new Error(`The deployed Worker has no ${migration.binding} binding.`);
    stream(cf, ["d1", "migrations", "apply", id, "--dir", migration.dir], website);
  }
  if (todo.worker) {
    const subject = run("git", ["log", "-1", "--format=%s", head]);
    stream(
      cf,
      ["deploy", "--tag", head, "--message", subject.slice(0, 100), "--containers-rollout", "none"],
      website,
      { GITMATRIX_CI_IMAGE: current.image },
    );
    console.log(JSON.stringify({ event: "deploy.worker", head }));
  }
  if (todo.image) {
    console.error(
      "apps/website/ci/ changed, and CI can't build the CI image (no Docker in a Sandbox). " +
        "Everything else is deployed; deploy the image from a machine with Docker: " +
        "`vp run deploy` in apps/website.",
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  try {
    deploy(process.argv.includes("--plan"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
