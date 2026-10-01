import { describe, expect, it } from "vite-plus/test";

import {
  checkDigest,
  dockerHubName,
  EMPTY_JSON_DIGEST,
  isValidName,
  isValidTag,
  ManifestError,
  MEDIA_TYPES,
  nextLink,
  paginate,
  parseChallenge,
  parseContentRange,
  parseManifest,
  parsePageParams,
  parseScope,
  referencedDigests,
  referrersIndex,
  requiredBlobs,
  uploadRange,
} from "./index.ts";

const D = (c: string) => `sha256:${c.repeat(64)}`;

function manifestError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ManifestError) return error.code;
    throw error;
  }
  throw new Error("expected a ManifestError");
}

describe("names, tags and digests", () => {
  it("validates repository names per the spec grammar", () => {
    for (const ok of ["a/b", "repo/library/nginx", "a.b/c_d/e__f/g-h", "a/b---c", "x0/y9"]) {
      expect(isValidName(ok), ok).toBe(true);
    }
    for (const bad of ["A/b", "a//b", "a/b/", "/a", "a/-b", "a/b.", "a/b___c", "a/b..c", ""]) {
      expect(isValidName(bad), bad).toBe(false);
    }
    expect(isValidName(`a/${"b".repeat(254)}`)).toBe(false);
  });

  it("validates tags", () => {
    expect(isValidTag("latest")).toBe(true);
    expect(isValidTag("_v1.2-rc.3")).toBe(true);
    expect(isValidTag("sha256-abc.sig")).toBe(true);
    expect(isValidTag(".hidden")).toBe(false);
    expect(isValidTag("-x")).toBe(false);
    expect(isValidTag("a".repeat(128))).toBe(true);
    expect(isValidTag("a".repeat(129))).toBe(false);
  });

  it("accepts only sha256 digests", () => {
    expect(checkDigest(D("a"))).toBe("ok");
    expect(checkDigest(`sha256:${"A".repeat(64)}`)).toBe("invalid");
    expect(checkDigest("sha256:abc")).toBe("invalid");
    expect(checkDigest(`sha512:${"a".repeat(128)}`)).toBe("unsupported");
    expect(checkDigest("nope")).toBe("invalid");
  });
});

describe("manifest parsing", () => {
  const image = {
    schemaVersion: 2,
    mediaType: MEDIA_TYPES.ociManifest,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: D("c"), size: 10 },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: D("1"), size: 5 }],
  };

  it("parses an image manifest", () => {
    const parsed = parseManifest(JSON.stringify(image), MEDIA_TYPES.ociManifest);
    expect(parsed.kind).toBe("image");
    expect(parsed.artifactType).toBe("application/vnd.oci.image.config.v1+json");
    expect(referencedDigests(parsed)).toEqual([D("c"), D("1")]);
  });

  it("takes the media type from Content-Type when the body omits it", () => {
    const { mediaType: _drop, ...bare } = image;
    expect(parseManifest(JSON.stringify(bare), MEDIA_TYPES.ociManifest).mediaType).toBe(
      MEDIA_TYPES.ociManifest,
    );
    expect(parseManifest(JSON.stringify(bare), "application/json").mediaType).toBe(
      MEDIA_TYPES.ociManifest,
    );
  });

  it("rejects mismatched Content-Type", () => {
    expect(
      manifestError(() => parseManifest(JSON.stringify(image), MEDIA_TYPES.dockerManifest)),
    ).toBe("MANIFEST_INVALID");
  });

  it("parses an index and an artifact with a subject", () => {
    const index = parseManifest(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: MEDIA_TYPES.dockerManifestList,
        manifests: [
          {
            mediaType: MEDIA_TYPES.dockerManifest,
            digest: D("2"),
            size: 3,
            platform: { os: "linux" },
          },
        ],
      }),
    );
    expect(index.kind).toBe("index");
    expect(referencedDigests(index)).toEqual([D("2")]);

    const artifact = parseManifest(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: MEDIA_TYPES.ociManifest,
        artifactType: "application/vnd.example.sig",
        config: { mediaType: MEDIA_TYPES.ociEmpty, digest: EMPTY_JSON_DIGEST, size: 2 },
        layers: [{ mediaType: "application/octet-stream", digest: D("3"), size: 1 }],
        subject: { mediaType: MEDIA_TYPES.ociManifest, digest: D("4"), size: 100 },
        annotations: { "org.example": "x" },
      }),
    );
    expect(artifact.artifactType).toBe("application/vnd.example.sig");
    expect(artifact.subject?.digest).toBe(D("4"));
    expect(artifact.annotations).toEqual({ "org.example": "x" });
  });

  it("rejects schema 1, bad digests and garbage", () => {
    expect(manifestError(() => parseManifest(JSON.stringify({ schemaVersion: 1 })))).toBe(
      "MANIFEST_INVALID",
    );
    expect(
      manifestError(() =>
        parseManifest(
          JSON.stringify({ ...image, layers: [{ mediaType: "x", digest: "sha256:zz", size: 1 }] }),
        ),
      ),
    ).toBe("DIGEST_INVALID");
    expect(
      manifestError(() =>
        parseManifest(
          JSON.stringify({
            ...image,
            config: { ...image.config, digest: `sha512:${"a".repeat(128)}` },
          }),
        ),
      ),
    ).toBe("UNSUPPORTED");
    expect(manifestError(() => parseManifest("{not json"))).toBe("MANIFEST_INVALID");
    expect(manifestError(() => parseManifest(JSON.stringify({ ...image, config: null })))).toBe(
      "MANIFEST_INVALID",
    );
    expect(
      manifestError(() =>
        parseManifest(
          JSON.stringify({ ...image, mediaType: MEDIA_TYPES.ociArtifactManifest, blobs: [] }),
        ),
      ),
    ).toBe("UNSUPPORTED");
  });

  it("skips foreign layers when checking required blobs", () => {
    const parsed = parseManifest(
      JSON.stringify({
        ...image,
        mediaType: MEDIA_TYPES.dockerManifest,
        layers: [
          {
            mediaType: "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip",
            digest: D("f"),
            size: 9,
            urls: ["https://example.com/layer"],
          },
        ],
      }),
    );
    expect(requiredBlobs(parsed).map((d) => d.digest)).toEqual([D("c")]);
  });
});

