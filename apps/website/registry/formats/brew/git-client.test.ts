import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeHarness, type Harness } from "../../testing/harness.ts";

/**
 * Drives the real `git` client against the registry app served on a local
 * port: clone, incremental fetch, shallow clone, credentials and push refusal,
 * over protocol v2 (brew.test.ts answers v0 requests).
 */

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitmatrix-brew-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function serve(h: Harness): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      }
      const method = req.method ?? "GET";
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      const response = await h.app.fetch(request, h.env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
        }
      }
      res.end();
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe.skipIf(!hasGit())("brew taps with the real git client", () => {
  let h: Harness;
  let server: Server;
  let base: string;
  let writer: string;
  let home: string;

  const env = () => ({
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    LANG: "C",
  });

  const git = (args: string[], cwd?: string, extraEnv: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const options = { cwd, env: { ...env(), ...extraEnv }, timeout: 30_000 };
      execFile("git", args, options, (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
      });
    });

  const ok = async (args: string[], cwd?: string) => {
    const result = await git(args, cwd);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
    return result.stdout;
  };

  const publish = async (name: string, version: string) => {
    const cls = name.charAt(0).toUpperCase() + name.slice(1);
    const res = await h.request(`/api/v1/brew/tap/Formula/${name}.rb`, {
      method: "PUT",
      headers: { authorization: `Bearer ${writer}` },
      body: `class ${cls} < Formula\n  desc "${name}"\n  url "https://example.com/${name}-${version}.tar.gz"\n  sha256 "${"a".repeat(64)}"\nend\n`,
    });
    expect(res.status).toBe(201);
  };

  const url = (auth = true) =>
    `${base.replace("http://", auth ? `http://token:${writer}@` : "http://")}/brew/tap/homebrew-tools.git`;

  beforeEach(async () => {
    h = await makeHarness();
    await h.createRepo({
      key: "tap",
      format: "brew",
      kind: "local",
      visibility: "private",
      config: { tapName: "tools" },
    });
    writer = h.token("bob");
    await h.request("/api/v1/repositories/tap/permissions", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await h.adminToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ principal: "user:bob", role: "write" }),
    });
    server = await serve(h);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    home = tempDir();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("clones and fetches over protocol v2", { timeout: 60_000 }, async () => {
    await publish("foo", "1.0.0");
    const dir = join(tempDir(), "homebrew-tools");
    await ok(["-c", "protocol.version=2", "clone", url(), dir]);
    expect(readFileSync(join(dir, "Formula/foo.rb"), "utf8")).toContain("foo-1.0.0.tar.gz");
    expect(readFileSync(join(dir, "lib/gitmatrix_download_strategy.rb"), "utf8")).toContain(
      "class GitmatrixDownloadStrategy < CurlDownloadStrategy",
    );
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("brew tap gitmatrix/tools");
    expect((await ok(["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim()).toBe("main");
    await ok(["fsck", "--strict", "--no-dangling"], dir);

    await publish("bar", "2.0.0");
    await publish("foo", "1.1.0");
    const traced = await git(["-c", "protocol.version=2", "fetch", "origin"], dir, {
      GIT_TRACE_PACKET: "1",
    });
    expect(traced.code).toBe(0);
    // The right protocol was spoken, and the client's HEAD was recognised as common.
    expect(traced.stderr).toContain("version 2");
    expect(traced.stderr).toMatch(/(fetch|fetch-pack)< ACK [0-9a-f]{40}/);
    await ok(["merge", "--ff-only", "origin/main"], dir);
    expect(readFileSync(join(dir, "Formula/foo.rb"), "utf8")).toContain("foo-1.1.0.tar.gz");
    expect(existsSync(join(dir, "Formula/bar.rb"))).toBe(true);
    const log = (await ok(["log", "--format=%s|%an <%ae>"], dir)).trim().split("\n");
    expect(log).toEqual([
      "Update foo 1.1.0|gitmatrix <noreply@gitmatrix.dev>",
      "Add bar 2.0.0|gitmatrix <noreply@gitmatrix.dev>",
      "Add foo 1.0.0|gitmatrix <noreply@gitmatrix.dev>",
    ]);
    await ok(["fsck", "--strict", "--no-dangling"], dir);

    // Nothing new: fetch is a no-op.
    await ok(["-c", "protocol.version=2", "fetch", "origin"], dir);
    const remote = await ok(["-c", "protocol.version=2", "ls-remote", url()]);
    expect(remote).toMatch(/^[0-9a-f]{40}\tHEAD\n[0-9a-f]{40}\trefs\/heads\/main\n$/);
  });

  it("shallow-clones and unshallows over protocol v2", { timeout: 60_000 }, async () => {
    await publish("foo", "1.0.0");
    await publish("foo", "1.1.0");
    await publish("bar", "1.0.0");
    const dir = join(tempDir(), "shallow");
    await ok(["-c", "protocol.version=2", "clone", "--depth", "1", url(), dir]);
    expect((await ok(["rev-list", "--count", "HEAD"], dir)).trim()).toBe("1");
    expect(existsSync(join(dir, "Formula/bar.rb"))).toBe(true);
    await ok(["-c", "protocol.version=2", "fetch", "--unshallow", "origin"], dir);
    expect((await ok(["rev-list", "--count", "HEAD"], dir)).trim()).toBe("3");
    await ok(["fsck", "--strict", "--no-dangling"], dir);
  });

  it("clones public taps anonymously, with or without .git", { timeout: 60_000 }, async () => {
    await h.createRepo({ key: "pub", format: "brew", kind: "local", visibility: "public" });
    const dir = join(tempDir(), "pub");
    await ok(["clone", `${base}/brew/pub/homebrew-pub`, dir]);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect((await ok(["log", "--format=%s"], dir)).trim()).toBe("Regenerate tap files");
  });

  it("needs credentials for private taps and refuses pushes", { timeout: 60_000 }, async () => {
    await publish("foo", "1.0.0");
    const anonymous = await git(["clone", url(false), join(tempDir(), "anon")]);
    expect(anonymous.code).not.toBe(0);
    expect(anonymous.stderr).toMatch(
      /Authentication failed|could not read Username|terminal prompts disabled/,
    );

    const dir = join(tempDir(), "push");
    await ok(["clone", url(), dir]);
    await ok(
      ["-c", "user.name=x", "-c", "user.email=x@example.com", "commit", "--allow-empty", "-m", "x"],
      dir,
    );
    const push = await git(["push", "origin", "main"], dir);
    expect(push.code).not.toBe(0);
    expect(push.stderr).toContain("read-only");
  });
});
