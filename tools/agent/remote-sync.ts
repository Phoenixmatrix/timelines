import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, type ReadStream, type Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { RemoteRequest, SourceFile, SourceManifest } from "./remote-protocol.ts";

const exec = promisify(execFile);
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_FILES = 100_000;
const locks = new Map<string, Promise<unknown>>();

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function safePath(path: string): boolean {
  if (
    !path ||
    path.length > 4096 ||
    path.includes("\\") ||
    hasControlCharacters(path) ||
    isAbsolute(path)
  )
    return false;
  return path.split("/").every((part) => {
    const name = part.toLowerCase();
    return (
      part !== "" &&
      part !== "." &&
      part !== ".." &&
      ![
        ".git",
        ".gitmatrix-agent",
        "node_modules",
        "target",
        "dist",
        ".cloudflare",
        ".wrangler",
        ".remote",
        ".ssh",
        ".aws",
        ".config",
        ".npmrc",
        ".netrc",
        ".git-credentials",
        ".gitconfig",
        "agent.local.yml",
        "secrets",
        "secrets.json",
        "auth.json",
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
        "id_dsa",
      ].includes(name) &&
      !name.startsWith(".env") &&
      !name.startsWith(".dev.vars") &&
      !/^credentials(?:\..*)?$/.test(name) &&
      !/\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name)
    );
  });
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function sourceHandle(root: string, path: string) {
  if (!safePath(path)) throw new Error(`Unsafe source path: ${path}`);
  let current = root;
  for (const part of path.split("/")) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Source symlink: ${path}`);
  }
  const handle = await open(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    // Check the opened inode, not merely a path that could have changed during open.
    const actual = await realpath(
      process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : current,
    );
    if (!stat.isFile() || actual !== current || !within(root, actual))
      throw new Error(`Not a regular source file: ${path}`);
    if (stat.size > MAX_FILE) throw new Error(`Source file exceeds 64 MiB: ${path}`);
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function discover(root: string): Promise<SourceFile[]> {
  const [listed, excluded] = await Promise.all(
    [
      ["--cached", "--others", "--exclude-standard"],
      ["--cached", "--ignored", "--exclude-standard"],
    ].map((args) =>
      exec("git", ["-C", root, "ls-files", ...args, "-z"], { maxBuffer: 32 * 1024 * 1024 }),
    ),
  );
  const paths = listed!.stdout.split("\0").filter(Boolean);
  const ignoredPaths = excluded!.stdout.split("\0").filter(Boolean);
  const ignored = new Set(ignoredPaths);
  const selected = [...new Set(paths)]
    .filter((path) => safePath(path) && !ignored.has(path))
    .sort();
  if (selected.length > MAX_FILES) throw new Error("Source manifest exceeds 100000 files");
  const files: SourceFile[] = [];
  let total = 0;
  for (const path of selected) {
    // Git may list missing tracked files, symlinks, and submodule directories.
    let current = root;
    let regular = true;
    for (const part of path.split("/")) {
      current = resolve(current, part);
      try {
        const stat = await lstat(current);
        if (
          stat.isSymbolicLink() ||
          (current === resolve(root, path) ? !stat.isFile() : !stat.isDirectory())
        ) {
          regular = false;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        regular = false;
        break;
      }
    }
    if (!regular) continue;
    const { handle, stat } = await sourceHandle(root, path);
    try {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > MAX_FILE) throw new Error(`Source file exceeds 64 MiB: ${path}`);
        hash.update(chunk);
      }
      const after = await handle.stat();
      if (size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
        throw new Error(`Source changed during hashing; sync again: ${path}`);
      total += size;
      if (total > MAX_TOTAL) throw new Error("Source snapshot exceeds 1 GiB");
      files.push({
        path,
        sha256: hash.digest("hex"),
        size,
        mode: stat.mode & 0o111 ? 0o755 : 0o644,
      });
    } finally {
      await handle.close();
    }
  }
  return files;
}

async function checked(response: Response, operation: string): Promise<Response> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${operation} failed (HTTP ${response.status})`);
  }
  return response;
}

