// CI publishes natively. Gitmatrix runs the repositories, the CI jobs and the
// package registries, so a job needs no token from anyone: when it starts it
// gets a credential bound to the job (and through it to the repository,
// commit and run), and every package tool comes preconfigured for its owner's
// registries. `npm publish`, `docker push`, `twine upload`, `cargo publish`,
// `mvn deploy`, `helm push` and Go module fetches just work, and each publish
// records where it came from. The credential ends with the job.
//
// Runners write `files` under a config directory of their own and substitute
// its path for ${GITMATRIX_CONFIG} in `env`.

import { generateTokenSecret, hashToken } from "../auth.ts";
import { db } from "../schema.ts";
import { resolveJobAuthority } from "./admission.ts";

export const CONFIG_PLACEHOLDER = "${GITMATRIX_CONFIG}";
const GRACE_MINUTES = 30;

export async function mintJobToken(
  env: Env,
  jobId: string,
  timeoutMinutes: number,
): Promise<string> {
  await resolveJobAuthority(env, jobId);
  // Same alphabet as access tokens, its own prefix so the registry can tell.
  const secret = `gmj_${generateTokenSecret().slice(4)}`;
  const expires = new Date(Date.now() + (timeoutMinutes + GRACE_MINUTES) * 60_000).toISOString();
  await db(env.DB)
    .insertInto("ci_job_tokens")
    .values({ token_hash: await hashToken(secret), job_id: jobId, expires_at: expires })
    .execute();
  return secret;
}

export async function revokeJobTokens(d1: D1Database, jobId: string): Promise<void> {
  await db(d1).deleteFrom("ci_job_tokens").where("job_id", "=", jobId).execute();
}

export interface RegistrySetup {
  env: Record<string, string>;
  files: Record<string, string>;
}

/** Native tool configuration for publishing to `owner`'s registries from CI. */
export function registrySetup(origin: string, owner: string, token: string): RegistrySetup {
  const base = origin.replace(/\/+$/, "");
  const url = new URL(base);
  const host = url.host;
  const withAuth = `${url.protocol}//ci:${encodeURIComponent(token)}@${host}`;
  const cargoName = owner.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const dockerAuth = btoa(`ci:${token}`);
  const config = CONFIG_PLACEHOLDER;
  return {
    env: {
      GITMATRIX_URL: base,
      GITMATRIX_TOKEN: token,
      GITMATRIX_SPACE: owner,
      // Image names are `${GITMATRIX_IMAGE_PREFIX}/<image>:<tag>`.
      GITMATRIX_IMAGE_PREFIX: `${host}/${owner}`,
      // npm, pnpm, yarn (npmrc), bun.
      NPM_CONFIG_USERCONFIG: `${config}/npmrc`,
      GITMATRIX_NPM_REGISTRY: `${base}/npm/${owner}/`,
      // docker, buildx, crane, oras, helm (OCI).
      DOCKER_CONFIG: `${config}/docker`,
      HELM_REGISTRY_CONFIG: `${config}/docker/config.json`,
      // pip / uv read; twine publishes.
      PIP_EXTRA_INDEX_URL: `${withAuth}/pypi/${owner}/simple/`,
      UV_EXTRA_INDEX_URL: `${withAuth}/pypi/${owner}/simple/`,
      TWINE_REPOSITORY_URL: `${base}/pypi/${owner}/`,
      TWINE_USERNAME: "__token__",
      TWINE_PASSWORD: token,
      // cargo: `cargo publish --registry gitmatrix`, or depend with registry = "gitmatrix".
      CARGO_REGISTRIES_GITMATRIX_INDEX: `sparse+${base}/cargo/${owner}/index/`,
      CARGO_REGISTRIES_GITMATRIX_TOKEN: token,
      [`CARGO_REGISTRIES_${cargoName}_INDEX`]: `sparse+${base}/cargo/${owner}/index/`,
      [`CARGO_REGISTRIES_${cargoName}_TOKEN`]: token,
      // Maven 3.9+ picks up MAVEN_ARGS; deploy with -DaltDeploymentRepository or distributionManagement id "gitmatrix".
      MAVEN_ARGS: `-s ${config}/maven-settings.xml`,
      GITMATRIX_MAVEN_URL: `${base}/maven/${owner}/`,
      // Go: private modules first, then the public proxy.
      GOPROXY: `${withAuth}/go/${owner},https://proxy.golang.org,direct`,
      GOFLAGS: "-modcacherw",
      // Generic files and releases.
      GITMATRIX_GENERIC_URL: `${base}/generic/${owner}/`,
      GITMATRIX_RELEASES_URL: `${base}/releases/${owner}/`,
    },
    files: {
      npmrc: [
        `@${owner}:registry=${base}/npm/${owner}/`,
        `//${host}/npm/${owner}/:_authToken=${token}`,
        "",
      ].join("\n"),
      "docker/config.json": `${JSON.stringify({ auths: { [host]: { auth: dockerAuth } } }, null, 2)}\n`,
      "maven-settings.xml": [
        "<settings>",
        "  <servers>",
        "    <server>",
        "      <id>gitmatrix</id>",
        "      <username>ci</username>",
        `      <password>${token}</password>`,
        "    </server>",
        "  </servers>",
        "</settings>",
        "",
      ].join("\n"),
    },
  };
}

/** Substitute the runner's config directory into an environment. */
export function withConfigDir(env: Record<string, string>, dir: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, v.split(CONFIG_PLACEHOLDER).join(dir)]),
  );
}
