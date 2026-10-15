import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { ConflictFile, QueueResolution } from "../../shared/merge-queue.ts";
import type { AppEnv } from "../auth.ts";
import { gitBackend, run, serve } from "../testing/git-http.ts";
import { QUEUE_MERGE_SCRIPT, QUEUE_RESOLVE_TIMEOUT_MS, queueMergeScript } from "./queue-script.ts";

const identity = {
  GIT_AUTHOR_NAME: "Queue test",
  GIT_AUTHOR_EMAIL: "queue@test.invalid",
  GIT_COMMITTER_NAME: "Queue test",
  GIT_COMMITTER_EMAIL: "queue@test.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...identity },
  }).trim();
}
function approved(files: ConflictFile[]): QueueResolution {
  return {
    decision: {
      action: "repair",
      reason: "Independent prose additions",
      model: "classification-test",
      confidence: 0.95,
    },
    repairModel: "repair-test",
    files: files.map((f) => ({ path: f.path, content: f.ours + f.theirs.slice(f.base.length) })),
  };
}

// Each case builds real Git histories and runs a shell/Node client over HTTP.
// Allow contention in full-suite runs without changing the request deadlines
// exercised below.
describe("trusted queue merge program", { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function setup(
    options: {
      mode?: "clean" | "ancestor" | "conflict" | "symlink" | "executable" | "binary" | "deletion";
      path?: string;
      resolve?: (files: ConflictFile[]) => Response | Promise<Response>;
      hostileTools?: boolean;
      script?: string;
    } = {},
  ) {
    const mode = options.mode ?? "conflict",
      path = options.path ?? "docs/notes.md";
    const root = mkdtempSync(join(tmpdir(), "queue-merge-"));
    dirs.push(root);
    const remote = join(root, "app.git"),
      work = join(root, "work"),
      checkout = join(root, "ci");
    git(root, "init", "--quiet", "--bare", "-b", "main", remote);
    git(root, "clone", "--quiet", remote, work);
    mkdirSync(dirname(join(work, path)), { recursive: true });
    if (mode === "symlink") symlinkSync("original", join(work, path));
    else writeFileSync(join(work, path), "Notes.\n");
    git(work, "add", ".");
    if (mode === "executable") git(work, "update-index", "--chmod=+x", path);
    git(work, "commit", "--quiet", "-m", "start");
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    git(work, "checkout", "--quiet", "-b", "submission");
    if (mode === "symlink") {
      rmSync(join(work, path));
      symlinkSync("submitted", join(work, path));
    } else if (mode === "deletion") rmSync(join(work, path));
    else
      writeFileSync(
        join(work, path),
        "Notes.\nSubmitted addition.\n" + (mode === "binary" ? "\0" : ""),
      );
    if (options.hostileTools) {
      mkdirSync(join(work, "node_modules/.bin"), { recursive: true });
      for (const tool of ["node", "git"]) {
        writeFileSync(
          join(work, "node_modules/.bin", tool),
          `#!/bin/sh\nprintf compromised > '${join(root, tool + "-ran")}'\nexit 97\n`,
          { mode: 0o755 },
        );
      }
    }
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "submitted");
    const source = git(work, "rev-parse", "HEAD");
    const branch = "gitmatrix/landing/queue-" + source + "-1";
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/" + branch);
    git(work, "checkout", "--quiet", "main");
    if (mode === "ancestor") git(work, "merge", "--ff-only", source);
    if (mode === "clean" || mode === "ancestor")
      writeFileSync(join(work, "other"), "Main addition.\n");
    else if (mode === "symlink") {
      rmSync(join(work, path));
      symlinkSync("main-side", join(work, path));
    } else
      writeFileSync(join(work, path), "Notes.\nMain addition.\n" + (mode === "binary" ? "\0" : ""));
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "main advanced");
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const base = git(work, "rev-parse", "HEAD");
    git(
      root,
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      branch,
      "file://" + remote,
      checkout,
    );
    const requests: { authorization: string | undefined; files: ConflictFile[]; path: string }[] =
      [];
    const backend = gitBackend(root);
    const app = new Hono<AppEnv>();
    app.post("/api/repos/orbit/app/queue/:id/resolve", async (c) => {
      const { files } = await c.req.json<{ files: ConflictFile[] }>();
      requests.push({ authorization: c.req.header("authorization"), files, path: c.req.path });
      return options.resolve?.(files) ?? Response.json({ resolution: approved(files) });
    });
    app.all("/orbit/app.git/*", (c) => {
      const url = new URL(c.req.url);
      url.hostname = "artifacts.test";
      url.protocol = "https:";
      url.port = "";
      url.pathname = url.pathname.replace("/orbit/app.git/", "/app.git/");
      return backend.fetch(new Request(url, c.req.raw));
    });
    const server = await serve(app, {} as Env);
    closers.push(server.close);
    const step = () =>
      run("/bin/bash", ["-eo", "pipefail", "-c", options.script ?? QUEUE_MERGE_SCRIPT], {
        cwd: checkout,
        env: {
          ...process.env,
          ...identity,
          GITMATRIX_TOKEN: "gmj_queue_test",
          GITMATRIX_URL: server.url,
          PATH:
            join(checkout, "node_modules/.bin") +
            ":/usr/local/pnpm/bin:/usr/local/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          GITMATRIX_REPOSITORY: "orbit/app",
          GITMATRIX_COMMIT: source,
          GITMATRIX_QUEUE_ID: source,
          GITMATRIX_QUEUE_ATTEMPT: "1",
          GITMATRIX_LANDING_BRANCH: branch,
          GITMATRIX_LANDING_MAIN: "main",
          GITMATRIX_LANDING_BASE: base,
          GITMATRIX_LANDING_NAME: "Gitmatrix",
          GITMATRIX_LANDING_EMAIL: "queue@gitmatrix.invalid",
          GITMATRIX_LANDING_MESSAGE: "Merge queued submission",
        },
      });
    const unchanged = () => {
      expect(git(remote, "rev-parse", "refs/heads/main")).toBe(base);
      expect(git(remote, "rev-parse", "refs/heads/" + branch)).toBe(source);
      expect(
        backend.requests.filter((r) => new URL(r.url).pathname.endsWith("/git-receive-pack")),
      ).toEqual([]);
    };
    return { root, remote, base, source, branch, step, requests, unchanged, backend };
  }

  test.each(["clean", "ancestor"] as const)(
    "creates exactly ordered parents for %s source without moving main",
    async (mode) => {
      const t = await setup({ mode });
      const result = await t.step();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const candidate = git(t.remote, "rev-parse", "refs/heads/" + t.branch);
      expect(git(t.remote, "show", "-s", "--format=%P", candidate)).toBe(t.base + " " + t.source);
      expect(git(t.remote, "show", candidate + ":docs/notes.md")).toBe(
        "Notes.\nSubmitted addition.",
      );
      expect(git(t.remote, "show", candidate + ":other")).toBe("Main addition.");
      expect(git(t.remote, "rev-parse", "refs/heads/main")).toBe(t.base);
      expect(t.requests).toEqual([]);
      expect(t.backend.requests.every((r) => r.authorization === "Bearer gmj_queue_test")).toBe(
        true,
      );
    },
  );

  test("never executes tracked Node or Git lookalikes from the production repository PATH", async () => {
    const t = await setup({ mode: "clean", hostileTools: true });
    for (const tool of ["node", "git"]) {
      expect(git(t.remote, "ls-tree", t.source, "node_modules/.bin/" + tool)).toMatch(
        /^100755 blob /,
      );
    }
    const result = await t.step();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    for (const tool of ["node", "git"]) expect(existsSync(join(t.root, tool + "-ran"))).toBe(false);
    const candidate = git(t.remote, "rev-parse", "refs/heads/" + t.branch);
    expect(git(t.remote, "show", "-s", "--format=%P", candidate)).toBe(t.base + " " + t.source);
    expect(git(t.remote, "show", candidate + ":docs/notes.md")).toBe("Notes.\nSubmitted addition.");
    expect(git(t.remote, "show", candidate + ":other")).toBe("Main addition.");
    expect(git(t.remote, "rev-parse", "refs/heads/main")).toBe(t.base);
  });

  test("allows sequential resolution stages beyond the former request deadline", async () => {
    // Real HTTP crosses a child Node process's AbortSignal, whose clock cannot
    // be driven by parent fake timers. Scale budgets by 200: 50s classification
    // + 90s repair each fit 65s/125s but exceed the former 120s HTTP budget.
    const t = await setup({
      script: queueMergeScript(QUEUE_RESOLVE_TIMEOUT_MS / 200),
      resolve: async (files) => {
        await delay(250);
        await delay(450);
        return Response.json({ resolution: approved(files) });
      },
    });
    const result = await t.step();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(t.requests).toHaveLength(1);
    const candidate = git(t.remote, "rev-parse", "refs/heads/" + t.branch);
    expect(git(t.remote, "show", candidate + ":docs/notes.md")).toBe(
      "Notes.\nMain addition.\nSubmitted addition.",
    );
    expect(git(t.remote, "show", "-s", "--format=%P", candidate)).toBe(t.base + " " + t.source);
  });

  test("fails closed without replaying a paid resolution after its end-to-end deadline", async () => {
    // The deadline starts at the request, after Node has started and merged
    // (CORE-257); the answer is held past it.
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const t = await setup({
      script: queueMergeScript(1_500),
      resolve: async (files) => {
        requested.resolve();
        await release.promise;
        return Response.json({ resolution: approved(files) });
      },
    });
    const step = t.step();
    try {
      await Promise.race([
        requested.promise,
        step.then(() => {
          throw new Error("The client exited before the resolution request reached its server");
        }),
      ]);
      const result = await step;
      expect(result.status).toBe(1);
      expect(t.requests).toHaveLength(1);
      t.unchanged();
    } finally {
      release.resolve();
    }
  });

  test("sends actual three Git stages and applies only the approved lossless repair", async () => {
    const t = await setup();
    const result = await t.step();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(t.requests).toEqual([
      {
        authorization: "Bearer gmj_queue_test",
        path: "/api/repos/orbit/app/queue/" + t.source + "/resolve",
        files: [
          {
            path: "docs/notes.md",
            base: "Notes.\n",
            ours: "Notes.\nMain addition.\n",
            theirs: "Notes.\nSubmitted addition.\n",
          },
        ],
      },
    ]);
    const candidate = git(t.remote, "rev-parse", "refs/heads/" + t.branch);
    expect(git(t.remote, "show", candidate + ":docs/notes.md")).toBe(
      "Notes.\nMain addition.\nSubmitted addition.",
    );
    expect(git(t.remote, "show", "-s", "--format=%P", candidate)).toBe(t.base + " " + t.source);
    expect(git(t.remote, "rev-parse", "refs/heads/main")).toBe(t.base);
  });

  test.each(["symlink", "executable", "binary", "deletion"] as const)(
    "rejects %s conflicts before contacting a model",
    async (mode) => {
      const t = await setup({ mode });
      const result = await t.step();
      expect(result.status).toBe(42);
      expect(result.stderr).toContain('QUEUE_CONFLICT_PATHS ["docs/notes.md"]');
      expect(t.requests).toEqual([]);
      t.unchanged();
    },
  );
  test.each(["src/main.ts", "docs/AGENTS.md"])("rejects unsafe path %s", async (path) => {
    const t = await setup({ path });
    const result = await t.step();
    expect(result.status).toBe(42);
    expect(result.stderr).toContain("QUEUE_CONFLICT_PATHS " + JSON.stringify([path]));
    expect(t.requests).toEqual([]);
    t.unchanged();
  });
  test.each([
    "low-confidence",
    "invented-command",
    "unexpected-path",
    "http-failure",
    "model-failure",
  ])("rejects %s without any remote write", async (failure) => {
    const t = await setup({
      resolve: (files) => {
        if (failure === "http-failure") return new Response("Unavailable", { status: 503 });
        if (failure === "model-failure") return Response.json({ error: "Model unavailable" });
        const resolution = approved(files);
        if (failure === "low-confidence") resolution.decision.confidence = 0.9499;
        if (failure === "invented-command") resolution.files[0]!.content += "$(touch escaped)\n";
        if (failure === "unexpected-path") resolution.files[0]!.path = "../escaped";
        return Response.json({ resolution });
      },
    });
    const result = await t.step();
    expect(result.status).toBe(failure === "http-failure" || failure === "model-failure" ? 1 : 42);
    expect(result.stderr).toContain('QUEUE_CONFLICT_PATHS ["docs/notes.md"]');
    expect(t.requests).toHaveLength(1);
    t.unchanged();
  });
});
