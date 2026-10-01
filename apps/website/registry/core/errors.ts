/**
 * A failure with an HTTP status and a stable code. Each format's error handler
 * renders it in that ecosystem's wire format (OCI error JSON, npm `{error}`,
 * plain text for apt...) and adds the right `WWW-Authenticate` challenge.
 */
export type ErrorCode =
  | "unauthorized"
  | "denied"
  | "not_found"
  | "name_invalid"
  | "version_invalid"
  | "digest_invalid"
  | "size_invalid"
  | "conflict"
  | "immutable"
  | "unsupported"
  | "bad_request"
  | "too_large"
  | "range_invalid"
  | "upstream_error"
  | "rate_limited"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  denied: 403,
  not_found: 404,
  name_invalid: 400,
  version_invalid: 400,
  digest_invalid: 400,
  size_invalid: 400,
  conflict: 409,
  immutable: 409,
  unsupported: 405,
  bad_request: 400,
  too_large: 413,
  range_invalid: 416,
  upstream_error: 502,
  rate_limited: 429,
  internal: 500,
};

export class RegistryError extends Error {
  readonly status: number;

  readonly code: ErrorCode;
  readonly detail?: unknown;
  constructor(code: ErrorCode, message: string, detail?: unknown, status?: number) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.name = "RegistryError";
    this.status = status ?? STATUS[code];
  }

  static unauthorized(message = "Authentication required"): RegistryError {
    return new RegistryError("unauthorized", message);
  }
  static denied(message = "Access denied"): RegistryError {
    return new RegistryError("denied", message);
  }
  static notFound(message = "Not found"): RegistryError {
    return new RegistryError("not_found", message);
  }
  static badRequest(message: string, detail?: unknown): RegistryError {
    return new RegistryError("bad_request", message, detail);
  }
  static conflict(message: string): RegistryError {
    return new RegistryError("conflict", message);
  }
}

export function asRegistryError(error: unknown): RegistryError {
  if (error instanceof RegistryError) return error;
  console.log(
    JSON.stringify({
      level: "error",
      event: "unhandled",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }),
  );
  return new RegistryError("internal", "Internal error");
}
