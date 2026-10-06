import type { Context } from "hono";
import type { AppEnv } from "../auth.ts";
import type { RepoRow } from "../db.ts";
import { RepoReader } from "../objects.ts";
import { fail } from "../api/http.ts";
import type { FileAnalysis } from "../../shared/semantic/types.ts";
import { parseFeedQuery, semanticFeed, SemanticRequestError, type AnalysisCache } from "./feed.ts";
import { resolveSource } from "../timelines/sources.ts";

/** Per-file analyses keyed by content: they contain no actor data, so any caller may share them. */
export function semanticCache(): AnalysisCache {
  return {
    async get(key) {
      const hit = await caches.default.match(`https://semantic.gitmatrix.internal/${key}`);
      return hit ? await hit.json<FileAnalysis>() : undefined;
    },
    async put(key, value) {
      await caches.default.put(
        `https://semantic.gitmatrix.internal/${key}`,
        new Response(JSON.stringify(value), {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=31536000, immutable",
          },
        }),
      );
    },
  };
}

/** Called only after loadRepo has authorized this request. Cached values contain no actor data. */
export async function semanticResponse(c: Context<AppEnv>, row: RepoRow): Promise<Response> {
  c.header("cache-control", "private, no-store");
  c.header("vary", "Cookie, Authorization");
  const { repo, source } = await resolveSource(c.env, row, c.req.query("source"));
  const objects = new RepoReader(
    c.env,
    repo.artifacts_name,
    repo.artifacts_remote,
    c.get("timing"),
    (work) => c.executionCtx.waitUntil(work),
    source.kind === "timeline-work" ? source.ref : undefined,
  );
  try {
    const query = parseFeedQuery(c.req.query());
    const cache = semanticCache();
    return c.json(
      await semanticFeed(
        objects,
        cache,
        row.id,
        `/${encodeURIComponent(row.owner_slug)}/${encodeURIComponent(row.name)}`,
        query,
        source.sourceId,
      ),
    );
  } catch (error) {
    if (error instanceof SemanticRequestError) return fail(c, error.status, error.message);
    throw error;
  } finally {
    await objects.close();
  }
}
