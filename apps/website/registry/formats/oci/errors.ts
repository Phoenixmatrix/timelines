import { isValidName } from "@gitmatrix/formats/oci";

import { services, type AppContext } from "../../core/context.ts";
import { RegistryError, type ErrorCode } from "../../core/errors.ts";
import { parseRoute } from "./paths.ts";

export type OciCode =
  | "BLOB_UNKNOWN"
  | "BLOB_UPLOAD_INVALID"
  | "BLOB_UPLOAD_UNKNOWN"
  | "DIGEST_INVALID"
  | "MANIFEST_BLOB_UNKNOWN"
  | "MANIFEST_INVALID"
  | "MANIFEST_UNKNOWN"
  | "NAME_INVALID"
  | "NAME_UNKNOWN"
  | "SIZE_INVALID"
  | "UNAUTHORIZED"
  | "DENIED"
  | "UNSUPPORTED"
  | "TOOMANYREQUESTS"
  | "UNKNOWN";

const DEFAULTS: Record<OciCode, [ErrorCode, number]> = {
  BLOB_UNKNOWN: ["not_found", 404],
  BLOB_UPLOAD_INVALID: ["bad_request", 400],
  BLOB_UPLOAD_UNKNOWN: ["not_found", 404],
  DIGEST_INVALID: ["digest_invalid", 400],
  MANIFEST_BLOB_UNKNOWN: ["bad_request", 400],
  MANIFEST_INVALID: ["bad_request", 400],
  MANIFEST_UNKNOWN: ["not_found", 404],
  NAME_INVALID: ["name_invalid", 400],
  NAME_UNKNOWN: ["not_found", 404],
  SIZE_INVALID: ["size_invalid", 400],
  UNAUTHORIZED: ["unauthorized", 401],
  DENIED: ["denied", 403],
  UNSUPPORTED: ["unsupported", 405],
  TOOMANYREQUESTS: ["rate_limited", 429],
  UNKNOWN: ["internal", 500],
};

const FROM_GENERIC: Record<ErrorCode, OciCode> = {
  unauthorized: "UNAUTHORIZED",
  denied: "DENIED",
  not_found: "NAME_UNKNOWN",
  name_invalid: "NAME_INVALID",
  version_invalid: "MANIFEST_INVALID",
  digest_invalid: "DIGEST_INVALID",
  size_invalid: "SIZE_INVALID",
  conflict: "DENIED",
  immutable: "DENIED",
  unsupported: "UNSUPPORTED",
  bad_request: "UNSUPPORTED",
  too_large: "SIZE_INVALID",
  range_invalid: "BLOB_UPLOAD_INVALID",
  upstream_error: "UNKNOWN",
  rate_limited: "TOOMANYREQUESTS",
  internal: "UNKNOWN",
};

/** A RegistryError that carries its OCI error code and any extra response headers. */
export class OciError extends RegistryError {
  readonly ociCode: OciCode;
  constructor(
    ociCode: OciCode,
    message: string,
    options: {
      status?: number;
      detail?: unknown;
      headers?: Record<string, string>;
      insufficientScope?: boolean;
    } = {},
  ) {
    const [code, status] = DEFAULTS[ociCode];
    super(code, message, options.detail, options.status ?? status);
    this.ociCode = ociCode;
    this.headers = options.headers ?? {};
    this.insufficientScope = options.insufficientScope ?? false;
  }
  readonly headers: Record<string, string>;
  readonly insufficientScope: boolean;
}

export const API_VERSION_HEADER = { "docker-distribution-api-version": "registry/2.0" };

function registryHost(baseUrl: string): string {
  return new URL(baseUrl).host;
}

/** The scope a client needs for this request, for the Bearer challenge. */
function challengeScope(c: AppContext): string | null {
  const url = new URL(c.req.url);
  const route = parseRoute(url.pathname);
  if (!route) return null;
  if (route.kind === "catalog") return "registry:catalog:*";
  if (!("name" in route) || !isValidName(route.name)) return null;
  const method = c.req.method;
  const actions =
    method === "DELETE" ? "delete" : method === "GET" || method === "HEAD" ? "pull" : "pull,push";
  const scopes = [`repository:${route.name}:${actions}`];
  const from = url.searchParams.get("from");
  if (route.kind === "uploads" && from && isValidName(from)) scopes.push(`repository:${from}:pull`);
  return scopes.join(" ");
}

export function bearerChallenge(c: AppContext, insufficientScope = false): string {
  const base = services(c).baseUrl;
  let value = `Bearer realm="${base}/v2/token",service="${registryHost(base)}"`;
  const scope = challengeScope(c);
  if (scope) value += `,scope="${scope}"`;
  if (insufficientScope) value += `,error="insufficient_scope"`;
  return value;
}

/** OCI error JSON, with a Bearer challenge on 401 so clients run the token flow. */
export function renderOciError(error: RegistryError, c: AppContext): Response {
  const oci = error instanceof OciError ? error : null;
  const code = oci?.ociCode ?? FROM_GENERIC[error.code];
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    ...API_VERSION_HEADER,
    ...oci?.headers,
  });
  const isToken = new URL(c.req.url).pathname.replace(/\/+$/, "") === "/v2/token";
  if (error.status === 401) {
    headers.set(
      "www-authenticate",
      isToken
        ? 'Basic realm="gitmatrix", charset="UTF-8"'
        : bearerChallenge(c, oci?.insufficientScope ?? false),
    );
  }
  const body = {
    errors: [
      {
        code,
        message: error.message,
        ...(error.detail !== undefined ? { detail: error.detail } : {}),
      },
    ],
  };
  return new Response(c.req.method === "HEAD" ? null : JSON.stringify(body), {
    status: error.status,
    headers,
  });
}
