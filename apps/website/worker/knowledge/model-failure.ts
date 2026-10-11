// Safe, retained evidence for failed model attempts (CORE-347). No error bodies cross this boundary.
const NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "PaidWorkStopped",
  "InferenceUpstreamError",
  "AiInternalError",
] as const;
const KINDS = [
  "deadline",
  "work_expired",
  "work_stopped",
  "rate_limit",
  "provider_error",
  "binding_internal",
  "unknown",
] as const;
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const modelIdentifier = /^@?[a-zA-Z0-9][a-zA-Z0-9/_.:-]{0,255}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ModelFailureDiagnostic {
  event: "ai.model.failed";
  at: string;
  attempt: string;
  provider: "workers-ai" | "typesafe" | "openrouter";
  model: string;
  account: string;
  feature: string;
  dispatched: boolean;
  kind: (typeof KINDS)[number];
  code: number | null;
  status: number | null;
  name: (typeof NAMES)[number] | null;
}

function integer(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function safeModel(value: unknown): value is string {
  return typeof value === "string" && modelIdentifier.test(value) && !value.includes("://");
}

/** Validate and project only the safe schema, including when reading retained untrusted logs. */
export function parseModelFailureDiagnostic(value: unknown): ModelFailureDiagnostic | null {
  try {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (
      v.event !== "ai.model.failed" ||
      typeof v.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.at) ||
      !Number.isFinite(Date.parse(v.at)) ||
      new Date(v.at).toISOString() !== v.at ||
      typeof v.attempt !== "string" ||
      !uuid.test(v.attempt) ||
      (v.provider !== "workers-ai" && v.provider !== "typesafe" && v.provider !== "openrouter") ||
      !safeModel(v.model) ||
      typeof v.account !== "string" ||
      (v.account !== "" && !identifier.test(v.account)) ||
      typeof v.feature !== "string" ||
      !identifier.test(v.feature) ||
      typeof v.dispatched !== "boolean" ||
      !KINDS.includes(v.kind as ModelFailureDiagnostic["kind"]) ||
      (v.code !== null && integer(v.code, 0, 999999) === null) ||
      (v.status !== null && integer(v.status, 100, 599) === null) ||
      (v.name !== null && !NAMES.includes(v.name as NonNullable<ModelFailureDiagnostic["name"]>))
    )
      return null;
    return {
      event: "ai.model.failed",
      at: v.at,
      attempt: v.attempt,
      provider: v.provider,
      model: v.model,
      account: v.account,
      feature: v.feature,
      dispatched: v.dispatched,
      kind: v.kind as ModelFailureDiagnostic["kind"],
      code: v.code as number | null,
      status: v.status as number | null,
      name: v.name as ModelFailureDiagnostic["name"],
    };
  } catch {
    return null;
  }
}

/** Only finite classifications and anchored numeric codes may be derived from an error. */
export function modelFailureDiagnostic(
  context: Pick<
    ModelFailureDiagnostic,
    "attempt" | "provider" | "model" | "account" | "feature" | "dispatched"
  >,
  error: unknown,
  localKind?: "deadline" | "work_expired" | "work_stopped",
): ModelFailureDiagnostic {
  let code: number | null = null;
  let status: number | null = null;
  let name: ModelFailureDiagnostic["name"] = null;
  let kind: ModelFailureDiagnostic["kind"] = "unknown";
  try {
    const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    const rawName = record?.name;
    if (NAMES.includes(rawName as NonNullable<ModelFailureDiagnostic["name"]>))
      name = rawName as NonNullable<ModelFailureDiagnostic["name"]>;
    const message =
      typeof error === "string" ? error : typeof record?.message === "string" ? record.message : "";
    code = integer(record?.code, 0, 999999);
    status = integer(record?.status, 100, 599);
    if (context.provider === "workers-ai") {
      const prefix = /^(\d{4,6}):(?:\s|$)/.exec(message);
      if (prefix) code ??= Number(prefix[1]);
    } else {
      const prefix =
        /^(?:OpenRouter|TypeSafe) (?:rate limit|over capacity|refused the account's API key|failed) \(([1-5]\d{2})\)(?::|$)/.exec(
          message,
        );
      if (prefix) status ??= Number(prefix[1]);
    }
    if (name === "AiInternalError") kind = "binding_internal";
    else if (
      status === 429 ||
      code === 3021 ||
      code === 3036 ||
      code === 3040 ||
      /\brate limit\b|too many requests|\bcapacity\b/i.test(message)
    )
      kind = "rate_limit";
    else if (
      code !== null ||
      status !== null ||
      name === "InferenceUpstreamError" ||
      (context.provider !== "workers-ai" && context.dispatched)
    )
      kind = "provider_error";
  } catch {
    // Hostile getters and unusual thrown objects cannot affect the model call.
  }
  return {
    event: "ai.model.failed",
    at: new Date().toISOString(),
    attempt: context.attempt,
    provider: context.provider,
    model: safeModel(context.model) ? context.model : "unknown",
    account: identifier.test(context.account) ? context.account : "",
    feature: identifier.test(context.feature) ? context.feature : "unknown",
    dispatched: context.dispatched,
    kind: localKind ?? kind,
    code,
    status,
    name,
  };
}
