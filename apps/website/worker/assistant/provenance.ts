import type { ApiResult, CallApi } from "./internal.ts";

/** Server-authored receipts, never accepted from UI messages or tool output. */
export interface ContentReceipt {
  path: string;
  kind: "repository" | "tracker" | "response";
  identity: string;
  /** A stronger endpoint permission, such as repository administration. */
  permissionPath?: string;
}

export class AssistantContentUnavailable extends Error {
  constructor() {
    super(
      "This conversation contains content whose current source access cannot be verified. Its stored transcript is retained; start a new chat with currently accessible sources. A submitted write may have committed; inspect its result before retrying.",
    );
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function identity(kind: ContentReceipt["kind"], body: unknown): Promise<string> {
  const value = object(body);
  if (kind === "repository") {
    const space = object(value.space);
    const source = object(value.source);
    if (
      typeof value.id !== "string" ||
      typeof space.id !== "string" ||
      typeof source.sourceId !== "string"
    )
      throw new AssistantContentUnavailable();
    return JSON.stringify([value.id, space.id, source.sourceId]);
  }
  if (kind === "tracker") {
    if (
      value.contractVersion !== 4 ||
      typeof value.spaceId !== "string" ||
      typeof value.migrationEpoch !== "number"
    )
      throw new AssistantContentUnavailable();
    return JSON.stringify([value.spaceId, value.migrationEpoch]);
  }
  // Aggregates have no single source grant. Invalidate if their authorized
  // projection changes, rather than trusting yesterday's filtered result.
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function contentProbe(
  method: string,
  path: string,
): Pick<ContentReceipt, "kind" | "path" | "permissionPath"> | null {
  const url = new URL(path.replace(/^\/?(api\/)?/, "/"), "https://assistant.internal");
  if (/^\/(session|users|accounts)(\/|$)/.test(url.pathname)) return null;
  // Release and linked-work projections combine repository and tracker authority.
  // Neither the repository nor the Space grant alone covers their filtered inputs.
  if (
    /^\/(?:repos\/[^/]+\/[^/]+|tracker\/[^/]+)\/release-notes(?:\/|$)/.test(url.pathname) ||
    /^\/tracker\/[^/]+\/issues\/[^/]+\/work\/?$/.test(url.pathname)
  )
    return { kind: "response", path: `${url.pathname}${url.search}` };
  const repo = /^(\/repos\/[^/]+\/[^/]+)(?:\/|$)/.exec(url.pathname);
  if (repo && !url.pathname.includes("/completion-evidence")) {
    const source = url.searchParams.get("source") ?? "canonical";
    const privileged =
      /^(\/repos\/[^/]+\/[^/]+\/(?:collaborators|mirror|ci\/secrets))(?:\/|$)/.exec(url.pathname);
    return {
      kind: "repository",
      path: `${repo[1]}?authorization=1&metadata=1&source=${encodeURIComponent(source)}`,
      ...(privileged ? { permissionPath: privileged[1]! } : {}),
    };
  }
  const tracker = /^(\/tracker\/[^/]+)(?:\/|$)/.exec(url.pathname);
  if (tracker) return { kind: "tracker", path: `${tracker[1]}/authorization` };
  const packages = /^(\/packages\/[^/]+)(?:\/|$)/.exec(url.pathname);
  if (packages)
    return {
      kind: "response",
      path: method === "GET" ? `${url.pathname}${url.search}` : packages[1]!,
      ...(url.pathname.includes("/feeds") ? { permissionPath: `${packages[1]}/feeds` } : {}),
    };
  if (method === "GET") return { kind: "response", path: `${url.pathname}${url.search}` };
  // Generic writes must expose a readable authoritative resource at that path.
  return { kind: "response", path: url.pathname };
}

export async function contentReceipt(
  api: CallApi,
  probe: Pick<ContentReceipt, "kind" | "path" | "permissionPath">,
  /** The actual server GET result, not a later projection or a client payload. */
  observed?: ApiResult,
): Promise<ContentReceipt> {
  if (probe.permissionPath && !(await api("GET", probe.permissionPath)).ok)
    throw new AssistantContentUnavailable();
  const result = observed ?? (await api("GET", probe.path));
  if (!result.ok) throw new AssistantContentUnavailable();
  return { ...probe, identity: await identity(probe.kind, result.body) };
}

export async function authorizeReceipts(
  api: CallApi,
  receipts: readonly ContentReceipt[],
): Promise<void> {
  for (const receipt of receipts) {
    const current = await contentReceipt(api, receipt);
    if (current.identity !== receipt.identity) throw new AssistantContentUnavailable();
  }
}
