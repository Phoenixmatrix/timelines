import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RepoDetail } from "../../apps/website/shared/api.ts";
import type { Timeline } from "../../apps/website/shared/timelines.ts";
import type { QueueGm, RepoInventory } from "./queue-e2e.ts";
import type { HarnessContext, Persona, SeedManifest } from "./types.ts";

/** A2 uses actual canonical/work providers and credentials, never alternate authorization mocks. */
export async function runSourceAuthE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  gm: QueueGm,
  record: (value: unknown) => void,
) {
  const secret = ctx.env.GITMATRIX_AGENT_SECRET;
  assert(secret, "Source authorization cleanup needs the agent secret");
  const prefix = `source-auth-${randomUUID().slice(0, 8)}`;
  const root = join(ctx.work, prefix);
  await mkdir(root, { recursive: true });
  const logPath = join(ctx.dir, "artifacts", "server.log");
  const logOffset = (await readFile(logPath)).length;
  // Assertions deliberately omit the offending text: a failing secret check must not leak it.
  const sanitized = (text: string) => {
    assert(
      !Object.values(fixtures.tokens).some((token) => text.includes(token)),
      "Credential in public output",
    );
    assert(!text.includes(secret), "Agent secret in public output");
    assert(
      !/https?:\/\/[^\s"<>/]*(?:artifacts|cloudflare)[^\s"<>/]*/i.test(text),
      "Provider remote in public output",
    );
    assert(
      !/\b(?:artifacts_remote|artifactsRemote|artifacts_name|artifactsName|upstreamToken)\b/.test(
        text,
      ),
      "Provider metadata in public output",
    );
    assert(!/\bw-[a-f0-9]{32,}\b/.test(text), "Provider name in public output");
  };
  const cli = async (args: string[], actor: Persona, cwd: string, failure?: RegExp | true) => {
    const output = await gm(args, actor, cwd, failure);
    sanitized(output);
    return output;
  };
  async function json<T>(
    path: string,
    method = "GET",
    body?: unknown,
    statuses = [200],
    credential: string | null = fixtures.tokens.sam,
  ): Promise<T> {
    const response = await fetch(`${ctx.origin}${path}`, {
      method,
      headers: {
        "X-Gitmatrix-Content-Version": "4",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(180_000),
      redirect: "error",
    });
    record({ method, path, status: response.status });
    const text = await response.text();
    if (!path.startsWith("/api/dev/")) sanitized(text);
    assert(statuses.includes(response.status), `${method} ${path}: HTTP ${response.status}`);
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
  const env: NodeJS.ProcessEnv = {
    ...ctx.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(env))
    if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key) || key === "SSH_AUTH_SOCK") delete env[key];
  const git = async (
    args: string[],
    cwd: string,
    actor: Persona | null = "sam",
    denied = false,
  ) => {
    if (denied) {
      const remote = args[1]!;
      assert.equal(new URL(remote).origin, ctx.origin);
      const service = args[0] === "push" ? "git-receive-pack" : "git-upload-pack";
      const response = await fetch(`${remote}/info/refs?service=${service}`, {
        headers: actor ? { authorization: `Bearer ${fixtures.tokens[actor]}` } : {},
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      });
      sanitized(await response.text());
      record({ nativeAdmission: service, status: response.status });
      assert(
        [401, 403, 404, 409, 410].includes(response.status),
        `Native admission returned HTTP ${response.status}, not an authorization/lifecycle denial`,
      );
    }
    return new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: 180_000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...env,
            GIT_CONFIG_COUNT: actor ? "1" : "0",
            ...(actor
              ? {
                  GIT_CONFIG_KEY_0: `http.${ctx.origin}/.extraHeader`,
                  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${fixtures.tokens[actor]}`,
                }
              : {}),
          },
        },
        (error, stdout, stderr) => {
          try {
            sanitized(stdout + stderr);
            if (denied) {
              assert(error, "Unauthorized native Git operation unexpectedly succeeded");
            } else
              assert(
                !error,
                // Checked above to hold no credential or provider remote.
                `Native Git ${args[0]} failed (${error?.code}): ${stderr.trim().slice(-2000)}`,
              );
            resolve(stdout.trim());
          } catch (failure) {
            reject(failure);
          }
        },
      );
    });
  };
  type Fixture = {
    repo: string;
    name: string;
    owner: Persona;
    id: string;
    cwd: string;
    base: string;
    deleted: boolean;
  };
  const created: Fixture[] = [];
  const sourceSlugs = new Map<string, string>();
  const url = (f: Fixture, source?: string) => {
    const slug = source ? sourceSlugs.get(source) : null;
    assert(!source || slug, "Source fixture must have a pinned timeline slug");
    return `${ctx.origin}/${f.repo}${slug ? `@${slug}` : ""}.git`;
  };
  const api = (f: Fixture) => `/api/repos/${f.repo}`;
  const tip = async (f: Fixture, source?: string, actor: Persona = "sam") => {
    const detail = await json<RepoDetail>(
      `${api(f)}${source ? `?source=${source}` : ""}`,
      "GET",
      undefined,
      [200],
      fixtures.tokens[actor],
    );
    const oid = detail.branches.find(
      (branch) => branch.shortName === (source ? "work" : "main"),
    )?.oid;
    assert(oid, "Selected source must advertise its own head");
    return oid;
  };
  const commit = async (cwd: string, filename: string, text: string, actor: Persona = "sam") => {
    await writeFile(join(cwd, filename), text);
    await git(["add", filename], cwd, actor);
    await git(
      ["-c", "core.hooksPath=/dev/null", "commit", "-m", `Auth fixture ${filename}`],
      cwd,
      actor,
    );
    return git(["rev-parse", "HEAD"], cwd, actor);
  };
  const configure = async (cwd: string) => {
    await git(["config", "user.name", "Source Auth Fixture"], cwd);
    await git(["config", "user.email", "source-auth@example.invalid"], cwd);
  };
  const make = async (visibility: "private" | "public") => {
    const name = `${prefix}-${visibility}`;
    await cli(["repo", "create", name, "--space", "sam"], "sam", root);
    const f: Fixture = {
      repo: `sam/${name}`,
      name,
      owner: "sam",
      id: "",
      cwd: join(root, visibility),
      base: "",
      deleted: false,
    };
    created.push(f);
    const summary = await json<{ id: string }>(api(f), "PATCH", { visibility });
    f.id = summary.id;
    assert(f.id);
    await mkdir(f.cwd);
    await git(["init", "--initial-branch=main"], f.cwd);
    await configure(f.cwd);
    f.base = await commit(f.cwd, "base.txt", `${visibility} canonical baseline\n`);
    await git(["push", url(f), "HEAD:main"], f.cwd);
    for (const actor of ["jun", "marco"] as const)
      await json(`${api(f)}/collaborators/${actor}`, "PUT", { role: "write" });
    return f;
  };
  const createTimeline = async (f: Fixture, suffix: string) => {
    const slug = `${prefix}-${suffix}`;
    const { timeline } = await json<{ timeline: Timeline }>(
      "/api/tracker/sam/timelines",
      "POST",
      { slug, repos: [f.repo], policy: "approval" },
      [201],
    );
    const source = timeline.repos[0]?.source;
    assert(source?.kind === "timeline-work");
    assert.equal(source.repoId, f.id);
    sourceSlugs.set(source.sourceId, slug);
    return { slug, sourceId: source.sourceId };
  };
  const purge = async (f: Fixture) => {
    if (!f.deleted) {
      await json(api(f), "DELETE", undefined, [204, 404], fixtures.tokens[f.owner]);
      f.deleted = true;
    }
    assert(f.id, "Cleanup requires a recorded canonical identity");
    await json("/api/dev/repo-purge", "POST", { repo: f.id, action: "resume" }, [200], secret);
    const deadline = Date.now() + 300_000;
    for (;;) {
      const inventory = await json<RepoInventory>(
        `/api/dev/repo-inventory?repo=${encodeURIComponent(f.id)}`,
        "GET",
        undefined,
        [200],
        secret,
      );
      if (inventory.deletion?.phase === "done") {
        assert.equal(inventory.repo, null);
        assert.deepEqual(inventory.d1, {});
        assert.equal(inventory.artifacts.exists, false);
        record({ repoId: f.id, purge: "done", canonicalProviderExists: false });
        return;
      }
      assert(Date.now() < deadline, `Auth fixture purge stalled: ${inventory.deletion?.phase}`);
      await delay(250);
    }
  };
  const failures: unknown[] = [];
  try {
    const privateRepo = await make("private");
    const publicRepo = await make("public");
    const a = await createTimeline(privateRepo, "a");
    const b = await createTimeline(privateRepo, "b");
    const publicWork = await createTimeline(publicRepo, "public");
    assert.notEqual(a.sourceId, b.sourceId);
    // Personal Tracker membership stays with sam; collaborators exercise the native endpoint.
    const checkout = join(root, "sam");
    await cli(["clone", privateRepo.repo, checkout], "sam", root);
    await configure(checkout);
    await cli(["timeline", "use", a.slug, "--space", "sam"], "sam", checkout);
    await writeFile(join(checkout, "gm-work.txt"), "only timeline A\n");
    await cli(["commit", "-m", "Auth gm source A"], "sam", checkout);
    await cli(["push"], "sam", checkout);
    const gmHead = await tip(privateRepo, a.sourceId);
    assert.notEqual(gmHead, privateRepo.base);
    assert.equal(await tip(privateRepo), privateRepo.base);
    assert.equal(await tip(privateRepo, b.sourceId), privateRepo.base);
    await cli(["push", "--queue"], "sam", checkout, /timeline_bound/);

    const native = join(root, "marco");
    await git(["clone", "--branch", "work", url(privateRepo, a.sourceId), native], root, "marco");
    await configure(native);
    assert.equal(await readFile(join(native, "gm-work.txt"), "utf8"), "only timeline A\n");
    const nativeHead = await commit(native, "native-work.txt", "native timeline A\n", "marco");
    await git(["push", "origin", "HEAD:work"], native, "jun");
    await git(["push", "origin", "HEAD:work"], native, "marco");
    assert.equal(await tip(privateRepo, a.sourceId), nativeHead);
    assert.equal(await tip(privateRepo, b.sourceId), privateRepo.base);
    assert.equal(await tip(privateRepo), privateRepo.base);
    await cli(["fetch"], "sam", checkout);
    await cli(["sync"], "sam", checkout);
    assert.equal(await readFile(join(checkout, "native-work.txt"), "utf8"), "native timeline A\n");

    const canonicalHead = await commit(
      privateRepo.cwd,
      "canonical.txt",
      "canonical independent edit\n",
    );
    await git(["push", url(privateRepo), "HEAD:main"], privateRepo.cwd);
    assert.equal(await tip(privateRepo), canonicalHead);
    assert.equal(await tip(privateRepo, a.sourceId), nativeHead);
    assert.equal(await tip(privateRepo, b.sourceId), privateRepo.base);
    await cli(["timeline", "merge", "main"], "sam", checkout);
    assert.equal(
      await readFile(join(checkout, "canonical.txt"), "utf8"),
      "canonical independent edit\n",
    );
    assert.equal(await readFile(join(checkout, "native-work.txt"), "utf8"), "native timeline A\n");
    await cli(["push"], "sam", checkout);
    const merged = await tip(privateRepo, a.sourceId);
    assert.notEqual(merged, nativeHead);
    assert.equal(await tip(privateRepo), canonicalHead);
    assert.equal(await tip(privateRepo, b.sourceId), privateRepo.base);
    await cli(["timeline", "use", b.slug, "--space", "sam"], "sam", checkout);
    assert.equal(
      await git(["rev-parse", `refs/remotes/gm-work/timeline/${b.slug}`], checkout),
      privateRepo.base,
    );
    await cli(["timeline", "use", "main", "--space", "sam"], "sam", checkout);
    // Unbound canonical checkout is independent of any work history retained locally.
    const unbound = join(root, "unbound");
    await cli(["clone", privateRepo.repo, unbound], "sam", root);
    await cli(["timeline", "use", b.slug, "--space", "sam"], "sam", unbound);
    await cli(["timeline", "use", "main", "--space", "sam"], "sam", unbound);
    await writeFile(join(unbound, "unbound.txt"), "explicit canonical selection\n");
    await cli(["commit", "-m", "Auth unbound canonical"], "jun", unbound);
    await cli(["push"], "jun", unbound);
    const unboundHead = await tip(privateRepo);
    assert.notEqual(unboundHead, canonicalHead);
    assert.equal(await tip(privateRepo, a.sourceId), merged);
    assert.equal(await tip(privateRepo, b.sourceId), privateRepo.base);
    record({
      sourceSeparation: { gmHead, nativeHead, canonicalHead, merged, unboundHead },
      useMainUnbound: true,
      boundQueueRejected: true,
    });

    // The same work id under a different authorized canonical path is not authority.
    await json(`${api(publicRepo)}?source=${a.sourceId}`, "GET", undefined, [404]);
    await git(["ls-remote", url(publicRepo, a.sourceId)], root, "sam", true);
    await git(["push", url(publicRepo, a.sourceId), "HEAD:work"], native, "sam", true);
    await json(`${api(privateRepo)}?source=${publicWork.sourceId}`, "GET", undefined, [404]);
    await json(`${api(privateRepo)}?source=${a.sourceId}`, "GET", undefined, [404], null);
    await git(["ls-remote", url(privateRepo, a.sourceId)], root, null, true);
    await json(`${api(publicRepo)}?source=${publicWork.sourceId}`, "GET", undefined, [200], null);
    assert.equal(
      await git(["ls-remote", url(publicRepo, publicWork.sourceId), "refs/heads/work"], root, null),
      `${publicRepo.base}\trefs/heads/work`,
    );
    await json(api(publicRepo), "PATCH", { visibility: "private" });
    await json(`${api(publicRepo)}?source=${publicWork.sourceId}`, "GET", undefined, [404], null);
    await git(["ls-remote", url(publicRepo, publicWork.sourceId)], root, null, true);
    await json(api(publicRepo), "PATCH", { visibility: "public" });
    await json(`${api(publicRepo)}?source=${publicWork.sourceId}`, "GET", undefined, [200], null);

    await cli(["timeline", "use", a.slug, "--space", "sam"], "sam", checkout);
    await json(`${api(privateRepo)}/collaborators/jun`, "DELETE", undefined, [204]);
    await cli(["push"], "jun", checkout, true);
    await json(
      `${api(privateRepo)}?source=${a.sourceId}`,
      "GET",
      undefined,
      [404],
      fixtures.tokens.jun,
    );
    await git(["push", url(privateRepo, a.sourceId), "HEAD:work"], native, "jun", true);
    assert.equal(await tip(privateRepo, a.sourceId), merged);
    assert.equal(await tip(privateRepo), unboundHead);
    // Retained source is readable, but even a still-authorized native writer cannot mutate it.
    await json(`/api/tracker/sam/timelines/${a.slug}/abandon`, "POST", {});
    await json(
      `${api(privateRepo)}?source=${a.sourceId}`,
      "GET",
      undefined,
      [200],
      fixtures.tokens.marco,
    );
    assert.equal(
      await git(["ls-remote", url(privateRepo, a.sourceId), "refs/heads/work"], root, "marco"),
      `${merged}\trefs/heads/work`,
    );
    await commit(native, "stale.txt", "must never reach canonical\n", "marco");
    await git(["push", url(privateRepo, a.sourceId), "HEAD:work"], native, "marco", true);
    await json(`${api(privateRepo)}/collaborators/jun`, "PUT", { role: "write" });
    await cli(["push"], "sam", checkout, /timeline_ended/);
    assert.equal(await tip(privateRepo, a.sourceId), merged);
    assert.equal(await tip(privateRepo), unboundHead);

    await cli(["timeline", "use", b.slug, "--space", "sam"], "sam", checkout);
    record({
      foreignSourceRejected: true,
      revokedCredentialRejected: true,
      archivedReadOnly: true,
      currentVisibilityEnforced: true,
    });

    await json(api(privateRepo), "DELETE", undefined, [204]);
    privateRepo.deleted = true;
    await json(`${api(privateRepo)}?source=${b.sourceId}`, "GET", undefined, [404]);
    await git(["ls-remote", url(privateRepo, b.sourceId)], root, "sam", true);
    await git(["push", url(privateRepo, b.sourceId), "HEAD:work"], native, "sam", true);
    await cli(["push"], "sam", checkout, true);
    await json(api(privateRepo), "GET", undefined, [404]);
    record({ tombstoneStaleNativeAndGmRejected: true });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const f of created) {
      try {
        await purge(f);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Source authorization and cleanup failed");
  sanitized((await readFile(logPath)).subarray(logOffset).toString("utf8"));
  record({ publicPayloadsCliNativeAndServerLogsSanitized: true });
}
