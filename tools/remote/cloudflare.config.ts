import process from "node:process";
import type { CloudflareConfig, ContainerConfig } from "cf/config";

// Shared by native cf typegen and the dependency-free control-Worker packager.
export function remoteConfig(env: NodeJS.ProcessEnv) {
  const typegen = env.GITMATRIX_REMOTE_TYPEGEN === "1";
  const session = env.GITMATRIX_REMOTE_SESSION_ID ?? (typegen ? "typecheck" : "");
  const expiresAt = env.GITMATRIX_REMOTE_EXPIRES_AT ?? (typegen ? "0" : "");
  const image = env.GITMATRIX_CI_IMAGE;
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? (typegen ? "00000000000000000000000000000000" : "");
  if (!/^[a-f0-9]{32}$/.test(account)) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  if (!/^[a-z0-9-]{8,48}$/.test(session))
    throw new Error("GITMATRIX_REMOTE_SESSION_ID is required");
  if (!/^\d+$/.test(expiresAt)) throw new Error("GITMATRIX_REMOTE_EXPIRES_AT is required");
  if (!typegen && (!image || !/@sha256:[a-f0-9]{64}$/.test(image)))
    throw new Error(
      "GITMATRIX_CI_IMAGE must be the digest-pinned deployed CI image; local Docker builds are not supported",
    );
  const name = "gmr-" + session;
  const container =
    !typegen && image
      ? ({
          name,
          schedulingPolicy: "durable-object",
          images: { default: { reference: image } },
        } satisfies ContainerConfig)
      : undefined;
  return {
    ...(container ? { containers: [container] } : {}),
    worker: {
      name,
      compatibilityDate: "2026-10-09",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "./worker.ts",
      workersDev: true,
      previewUrls: false,
      // Never record launch-ticket URLs or command/credential bodies in request logs.
      observability: { enabled: false },
      env: {
        WORKSPACE: { type: "durable-object", worker: name, exportName: "RemoteWorkspace" },
        CONTROL_TOKEN: { type: "secret" },
        PREVIEW_TOKEN: { type: "secret" },
        SESSION_ID: { type: "text", value: session },
        ACCOUNT_ID: { type: "text", value: account },
        EXPIRES_AT: { type: "text", value: expiresAt },
        APP_PORT: { type: "text", value: "5270" },
        DEBUG_PORT: { type: "text", value: "9229" },
      },
      exports: {
        RemoteWorkspace: {
          type: "durable-object",
          storage: "sqlite",
          ...(container ? { container } : {}),
        },
      },
    },
  } satisfies CloudflareConfig;
}

export default () => remoteConfig(process.env);