describe("auth helpers", () => {
  it("parses bearer challenges with commas inside quotes", () => {
    const c = parseChallenge(
      'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull,push"',
    );
    expect(c).toEqual({
      scheme: "bearer",
      params: {
        realm: "https://auth.docker.io/token",
        service: "registry.docker.io",
        scope: "repository:library/nginx:pull,push",
      },
    });
    expect(parseChallenge('Basic realm="x"')?.scheme).toBe("basic");
    expect(parseChallenge(null)).toBeNull();
  });

  it("parses scopes", () => {
    expect(parseScope("repository:a/b/c:pull,push")).toEqual({
      type: "repository",
      name: "a/b/c",
      actions: ["pull", "push"],
    });
    expect(parseScope("registry:catalog:*")).toEqual({
      type: "registry",
      name: "catalog",
      actions: ["*"],
    });
    expect(parseScope("repository(plugin):a/b:pull")?.type).toBe("repository");
    expect(parseScope("garbage")).toBeNull();
  });

  it("adds library/ for single-segment Docker Hub images", () => {
    expect(dockerHubName("registry-1.docker.io", "nginx")).toBe("library/nginx");
    expect(dockerHubName("registry-1.docker.io", "bitnami/redis")).toBe("bitnami/redis");
    expect(dockerHubName("ghcr.io", "nginx")).toBe("nginx");
  });
});

describe("uploads and pagination", () => {
  it("parses Content-Range forms", () => {
    expect(parseContentRange("0-1023")).toEqual({ start: 0, end: 1023 });
    expect(parseContentRange("bytes 10-19/*")).toEqual({ start: 10, end: 19 });
    expect(parseContentRange("bytes=10-19")).toEqual({ start: 10, end: 19 });
    expect(parseContentRange("5-1")).toBe("invalid");
    expect(parseContentRange(null)).toBeNull();
    expect(uploadRange(0)).toBe("0-0");
    expect(uploadRange(10)).toBe("0-9");
  });

  it("paginates lexically with a next marker", () => {
    const list = ["a", "b", "c", "d"];
    expect(paginate(list, { n: 2, last: null })).toEqual({ page: ["a", "b"], next: "b", limit: 2 });
    expect(paginate(list, { n: 2, last: "b" })).toEqual({ page: ["c", "d"], next: null, limit: 2 });
    expect(paginate(list, { n: 0, last: null }).page).toEqual([]);
    expect(paginate(list, { n: null, last: "a" }, 2)).toEqual({
      page: ["b", "c"],
      next: "c",
      limit: 2,
    });
    expect(parsePageParams("x", null)).toBeNull();
    expect(nextLink("/v2/a/b/tags/list", 2, "b")).toBe(
      '</v2/a/b/tags/list?n=2&last=b>; rel="next"',
    );
  });

  it("builds a referrers index", () => {
    expect(
      referrersIndex([
        { mediaType: MEDIA_TYPES.ociManifest, digest: D("a"), size: 1, artifactType: "x" },
      ]),
    ).toEqual({
      schemaVersion: 2,
      mediaType: MEDIA_TYPES.ociIndex,
      manifests: [
        { mediaType: MEDIA_TYPES.ociManifest, digest: D("a"), size: 1, artifactType: "x" },
      ],
    });
  });
});
