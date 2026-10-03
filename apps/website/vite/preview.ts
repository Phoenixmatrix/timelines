import { createHash } from "node:crypto";

type Environment = Record<string, string | undefined>;

/**
 * What a timeline preview binds in place of production's resources (CORE-80).
 * tools/preview creates them for each `create` and passes them to
 * `cf previews deploy` as GITMATRIX_PREVIEW_* variables; cloudflare.config.ts
 * reads them when cf builds a Preview (`isPreview`). Nothing here falls back
 * to a production resource: a missing variable fails the build.
 */
export interface PreviewResources {
  /** The Worker Preview's name, `timeline-<slug>`; also the seed's environment id. */
  name: string;
  /** The preview's own D1 databases (ids). */
  db: string;
  registryDb: string;
  /** Its own R2 bucket for package blobs, and Artifacts namespace for repositories. */
  bucket: string;
  artifacts: string;
  /**
   * Generated for each create: signs its sessions, seals its registry
   * secrets and lets tools/preview seed it. Its data starts over with each
   * create, so it never needs to outlive one.
   */
  secret: string;
}

const VARIABLES = {
  name: "GITMATRIX_PREVIEW_NAME",
  db: "GITMATRIX_PREVIEW_DB",
  registryDb: "GITMATRIX_PREVIEW_REGISTRY_DB",
  bucket: "GITMATRIX_PREVIEW_BUCKET",
  artifacts: "GITMATRIX_PREVIEW_ARTIFACTS",
  secret: "GITMATRIX_PREVIEW_SECRET",
} as const satisfies Record<keyof PreviewResources, string>;

/** The resources a preview build binds, from the environment tools/preview sets. */
export function previewResources(env: Environment): PreviewResources {
  const missing = Object.values(VARIABLES).filter((key) => !env[key]?.trim());
  if (missing.length)
    throw new Error(
      `A preview build binds its own resources, never production's; set ${missing.join(", ")} ` +
        "(tools/preview/preview.ts does).",
    );
  const resources = Object.fromEntries(
    Object.entries(VARIABLES).map(([field, key]) => [field, env[key]!.trim()]),
  ) as unknown as PreviewResources;
  if (resources.secret.length < 32)
    throw new Error("GITMATRIX_PREVIEW_SECRET must be at least 32 characters.");
  return resources;
}

/** The environment tools/preview hands `cf previews deploy`. */
export function previewVariables(resources: PreviewResources): Record<string, string> {
  return Object.fromEntries(
    Object.entries(VARIABLES).map(([field, key]) => [
      key,
      resources[field as keyof PreviewResources],
    ]),
  );
}

/**
 * The preview's access key, derived from its secret so the link people get
 * never carries the secret that signs sessions and seals registry keys.
 */
export function previewKey(secret: string): string {
  return createHash("sha256").update(`gitmatrix-preview-access:${secret}`).digest("hex");
}
