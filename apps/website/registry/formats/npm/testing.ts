import { createHash } from "node:crypto";

import { gzipSync, writeTar } from "@gitmatrix/formats/archive";

/** Test fixtures shaped like what npm (libnpmpublish) and yarn send. */

export function makeTarball(
  name: string,
  version: string,
  body = "module.exports = 1;\n",
): Uint8Array {
  return gzipSync(
    writeTar([
      { name: "package/package.json", data: JSON.stringify({ name, version }) },
      { name: "package/index.js", data: body },
    ]),
  );
}

export function digests(bytes: Uint8Array) {
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

export interface PublishOptions {
  tgz?: Uint8Array;
  tag?: string;
  integrity?: string;
  /** yarn berry puts `_attachments` before `versions`. */
  attachmentsFirst?: boolean;
  manifest?: Record<string, unknown>;
  readme?: string;
}

export function publishBody(name: string, version: string, options: PublishOptions = {}): string {
  const tgz = options.tgz ?? makeTarball(name, version);
  const sums = digests(tgz);
  const attachments = {
    [`${name}-${version}.tgz`]: {
      content_type: "application/octet-stream",
      data: Buffer.from(tgz).toString("base64"),
      length: tgz.length,
    },
  };
  const versions = {
    [version]: {
      name,
      version,
      description: `the ${name} package`,
      keywords: ["demo"],
      scripts: { test: "true" },
      dependencies: { "is-odd": "^3.0.0" },
      readme: options.readme ?? `# ${name}`,
      _npmUser: { name: "spoofed" },
      ...options.manifest,
      dist: {
        integrity: options.integrity ?? sums.integrity,
        shasum: sums.shasum,
        tarball: `http://localhost/${name}/-/${name}-${version}.tgz`,
      },
    },
  };
  const head = { _id: name, name, description: `the ${name} package` };
  const tags = { "dist-tags": { [options.tag ?? "latest"]: version } };
  return JSON.stringify(
    options.attachmentsFirst
      ? { ...head, _attachments: attachments, ...tags, versions }
      : { ...head, ...tags, versions, access: null, _attachments: attachments },
  );
}
