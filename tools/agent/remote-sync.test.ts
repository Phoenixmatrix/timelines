import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  readlink,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";
import type { RemoteRequest, SourceFile, SyncRequest } from "./remote-protocol.ts";
import { retrieveArtifact, syncSources } from "./remote-sync.ts";

const exec = promisify(execFile);

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "remote-sync-"));
  const root = join(home, "repo");
  await mkdir(root);
  await exec("git", ["init", "--quiet", root]);
  return {
    home,
    root,
    async close() {
      await rm(home, { recursive: true, force: true });
    },
  };
}

// Stateful protocol fixture verifies the actual uploaded bytes against the manifest.
function server() {
  let revision: string | null = null;
  let manifest: SourceFile[] = [];
  let pending: SyncRequest | undefined;
  const disk = new Map<string, Buffer>();
  const staged = new Map<string, Buffer>();
  const uploads: string[] = [];
  const transactions: SyncRequest[] = [];
  let interrupt = false;
  let stale = false;
  const request: RemoteRequest = async (path, init) => {
    const url = new URL(path, "https://fixture.invalid");
    if (url.pathname === "/sync" && !init?.method)
      return Response.json({ revision, files: manifest });
    if (url.pathname === "/sync") {
      assert.ok(typeof init?.body === "string");
      const body = JSON.parse(init.body) as SyncRequest;
      if (stale) {
        stale = false;
        revision = "new-external-revision";
        return new Response(null, { status: 409 });
      }
      if (body.baseRevision !== revision) return new Response(null, { status: 409 });
      if (pending?.revision !== body.revision) staged.clear();
      pending = body;
      transactions.push(body);
      const upload = body.files
        .filter((file) => {
          const bytes = staged.get(file.path) ?? disk.get(file.path);
          return !bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256;
        })
        .map((file) => file.path);
      return Response.json({ upload });
    }
    if (url.pathname === "/files") {
      const path = url.searchParams.get("path")!;
      assert.equal(url.searchParams.get("revision"), pending?.revision);
      const expected = pending!.files.find((file) => file.path === path)!;
      const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      assert.equal(bytes.length, expected.size);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
      staged.set(path, bytes);
      uploads.push(path);
      if (interrupt) {
        interrupt = false;
        throw new Error("connection interrupted after accepted upload");
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/sync/commit") {
      assert.ok(typeof init?.body === "string");
      assert.equal(JSON.parse(init.body).revision, pending!.revision);
      for (const path of pending!.deleted) disk.delete(path);
      for (const file of pending!.files) {
        if (staged.has(file.path)) disk.set(file.path, staged.get(file.path)!);
        assert.equal(createHash("sha256").update(disk.get(file.path)!).digest("hex"), file.sha256);
      }
      manifest = pending!.files;
      revision = pending!.revision;
      pending = undefined;
      staged.clear();
      return Response.json({ revision });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return {
    request,
    disk,
    uploads,
    transactions,
    interruptNext() {
      interrupt = true;
    },
    staleNext() {
      stale = true;
    },
  };
}

await test("sync preserves local bytes and reconciles binary edits, additions, rename, deletion and executable modes", async () => {
  const f = await fixture();
  try {
    const remote = server();
    await writeFile(join(f.root, "tracked"), "original");
    await writeFile(join(f.root, "deleted"), "gone");
    await exec("git", ["-C", f.root, "add", "."]);
    const first = await syncSources(f.root, remote.request);
    assert.equal(first.files, 2);
    assert.equal(first.bytes, 12);
    assert.equal((await syncSources(f.root, remote.request)).revision, first.revision);
    assert.equal(remote.uploads.length, 2);
    await rename(join(f.root, "tracked"), join(f.root, "renamed"));
    await rm(join(f.root, "deleted"));
    const binary = Buffer.from([0, 255, 0, 13, 128]);
    await writeFile(join(f.root, "renamed"), binary);
    await chmod(join(f.root, "renamed"), 0o755);
    await writeFile(join(f.root, "added"), "new");
    const second = await syncSources(f.root, remote.request);
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(remote.disk.get("renamed"), binary);
    assert.deepEqual(await readFile(join(f.root, "renamed")), binary);
    assert.deepEqual(new Set(remote.transactions.at(-1)!.deleted), new Set(["tracked", "deleted"]));
    assert.equal(
      remote.transactions.at(-1)!.files.find((file) => file.path === "renamed")!.mode,
      0o755,
    );
    const uploaded = remote.uploads.length;
    await chmod(join(f.root, "renamed"), 0o644);
    await syncSources(f.root, remote.request);
    assert.equal(remote.uploads.length, uploaded);
    assert.equal(
      remote.transactions.at(-1)!.files.find((file) => file.path === "renamed")!.mode,
      0o644,
    );
  } finally {
    await f.close();
  }
});

await test("tracked credentials, ignored files, dependency trees and symlink parents never upload", async () => {
  const f = await fixture();
  try {
    const names = [
      ".env",
      ".env.production",
      ".dev.vars",
      "key.pem",
      "agent.local.yml",
      ".npmrc",
      ".cloudflare/auth.json",
      ".gitmatrix-agent/state.json",
      "node_modules/x",
      "target/x",
      "dist/x",
      ".gitmatrix/ci.yml",
      "safe",
      "ignored",
    ];
    for (const name of names) {
      await mkdir(join(f.root, name, ".."), { recursive: true });
      await writeFile(join(f.root, name), name);
    }
    await exec("git", ["-C", f.root, "add", "--force", "."]);
    await writeFile(join(f.root, ".gitignore"), "ignored\n");
    await writeFile(join(f.home, "secret"), "outside");
    await symlink(join(f.home, "secret"), join(f.root, "linked"));
    await mkdir(join(f.root, "parent"));
    await writeFile(join(f.root, "parent/secret"), "previous");
    await exec("git", ["-C", f.root, "add", "parent/secret"]);
    await rm(join(f.root, "parent"), { recursive: true });
    await symlink(f.home, join(f.root, "parent"));
    const remote = server();
    await syncSources(f.root, remote.request);
    assert.deepEqual([...remote.disk.keys()].sort(), [".gitignore", ".gitmatrix/ci.yml", "safe"]);
    assert.equal(await readFile(join(f.home, "secret"), "utf8"), "outside");
  } finally {
    await f.close();
  }
});

for (const tracked of [false, true]) {
  await test(`${tracked ? "tracked" : "untracked"} standard credential files stay out of snapshots and cannot be requested by the server`, async () => {
    const f = await fixture();
    try {
      const names = [
        ".git-credentials",
        ".gitconfig",
        "id_ecdsa",
        "id_dsa",
        "id_rsa",
        "id_ed25519",
        ".netrc",
        ".npmrc",
      ];
      const excluded = names.flatMap((name) => [
        name,
        `nested/${name}`,
        `uppercase/${name.toUpperCase()}`,
      ]);
      for (const path of excluded) {
        await mkdir(join(f.root, path, ".."), { recursive: true });
        await writeFile(join(f.root, path), `private credential: ${path}`);
      }
      await writeFile(join(f.root, "safe.ts"), "export const safe = true;");
      if (tracked) await exec("git", ["-C", f.root, "add", "--force", "."]);
      const remote = server();
      const result = await syncSources(f.root, remote.request);
      assert.equal(result.files, 1);
      assert.deepEqual([...remote.disk.keys()], ["safe.ts"]);
      assert.equal(remote.disk.get("safe.ts")!.toString(), "export const safe = true;");
      assert.deepEqual(
        remote.transactions.at(-1)!.files.map((file) => file.path),
        ["safe.ts"],
      );
      assert.deepEqual(remote.uploads, ["safe.ts"]);

      for (const path of excluded) {
        const requests: string[] = [];
        await assert.rejects(
          syncSources(f.root, async (endpoint, init) => {
            requests.push(endpoint);
            if (endpoint === "/sync" && init?.method === "POST")
              return Response.json({ upload: [path] });
            return remote.request(endpoint, init);
          }),
          /Invalid remote upload manifest/,
        );
        assert.deepEqual(requests, ["/sync", "/sync"]);
      }
      assert.deepEqual([...remote.disk.keys()], ["safe.ts"]);
    } finally {
      await f.close();
    }
  });
}

await test("interrupted uploads resume, changed pending snapshots recover, and stale revisions refresh", async () => {
  const f = await fixture();
  try {
    const remote = server();
    await writeFile(join(f.root, "file"), "one");
    remote.interruptNext();
    await assert.rejects(syncSources(f.root, remote.request), /interrupted/);
    await syncSources(f.root, remote.request);
    assert.equal(remote.uploads.length, 1);
    await writeFile(join(f.root, "file"), "two");
    remote.interruptNext();
    await assert.rejects(syncSources(f.root, remote.request), /interrupted/);
    await writeFile(join(f.root, "file"), "three");
    remote.staleNext();
    await syncSources(f.root, remote.request);
    assert.equal(remote.disk.get("file")!.toString(), "three");
    await rm(join(f.root, "file"));
    await syncSources(f.root, remote.request);
    assert.equal(remote.disk.size, 0);
  } finally {
    await f.close();
  }
});

for (const outcome of ["success", "http failure", "request failure"] as const) {
  await test(`upload replay restarts partial and consumed streams and releases resources on ${outcome}`, async (t) => {
    const f = await fixture();
    const toWeb = t.mock.method(Readable, "toWeb");
    try {
      const source = join(f.root, "file.bin");
      const bytes = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 251));
      await writeFile(source, bytes);
      const remote = server();
      let attempts = 0;
      const request: RemoteRequest = async (path, init, replay) => {
        if (!path.startsWith("/files?")) return remote.request(path, init);
        assert.ok(replay);
        assert.ok(init?.body instanceof ReadableStream);
        const firstStream = toWeb.mock.calls.at(-1)!.arguments[0] as Readable;
        const firstBody = init.body;
        const reader = firstBody.getReader();
        const firstChunk = await reader.read();
        assert.equal(firstChunk.done, false);
        assert.ok(firstChunk.value!.byteLength > 0);
        assert.ok(firstChunk.value!.byteLength < bytes.length);
        assert.deepEqual(
          Buffer.from(firstChunk.value!),
          bytes.subarray(0, firstChunk.value!.byteLength),
        );
        reader.releaseLock();
        attempts++;

        // Simulate the transport requesting a new attempt after an edge response.
        const second = replay();
        assert.equal(firstStream.destroyed, true);
        assert.notEqual(second.body, firstBody);
        assert.deepEqual(Buffer.from(await new Response(second.body).arrayBuffer()), bytes);
        attempts++;

        // A fully consumed stream must also restart from zero, not its old offset.
        const secondStream = toWeb.mock.calls.at(-1)!.arguments[0] as Readable;
        const third = replay();
        assert.equal(secondStream.destroyed, true);
        assert.notEqual(third.body, second.body);
        attempts++;
        if (outcome === "success") return remote.request(path, third);
        assert.ok(third.body instanceof ReadableStream);
        const finalReader = third.body.getReader();
        const finalChunk = await finalReader.read();
        assert.equal(finalChunk.done, false);
        assert.deepEqual(
          Buffer.from(finalChunk.value!),
          bytes.subarray(0, finalChunk.value!.byteLength),
        );
        finalReader.releaseLock();
        if (outcome === "http failure") return new Response(null, { status: 503 });
        throw new Error("upload request failed");
      };
      if (outcome === "success") {
        await syncSources(f.root, request);
        assert.deepEqual(remote.disk.get("file.bin"), bytes);
      } else {
        await assert.rejects(
          syncSources(f.root, request),
          outcome === "http failure"
            ? /Upload file.bin failed \(HTTP 503\)/
            : /upload request failed/,
        );
        assert.equal(remote.disk.size, 0);
      }
      assert.equal(attempts, 3);
      assert.equal(toWeb.mock.calls.length, 3);
      for (const call of toWeb.mock.calls)
        assert.equal((call.arguments[0] as Readable).destroyed, true);
      assert.deepEqual(await readFile(source), bytes);
      // File deletion does not prove closure on Unix; inspect the actual descriptors.
      if (process.platform === "linux") {
        for (const descriptor of await readdir("/proc/self/fd")) {
          const target = await readlink(`/proc/self/fd/${descriptor}`).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return undefined;
            },
          );
          assert.notEqual(target, source);
        }
      }
      if (outcome !== "success") {
        await syncSources(f.root, remote.request);
        assert.deepEqual(remote.disk.get("file.bin"), bytes);
      }
    } finally {
      toWeb.mock.restore();
      await f.close();
    }
  });
}

