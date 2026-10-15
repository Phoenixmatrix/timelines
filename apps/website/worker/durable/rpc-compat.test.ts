import { describe, expect, test } from "vite-plus/test";
import { isMissingRpcMethod } from "./rpc-compat.ts";

describe("isMissingRpcMethod", () => {
  const message = (name: string) => `The RPC receiver does not implement the method "${name}".`;

  test("matches workerd's TypeError for that method only", () => {
    expect(
      isMissingRpcMethod(new TypeError(message("installationState")), "installationState"),
    ).toBe(true);
    // Deserialized across RPC: the name survives even if the class doesn't.
    const remote = Object.assign(new Error(message("installationState")), { name: "TypeError" });
    expect(isMissingRpcMethod(remote, "installationState")).toBe(true);
    expect(isMissingRpcMethod(new TypeError(message("installationState")), "status")).toBe(false);
    expect(
      isMissingRpcMethod(new TypeError(message("installationStateV2")), "installationState"),
    ).toBe(false);
  });

  test("ignores every other failure", () => {
    expect(isMissingRpcMethod(new Error(message("installationState")), "installationState")).toBe(
      false,
    );
    expect(isMissingRpcMethod(new TypeError("x is not a function"), "installationState")).toBe(
      false,
    );
    expect(isMissingRpcMethod(message("installationState"), "installationState")).toBe(false);
    expect(isMissingRpcMethod(undefined, "installationState")).toBe(false);
  });
});
