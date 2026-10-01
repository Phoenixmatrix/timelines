import { describe, expect, it } from "vite-plus/test";

import { extractCredential } from "./extract.ts";

const h = (entries: Record<string, string>) => new Headers(entries);

describe("extractCredential", () => {
  it("reads bearer, token and raw schemes", () => {
    expect(extractCredential(h({ authorization: "Bearer abc" }))).toMatchObject({
      token: "abc",
      scheme: "bearer",
    });
    expect(extractCredential(h({ authorization: "token abc" }))).toMatchObject({
      token: "abc",
      scheme: "token",
    });
    expect(extractCredential(h({ authorization: "gmx_x" }))).toMatchObject({
      token: "gmx_x",
      scheme: "raw",
    });
  });

  it("uses the Basic password and ignores the username", () => {
    const cred = extractCredential(h({ authorization: `Basic ${btoa("__token__:secret")}` }));
    expect(cred).toMatchObject({ token: "secret", scheme: "basic", username: "__token__" });
  });

  it("accepts a token-shaped Basic username with an empty password", () => {
    expect(extractCredential(h({ authorization: `Basic ${btoa("gmx_abc:")}` }))?.token).toBe(
      "gmx_abc",
    );
    expect(extractCredential(h({ authorization: `Basic ${btoa("bob:")}` }))).toBeNull();
  });

  it("prefers API-key headers", () => {
    expect(extractCredential(h({ "x-jfrog-art-api": "k", authorization: "Bearer b" }))?.token).toBe(
      "k",
    );
  });

  it("returns null without credentials or for malformed Basic", () => {
    expect(extractCredential(h({}))).toBeNull();
    expect(extractCredential(h({ authorization: "Basic !!!" }))).toBeNull();
  });
});
