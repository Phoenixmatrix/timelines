// Test helpers for git over smart HTTP with real git: `git http-backend`
// standing in for Artifacts (behind a fetch the proxy calls), the app served
// on a local port so git can talk to it, and git run without blocking that
// server.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";
import type { AppEnv } from "../auth.ts";

export interface BackendRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentEncoding: string | null;
  body: Uint8Array;
}

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command to completion without blocking the event loop (the app answers git on it). */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Uint8Array } = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({
        status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.end(options.input ? Buffer.from(options.input) : undefined);
  });
}

/**
 * A fetch that answers `${origin}/<repo>.git/…` from the bare repositories in
 * `root` with `git http-backend`, recording each request.
 */
export function gitBackend(root: string, origin = "https://artifacts.test") {
  const requests: BackendRequest[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Node needs `duplex` for a streamed body; Workers don't.
    const request = new Request(input, { ...init, duplex: "half" } as RequestInit);
    const url = new URL(request.url);
    if (url.origin !== origin) throw new Error(`Unexpected fetch: ${request.url}`);
    const body = new Uint8Array(await request.arrayBuffer());
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      contentEncoding: request.headers.get("content-encoding"),
      body,
    });
    const result = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          // Pushes need a user; Artifacts checked the token.
          REMOTE_USER: "artifacts",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(body.length),
          ...(request.headers.get("content-encoding")
            ? { HTTP_CONTENT_ENCODING: request.headers.get("content-encoding")! }
            : {}),
          ...(request.headers.get("git-protocol")
            ? { GIT_PROTOCOL: request.headers.get("git-protocol")! }
            : {}),
        },
      });
      const out: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.on("error", reject);
      child.on("close", () => resolve(Buffer.concat(out)));
      // http-backend may answer and exit before reading the whole body; the
      // answer is on stdout, so a write to its closed stdin (EPIPE) is no error.
      // An empty body closes stdin without writing at all; other errors fail.
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.stdin.end(body.length ? Buffer.from(body) : undefined);
    });
    const split = result.indexOf("\r\n\r\n");
    const headers = new Headers();
    let status = 200;
    for (const line of result.subarray(0, split).toString("latin1").split("\r\n")) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else if (name) headers.set(name, value);
    }
    return new Response(new Uint8Array(result.subarray(split + 4)), { status, headers });
  };
  return { fetch, requests };
}

/** Serve `app` with `env` on a local port, for real git clients. */
export async function serve(app: Hono<AppEnv>, env: Env) {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(name, value);
    const response = await app.fetch(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(body),
      }),
      env,
      ctx as unknown as ExecutionContext,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