async function synchronize(root: string, request: RemoteRequest) {
  const files = await discover(root);
  const revision = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const result = {
    revision,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = (await (
      await checked(await request("/sync"), "Read source manifest")
    ).json()) as SourceManifest;
    if (
      !Array.isArray(state.files) ||
      state.files.length > MAX_FILES ||
      (state.revision !== null && typeof state.revision !== "string")
    )
      throw new Error("Invalid remote source manifest");
    // Even the committed revision must reconcile a possibly interrupted different snapshot.
    const deleted = state.files.map((file) => file.path).filter((path) => !byPath.has(path));
    if (deleted.some((path) => !safePath(path))) throw new Error("Unsafe remote source manifest");
    const start = await request("/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: state.revision, revision, files, deleted }),
    });
    if (start.status === 409) {
      await start.body?.cancel();
      continue;
    }
    const { upload } = (await (await checked(start, "Begin source sync")).json()) as {
      upload: string[];
    };
    if (
      !Array.isArray(upload) ||
      upload.length > files.length ||
      new Set(upload).size !== upload.length ||
      upload.some((path) => !byPath.has(path))
    )
      throw new Error("Invalid remote upload manifest");
    let next = 0;
    let failure: unknown;
    await Promise.all(
      Array.from({ length: Math.min(4, upload.length) }, async () => {
        while (failure === undefined) {
          const path = upload[next++];
          if (path === undefined) return;
          try {
            const expected = byPath.get(path)!;
            const { handle, stat } = await sourceHandle(root, path);
            let stream: ReadStream | undefined;
            try {
              if (
                stat.size !== expected.size ||
                (stat.mode & 0o111 ? 0o755 : 0o644) !== expected.mode
              )
                throw new Error(`Source changed before upload; sync again: ${path}`);
              const replay = (): RequestInit => {
                stream?.destroy();
                // destroy() closes even an autoClose:false FileHandle stream. The
                // adapter leaves handle ownership here, including in-flight reads.
                stream = createReadStream("", {
                  fd: handle.fd,
                  autoClose: false,
                  start: 0,
                  end: MAX_FILE,
                  fs: {
                    read(_fd, buffer, offset, length, position, callback) {
                      void handle.read(buffer, offset, length, position).then(
                        ({ bytesRead }) => callback(null, bytesRead, buffer),
                        (error: NodeJS.ErrnoException) => callback(error, 0, buffer),
                      );
                    },
                    close(_fd, callback) {
                      callback(null);
                    },
                  },
                });
                const init: RequestInit & { duplex: "half" } = {
                  method: "PUT",
                  body: Readable.toWeb(stream, {
                    strategy: {
                      highWaterMark: stream.readableHighWaterMark,
                      size: (chunk: Uint8Array) => chunk.byteLength,
                    },
                  }) as ReadableStream<Uint8Array>,
                  duplex: "half",
                  headers: { "content-type": "application/octet-stream" },
                };
                return init;
              };
              const response = await checked(
                await request(
                  `/files?path=${encodeURIComponent(path)}&revision=${revision}`,
                  replay(),
                  replay,
                ),
                `Upload ${path}`,
              );
              await response.body?.cancel();
            } finally {
              stream?.destroy();
              await handle.close();
            }
          } catch (error) {
            failure = error;
          }
        }
      }),
    );
    if (failure !== undefined) throw failure;
    const committed = (await (
      await checked(
        await request("/sync/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision }),
        }),
        "Commit source sync",
      )
    ).json()) as { revision: string };
    if (committed.revision !== revision)
      throw new Error("Remote committed an unexpected source revision");
    return result;
  }
  throw new Error("Remote source revision changed repeatedly; sync again");
}

/** Upload only; the authoritative local worktree is never modified. */
export async function syncSources(
  root: string,
  request: RemoteRequest,
): Promise<{ revision: string; files: number; bytes: number }> {
  const canonical = await realpath(root);
  const previous = locks.get(canonical) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => synchronize(canonical, request));
  locks.set(canonical, current);
  try {
    return await current;
  } finally {
    if (locks.get(canonical) === current) locks.delete(canonical);
  }
}

/** Download generated output only to an explicit, new file outside the source tree. */
export async function retrieveArtifact(
  root: string,
  request: RemoteRequest,
  remotePath: string,
  destination: string,
): Promise<void> {
  if (
    !destination ||
    !remotePath ||
    remotePath.includes("\\") ||
    hasControlCharacters(remotePath) ||
    remotePath.split("/").some((part) => !part || part === "." || part === "..") ||
    !(
      remotePath.startsWith(".gitmatrix-agent/artifacts/") ||
      /^\.gitmatrix-agent\/runs\/[^/]+\/artifacts\//.test(remotePath) ||
      remotePath === "apps/cli/target/debug/gm"
    )
  )
    throw new Error("An allowed artifact path and explicit destination are required");
  const canonical = await realpath(root);
  const target = resolve(destination);
  const parent = await realpath(dirname(target));
  if (within(canonical, target) || within(canonical, parent))
    throw new Error("Artifact destination must be outside the authoritative source tree");
  const directory = await open(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const anchored = process.platform === "linux" ? `/proc/self/fd/${directory.fd}` : parent;
    const actualParent = await realpath(anchored);
    if (actualParent !== parent || within(canonical, actualParent))
      throw new Error("Artifact destination changed during retrieval");
    const output = resolve(anchored, relative(dirname(target), target));
    const handle = await open(
      output,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let owned: Stats | undefined;
    try {
      owned = await handle.stat();
      const response = await checked(
        await request(`/artifacts?path=${encodeURIComponent(remotePath)}`),
        "Retrieve artifact",
      );
      if (!response.body) throw new Error("Artifact response has no body");
      let bytes = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > MAX_TOTAL ? new Error("Artifact exceeds 1 GiB") : null, chunk);
        },
      });
      // Pipeline waits for close; let the stream release its FileHandle reference
      // rather than waiting on a manual close while that reference is still live.
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
        limit,
        handle.createWriteStream({ autoClose: true }),
      );
    } catch (error) {
      const current = await lstat(output).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
        return undefined;
      });
      if (owned && current?.dev === owned.dev && current.ino === owned.ino) await unlink(output);
      throw error;
    } finally {
      await handle.close();
    }
  } finally {
    await directory.close();
  }
}
