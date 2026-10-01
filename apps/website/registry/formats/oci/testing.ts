import { createHash } from "node:crypto";

import { expect } from "vite-plus/test";

import { basic, type Harness } from "../../testing/harness.ts";

/** Test helpers shared by the OCI suites (not imported by production code). */

export const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

export function sha(data: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export function jwtClaims(token: string): { access: { name: string; actions: string[] }[] } {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

/** Runs the Docker token flow and returns an Authorization header value. */
export async function bearer(h: Harness, pat: string | null, scopes: string[]): Promise<string> {
  const query = new URLSearchParams({ service: "pkg.test" });
  for (const scope of scopes) query.append("scope", scope);
  const res = await h.request(`/v2/token?${query.toString()}`, {
    headers: pat ? { authorization: basic(pat, "someone") } : {},
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; access_token: string };
  expect(body.access_token).toBe(body.token);
  return `Bearer ${body.token}`;
}

export async function pushBlob(
  h: Harness,
  auth: string,
  name: string,
  data: Uint8Array | string,
): Promise<{ digest: string; size: number }> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = sha(bytes);
  const res = await h.request(`/v2/${name}/blobs/uploads/?digest=${digest}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/octet-stream" },
    body: bytes,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  expect(res.headers.get("docker-content-digest")).toBe(digest);
  return { digest, size: bytes.length };
}

export async function putManifest(
  h: Harness,
  auth: string,
  name: string,
  reference: string,
  manifest: unknown,
  mediaType = OCI_MANIFEST,
): Promise<Response> {
  return h.request(`/v2/${name}/manifests/${reference}`, {
    method: "PUT",
    headers: { authorization: auth, "content-type": mediaType },
    body: JSON.stringify(manifest),
  });
}

/** Pushes config + one layer + an image manifest; returns the manifest's digest and bytes. */
export async function pushImage(
  h: Harness,
  auth: string,
  name: string,
  tag: string,
  layer: string,
  extra: Record<string, unknown> = {},
): Promise<{ digest: string; body: string; layer: { digest: string; size: number } }> {
  const config = await pushBlob(h, auth, name, JSON.stringify({ architecture: "amd64", layer }));
  const blob = await pushBlob(h, auth, name, layer);
  const manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", ...blob }],
    ...extra,
  };
  const body = JSON.stringify(manifest);
  const res = await putManifest(h, auth, name, tag, manifest);
  expect(res.status, await res.clone().text()).toBe(201);
  expect(res.headers.get("docker-content-digest")).toBe(sha(body));
  return { digest: sha(body), body, layer: blob };
}

export function streamOf(data: Uint8Array, chunk = 1024 * 1024): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= data.length) return controller.close();
      controller.enqueue(data.slice(at, at + chunk));
      at += chunk;
    },
  });
}

export async function hashOf(res: Response): Promise<string> {
  const hash = createHash("sha256");
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return `sha256:${hash.digest("hex")}`;
}
