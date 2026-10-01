import { createHash } from "node:crypto";

import { strToU8, zipSync } from "@gitmatrix/formats/archive";

/** Test helpers for building wheels and legacy-upload request bodies. */

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function md5(data: Uint8Array | string): string {
  return createHash("md5").update(data).digest("hex");
}

export function metadataText(name: string, version: string, requiresPython = ">=3.8"): string {
  return [
    "Metadata-Version: 2.1",
    `Name: ${name}`,
    `Version: ${version}`,
    "Summary: A demo package",
    `Requires-Python: ${requiresPython}`,
    "Requires-Dist: requests>=2",
    "",
    "# Demo",
    "",
  ].join("\n");
}

export function wheel(name: string, version: string, metadata = metadataText(name, version)) {
  const dist = name.replace(/[-_.]+/g, "_");
  return zipSync({
    [`${dist}/__init__.py`]: strToU8("print('hi')\n"),
    [`${dist}-${version}.dist-info/METADATA`]: strToU8(metadata),
    [`${dist}-${version}.dist-info/WHEEL`]: strToU8("Wheel-Version: 1.0\n"),
  });
}

export interface UploadInput {
  name: string;
  version: string;
  filename: string;
  data: Uint8Array;
  filetype?: string;
  /** Put the file part before the metadata fields. */
  contentFirst?: boolean;
  extra?: [string, string][];
  sha256?: string;
}

export function uploadBody(input: UploadInput): { body: Uint8Array; contentType: string } {
  const boundary = "--------------------------gitmatrixTEST";
  const enc = new TextEncoder();
  const fields: [string, string][] = [
    [":action", "file_upload"],
    ["protocol_version", "1"],
    ["metadata_version", "2.1"],
    ["name", input.name],
    ["version", input.version],
    ["filetype", input.filetype ?? (input.filename.endsWith(".whl") ? "bdist_wheel" : "sdist")],
    ["pyversion", input.filename.endsWith(".whl") ? "py3" : "source"],
    ["summary", "A demo package"],
    ["requires_python", ">=3.8"],
    ["requires_dist", "requests>=2"],
    ["requires_dist", "rich"],
    ["sha256_digest", input.sha256 ?? sha256(input.data)],
    ["md5_digest", md5(input.data)],
    ...(input.extra ?? []),
  ];
  const chunks: Uint8Array[] = [];
  const fieldParts = () => {
    for (const [name, value] of fields) {
      chunks.push(
        enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    }
  };
  const filePart = () => {
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${input.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      input.data,
      enc.encode("\r\n"),
    );
  };
  if (input.contentFirst) {
    filePart();
    fieldParts();
  } else {
    fieldParts();
    filePart();
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