await test("oversized files and malicious upload paths fail before source content can leak", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "large"), "");
    await truncate(join(f.root, "large"), 64 * 1024 * 1024 + 1);
    const remote = server();
    await assert.rejects(syncSources(f.root, remote.request), /64 MiB/);
    assert.equal(remote.transactions.length, 0);
    await rm(join(f.root, "large"));
    await writeFile(join(f.root, "safe"), "safe");
    await assert.rejects(
      syncSources(f.root, async (_path, init) =>
        init?.method
          ? Response.json({ upload: ["../secret"] })
          : Response.json({ revision: null, files: [] }),
      ),
      /Invalid remote upload manifest/,
    );
  } finally {
    await f.close();
  }
});

await test("artifacts require an outside new destination; failures remove only the partial output", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0, 1, 255]);
    const request: RemoteRequest = async () => new Response(bytes);
    const path = ".gitmatrix-agent/runs/gma-example/artifacts/report.bin";
    const destination = join(f.home, "report.bin");
    await retrieveArtifact(f.root, request, path, destination);
    assert.deepEqual(await readFile(destination), bytes);
    await assert.rejects(retrieveArtifact(f.root, request, path, destination), /EEXIST/);
    assert.deepEqual(await readFile(destination), bytes);
    const link = join(f.home, "report-link.bin");
    await symlink(destination, link);
    await assert.rejects(retrieveArtifact(f.root, request, path, link), /EEXIST/);
    assert.deepEqual(await readFile(link), bytes);
    await assert.rejects(
      retrieveArtifact(f.root, request, path, join(f.root, "output")),
      /outside/,
    );
    await symlink(f.root, join(f.home, "alias"));
    await assert.rejects(
      retrieveArtifact(f.root, request, path, join(f.home, "alias/output")),
      /outside/,
    );
    for (const forbidden of [
      ".gitmatrix-agent/artifacts/../../.env",
      ".gitmatrix-agent/runs/gma-example/environment.json",
      ".gitmatrix-agent/runs/gma-example/fixtures.json",
    ]) {
      await assert.rejects(
        retrieveArtifact(f.root, request, forbidden, join(f.home, "unsafe")),
        /allowed artifact/,
      );
    }
    await assert.rejects(
      retrieveArtifact(
        f.root,
        async () => new Response(null, { status: 500 }),
        path,
        join(f.home, "failed"),
      ),
      /HTTP 500/,
    );
    await assert.rejects(readFile(join(f.home, "failed")), /ENOENT/);
    assert.deepEqual(await readFile(destination), bytes);
    const interrupted = join(f.home, "interrupted");
    let pulls = 0;
    await assert.rejects(
      retrieveArtifact(
        f.root,
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (pulls++ === 0) controller.enqueue(bytes);
                else controller.error(new Error("artifact stream interrupted"));
              },
            }),
          ),
        path,
        interrupted,
      ),
      /artifact stream interrupted/,
    );
    await assert.rejects(readFile(interrupted), /ENOENT/);
    assert.deepEqual(await readFile(destination), bytes);

    const replaced = join(f.home, "replaced");
    const moved = join(f.home, "moved-partial");
    await assert.rejects(
      retrieveArtifact(
        f.root,
        async () => {
          await rename(replaced, moved);
          await writeFile(replaced, "unrelated replacement");
          throw new Error("request interrupted after destination replacement");
        },
        path,
        replaced,
      ),
      /request interrupted/,
    );
    assert.equal(await readFile(replaced, "utf8"), "unrelated replacement");
    assert.equal(await readFile(moved, "utf8"), "");
    // Inspect the actual descriptor table, not GC or the ability to unlink an open file.
    if (process.platform === "linux") {
      const outputs = [destination, join(f.home, "failed"), interrupted, replaced, moved, f.home];
      for (const descriptor of await readdir("/proc/self/fd")) {
        const target = await readlink(`/proc/self/fd/${descriptor}`).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          },
        );
        assert.ok(!outputs.some((output) => target === output || target === `${output} (deleted)`));
      }
    }
  } finally {
    await f.close();
  }
});

