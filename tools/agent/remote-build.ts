import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { remoteConfig } from "../remote/cloudflare.config.ts";
import type { RemoteEnvironment } from "./remote-environment.ts";

/** Package only the three control modules for cf deploy --prebuilt; never build the app. */
export async function writeRemoteBuild(
  root: string,
  destination: string,
  record: RemoteEnvironment,
  image: string,
): Promise<void> {
  const config = remoteConfig({
    CLOUDFLARE_ACCOUNT_ID: record.account,
    GITMATRIX_REMOTE_SESSION_ID: record.id.slice(4),
    GITMATRIX_REMOTE_EXPIRES_AT: String(record.expires),
    GITMATRIX_CI_IMAGE: image,
  });
  const container = config.containers?.[0];
  if (!container) throw new Error("Remote deployment requires its pinned Container image.");
  const output = join(destination, ".cloudflare/output/v0");
  const workerDirectory = join(output, "workers/default");
  const bundle = join(workerDirectory, "bundle");
  const containerDirectory = join(output, "containers", container.name);
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  await mkdir(containerDirectory, { recursive: true, mode: 0o700 });
  const worker = await readFile(join(root, "tools/remote/worker.ts"), "utf8");
  const protocolImport = 'from "../agent/remote-protocol.ts"';
  if (worker.split(protocolImport).length !== 2)
    throw new Error("Control Worker protocol import changed; update the explicit module package.");
  const modules: Record<string, { type: "esm" }> = {};
  for (const [name, source] of [
    ["worker.ts", worker.replace(protocolImport, 'from "./remote-protocol.ts"')],
    ["remote-protocol.ts", await readFile(join(root, "tools/agent/remote-protocol.ts"), "utf8")],
    ["runtime.mjs", await readFile(join(root, "tools/remote/runtime.mjs"), "utf8")],
  ] as const) {
    // Complete manifests declare ES modules explicitly, so .ts module names remain valid.
    const content = name.endsWith(".ts") ? stripTypeScriptTypes(source) : source;
    await writeFile(join(bundle, name), content, { mode: 0o600, flag: "wx" });
    modules[name] = { type: "esm" };
  }
  const { entrypoint: _entrypoint, ...workerConfig } = config.worker;
  const workspace = workerConfig.env.WORKSPACE;
  if (
    workspace.worker !== workerConfig.name ||
    workspace.exportName !== "RemoteWorkspace" ||
    workerConfig.exports.RemoteWorkspace.storage !== "sqlite"
  )
    throw new Error("The control Container must belong to this Worker's SQLite Durable Object.");
  // Build Output v0 resolves authored Container objects to their application names.
  const builtWorker = {
    ...workerConfig,
    env: {
      ...workerConfig.env,
      // cf's typed DO output requires worker:string and emits cross-Worker script_name.
      // Its supported raw binding form omits that field for this validated local DO.
      WORKSPACE: { type: "unsafe:durable_object_namespace", class_name: workspace.exportName },
    },
    exports: {
      RemoteWorkspace: { ...workerConfig.exports.RemoteWorkspace, container: container.name },
    },
    manifest: { type: "complete", mainModule: "worker.ts", modules },
  };
  for (const [path, value] of [
    [
      join(output, "config.json"),
      { accountId: record.account, buildContext: { isPreview: false } },
    ],
    [join(workerDirectory, "worker.config.json"), builtWorker],
    [join(containerDirectory, "container.config.json"), container],
  ] as const) {
    await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  }
}
