import { describe, expect, test } from "vite-plus/test";
import { modelFailureDiagnostic, parseModelFailureDiagnostic } from "./model-failure.ts";

const context = {
  attempt: "12345678-1234-4123-8123-123456789012",
  provider: "workers-ai" as const,
  model: "@cf/cloudflare/clef",
  scopeKind: "space" as const,
  scopeId: "acc_o",
  feature: "knowledge",
  dispatched: true,
};

describe("model failure diagnostics", () => {
  test("projects an allowlist instead of retaining error payloads or extra fields", () => {
    const diagnostic = modelFailureDiagnostic(context, new Error("5007: secret model payload"));
    expect(
      parseModelFailureDiagnostic({ ...diagnostic, message: "secret", cause: { token: "secret" } }),
    ).toEqual(diagnostic);
    expect(diagnostic).toMatchObject({
      kind: "provider_error",
      code: 5007,
      status: null,
      name: "Error",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });

  test.each([
    { attempt: "not-a-uuid" },
    { at: "2026-02-30T00:00:00.000Z" },
    { model: "https://secret.example/model" },
    { feature: "private\nprompt" },
    { scopeId: "credential@example.com" },
    { scopeKind: "account" },
    { scopeKind: "instance" },
    { provider: "arbitrary" },
    { kind: "arbitrary" },
    { name: "secret error name" },
    { code: Infinity },
    { status: 999 },
  ])("rejects unsafe retained fields: %j", (invalid) => {
    expect(
      parseModelFailureDiagnostic({ ...modelFailureDiagnostic(context, null), ...invalid }),
    ).toBeNull();
  });

  test("unrecognized names and messages cannot become evidence or numeric codes", () => {
    const diagnostic = modelFailureDiagnostic(context, {
      name: "secret name",
      message: "private prompt mentioning 3021: rate limit",
      stack: "secret stack",
      cause: { code: 1234, status: 403 },
    });
    expect(diagnostic).toMatchObject({ kind: "rate_limit", name: null, code: null, status: null });
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|private/);
  });

  test.each([
    ["workers-ai", { name: "AiInternalError", message: "secret" }, "binding_internal", null, null],
    [
      "workers-ai",
      { name: "InferenceUpstreamError", message: "secret" },
      "provider_error",
      null,
      null,
    ],
    ["openrouter", new Error("OpenRouter rate limit (429): secret"), "rate_limit", null, 429],
    [
      "typesafe",
      new Error("TypeSafe refused the account's API key (403): secret"),
      "provider_error",
      null,
      403,
    ],
  ] as const)(
    "classifies %s failures without their text",
    (provider, error, kind, code, status) => {
      expect(modelFailureDiagnostic({ ...context, provider }, error)).toMatchObject({
        kind,
        code,
        status,
      });
    },
  );

  test("hostile error getters cannot escape and local cancellation takes precedence", () => {
    const error = {
      get name(): string {
        throw new Error("private");
      },
    };
    expect(modelFailureDiagnostic(context, error, "work_stopped")).toMatchObject({
      kind: "work_stopped",
      name: null,
    });
    expect(
      parseModelFailureDiagnostic({
        get event(): string {
          throw new Error("private");
        },
      }),
    ).toBeNull();
  });
});