await test("uploads use four bounded streams and overlapping worktree syncs serialize", async () => {
  const f = await fixture();
  try {
    const remote = server();
    for (let index = 0; index < 12; index++)
      await writeFile(join(f.root, `file-${index}`), `value-${index}`);
    let active = 0;
    let maximum = 0;
    const barrier = Promise.withResolvers<void>();
    const request: RemoteRequest = async (path, init) => {
      if (!path.startsWith("/files?")) return remote.request(path, init);
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (active === 4) barrier.resolve();
        await barrier.promise;
        return await remote.request(path, init);
      } finally {
        active--;
      }
    };
    const [first, second] = await Promise.all([
      syncSources(f.root, request),
      syncSources(f.root, request),
    ]);
    assert.equal(first.revision, second.revision);
    assert.equal(maximum, 4);
    assert.equal(remote.transactions.length, 2);
    assert.equal(remote.uploads.length, 12);
    assert.equal(remote.disk.size, 12);
  } finally {
    await f.close();
  }
});

await test("reverting to committed content clears an interrupted different snapshot", async () => {
  const f = await fixture();
  try {
    const remote = server();
    await writeFile(join(f.root, "file"), "committed");
    const original = await syncSources(f.root, remote.request);
    await writeFile(join(f.root, "file"), "interrupted");
    remote.interruptNext();
    await assert.rejects(syncSources(f.root, remote.request), /interrupted/);
    await writeFile(join(f.root, "file"), "committed");
    const reverted = await syncSources(f.root, remote.request);
    assert.equal(reverted.revision, original.revision);
    assert.equal(remote.transactions.at(-1)!.revision, original.revision);
    assert.equal(remote.disk.get("file")!.toString(), "committed");
  } finally {
    await f.close();
  }
});
