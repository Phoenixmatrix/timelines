import type { FormatId } from "@gitmatrix/formats/info";

import type { AppContext } from "./context.ts";
import { services } from "./context.ts";
import { RegistryError } from "./errors.ts";
import { resolveFeed, type Repository } from "./repos.ts";

/** Loads `:repo` for a format's routes and checks it is that format. */
export async function loadRepo(
  c: AppContext,
  format: FormatId,
  key = c.req.param("repo"),
): Promise<Repository> {
  if (!key) throw RegistryError.notFound("Repository not found");
  const repo = await resolveFeed(services(c), format, key);
  if (!repo) throw RegistryError.notFound(`No ${format} registry ${key}`);
  c.set("repo", repo);
  return repo;
}

export function basicChallenge(): Record<string, string> {
  return { "www-authenticate": 'Basic realm="gitmatrix", charset="UTF-8"' };
}

/** Plain-text error with a Basic challenge on 401: what apt, dnf, maven and pip expect. */
export function textError(error: RegistryError): Response {
  return new Response(`${error.message}\n`, {
    status: error.status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(error.status === 401 ? basicChallenge() : {}),
    },
  });
}

export function jsonError(error: RegistryError, body?: unknown): Response {
  return Response.json(body ?? { error: error.message, code: error.code }, {
    status: error.status,
    headers: error.status === 401 ? basicChallenge() : {},
  });
}

/** Normalizes a wildcard route remainder and refuses traversal tricks. */
export function safePath(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw RegistryError.badRequest("Malformed path");
  }
  const parts = decoded.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || p.includes("\\") || p.includes("\0"))) {
    throw RegistryError.badRequest("Invalid path");
  }
  return parts.join("/");
}

/**
 * The URL path after the first `skip` segments, raw (still percent-encoded).
 * `/generic/<repo>/a/b.txt` with skip 2 is `a/b.txt`; a trailing slash is kept.
 */
export function restPath(c: AppContext, skip: number): string {
  const segments = new URL(c.req.url).pathname.split("/");
  return segments.slice(skip + 1).join("/");
}
