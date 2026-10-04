import {
  ArrowLeftIcon,
  CaretDownIcon,
  CubeIcon,
  DownloadSimpleIcon,
  FileIcon,
  FolderSimpleIcon,
} from "@phosphor-icons/react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { PackageContents, PackageContentEntry } from "../../../shared/packageContents.ts";
import { CopyField } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { bytes } from "../../lib/format.ts";

const PAGE_SIZE = 100;
const CONTENT_PARAMS = ["version", "path", "contentOffset", "manifest"];

export function versionContentsSearch(params: URLSearchParams, version: string | null) {
  const next = new URLSearchParams(params);
  for (const key of CONTENT_PARAMS) next.delete(key);
  if (version !== null) next.set("version", version);
  return `?${next}`;
}

type Navigate = (values: Record<string, string | null>) => string;

/** Name, size, then actions in fixed columns so every row lines up. */
const ROW = "grid-cols-[minmax(0,1fr)_auto_6rem] sm:grid-cols-[minmax(0,1fr)_7rem_5rem]";

const KIND_LABEL: Record<PackageContentEntry["kind"], string> = {
  file: "File",
  directory: "Directory",
  manifest: "Manifest",
  layer: "Layer",
  config: "Config",
};

const CHECKSUM_LABEL: Record<string, string> = {
  md5: "MD5",
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha512: "SHA-512",
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

function JsonContent({
  label,
  value,
  open = false,
}: {
  label: string;
  value: unknown;
  open?: boolean;
}) {
  return (
    <details className="min-w-0 border-t border-line-soft py-3" open={open}>
      <summary className="min-h-11 cursor-pointer content-center font-semibold">{label}</summary>
      <pre
        tabIndex={0}
        aria-label={label}
        className="m-0 max-h-96 overflow-auto rounded-pane bg-surface p-3 mk-mono text-body-sm whitespace-pre-wrap break-all"
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

// Downloads remain ordinary authenticated navigations, never browser-sized blobs.
function sameOriginDownload(url: string | null) {
  return url?.startsWith("/") && !url.startsWith("//") && !url.includes("\\") ? url : null;
}

function EntryDetails({ id, entry }: { id: string; entry: PackageContentEntry }) {
  const checksums = Object.entries(entry.checksums ?? {}).filter(
    // The digest field already shows the sha256.
    ([algorithm, value]) => !(algorithm === "sha256" && entry.digest === `sha256:${value}`),
  );
  const metadata = entry.metadata && Object.keys(entry.metadata).length > 0 ? entry.metadata : null;
  return (
    <div id={id} className="flex min-w-0 flex-col gap-3 border-t border-line-soft bg-surface p-3">
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-body-sm">
        <dt className="text-ink-muted">Type</dt>
        <dd className="m-0 break-all">
          {entry.contentType ? (
            <span className="mk-mono">{entry.contentType}</span>
          ) : (
            KIND_LABEL[entry.kind]
          )}
        </dd>
        <dt className="text-ink-muted">Size</dt>
        <dd className="m-0 tabular-nums">
          {entry.size === null ? "Not recorded" : bytes(entry.size)}
          {entry.size !== null && entry.size >= 1024 && (
            <span className="text-ink-faint"> ({plural(entry.size, "byte")})</span>
          )}
        </dd>
        {entry.path !== entry.name && (
          <>
            <dt className="text-ink-muted">Path</dt>
            <dd className="m-0 mk-mono break-all">{entry.path}</dd>
          </>
        )}
        {entry.digest && (
          <>
            <dt className="content-center text-ink-muted">Digest</dt>
            <dd className="m-0 min-w-0">
              <CopyField label={`Digest for ${entry.name}`} value={entry.digest} />
            </dd>
          </>
        )}
        {checksums.map(([algorithm, value]) => (
          <Fragment key={algorithm}>
            <dt className="content-center text-ink-muted">
              {CHECKSUM_LABEL[algorithm] ?? algorithm}
            </dt>
            <dd className="m-0 min-w-0">
              <CopyField label={`${algorithm} for ${entry.name}`} value={value} />
            </dd>
          </Fragment>
        ))}
      </dl>
      {metadata && (
        <pre
          tabIndex={0}
          aria-label={`Metadata for ${entry.name}`}
          className="m-0 max-h-72 overflow-auto rounded-pane bg-pane p-3 mk-mono text-body-sm whitespace-pre-wrap break-all"
        >
          {JSON.stringify(metadata, null, 2)}
        </pre>
      )}
    </div>
  );
}

function EntryRow({ entry, navigate }: { entry: PackageContentEntry; navigate: Navigate }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const directory = entry.kind === "directory";
  const destination = directory
    ? navigate({ path: entry.path, contentOffset: null })
    : entry.manifestDigest
      ? navigate({ manifest: entry.manifestDigest, path: null, contentOffset: null })
      : null;
  const download = sameOriginDownload(entry.downloadUrl);
  const Icon = directory ? FolderSimpleIcon : entry.kind === "manifest" ? CubeIcon : FileIcon;
  const label = entry.platform ?? entry.name;
  const hasDetails = !directory;
  return (
    <li className="min-w-0">
      <div
        className={`grid min-h-10 items-center gap-x-4 px-3 hover:bg-raised max-sm:min-h-11 ${ROW}`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <Icon
            aria-hidden
            weight={directory ? "fill" : "regular"}
            className={`size-4 shrink-0 ${directory ? "text-ink-muted" : "text-ink-faint"}`}
          />
          {destination ? (
            <Link
              to={destination}
              preventScrollReset
              className="min-w-0 truncate mk-mono text-body-sm text-ink no-underline hover:underline"
              title={entry.path}
              aria-label={directory ? `Open directory ${entry.name}` : `View platform ${label}`}
            >
              {label}
            </Link>
          ) : (
            <span className="min-w-0 truncate mk-mono text-body-sm" title={entry.path}>
              {label}
            </span>
          )}
          {entry.fileCount !== undefined && (
            <span className="shrink-0 text-body-sm text-ink-faint">
              {plural(entry.fileCount, "file")}
            </span>
          )}
          {entry.kind !== "file" && !directory && (
            <span className="mk-chip shrink-0 max-sm:hidden">{KIND_LABEL[entry.kind]}</span>
          )}
        </span>
        <span
          className="text-right text-body-sm whitespace-nowrap text-ink-muted tabular-nums"
          title={entry.size === null ? undefined : plural(entry.size, "byte")}
        >
          {entry.size === null ? (
            <span className="text-ink-faint" aria-label="Size not recorded">
              —
            </span>
          ) : (
            bytes(entry.size)
          )}
        </span>
        <span className="flex items-center justify-end gap-1">
          {download && (
            <a
              className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
              href={download}
              aria-label={`Download ${entry.name}`}
              title={`Download ${entry.name}`}
            >
              <DownloadSimpleIcon aria-hidden />
            </a>
          )}
          {hasDetails && (
            <button
              type="button"
              className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={`${open ? "Hide" : "Show"} details for ${entry.name}`}
              title={open ? "Hide details" : "Details"}
              onClick={() => setOpen(!open)}
            >
              <CaretDownIcon
                aria-hidden
                className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </span>
      </div>
      {open && <EntryDetails id={detailsId} entry={entry} />}
    </li>
  );
}

function Breadcrumbs({ root, path, navigate }: { root: string; path: string; navigate: Navigate }) {
  const directories = path.split("/").filter(Boolean);
  return (
    <nav
      aria-label="Contents directory"
      className="flex min-w-0 flex-wrap items-center gap-x-2 text-body-sm"
    >
      <Link
        to={navigate({ path: null, contentOffset: null })}
        preventScrollReset
        className="min-h-11 content-center text-signal hover:underline"
        aria-current={!path ? "location" : undefined}
      >
        {root}
      </Link>
      {directories.map((directory, index) => (
        <span key={index} className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="text-ink-faint">
            /
          </span>
          <Link
            to={navigate({
              path: directories.slice(0, index + 1).join("/"),
              contentOffset: null,
            })}
            preventScrollReset
            aria-current={index === directories.length - 1 ? "location" : undefined}
            className="min-h-11 content-center mk-mono text-signal hover:underline break-all"
          >
            {directory}
          </Link>
        </span>
      ))}
    </nav>
  );
}

export function PackageVersionContents({ base, version }: { base: string; version: string }) {
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const manifest = params.get("manifest") ?? "";
  const rawOffset = Number(params.get("contentOffset") ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const request = new URLSearchParams({
    version,
    path,
    offset: String(offset),
    limit: String(PAGE_SIZE),
  });
  if (manifest) request.set("manifest", manifest);
  const url = `${base}/contents?${request}`;
  const [result, setResult] = useState<{ url: string; data?: PackageContents; error?: string }>({
    url: "",
  });
  const [retry, setRetry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest" });
  }, [version, path, manifest, offset]);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ url });
    void api<PackageContents>(url, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ url, data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            url,
            error:
              error instanceof ApiError
                ? error.message
                : "Could not load version contents. Check your connection and try again.",
          });
      },
    );
    return () => controller.abort();
  }, [url, retry]);
  const data = result.url === url ? result.data : undefined;
  const error = result.url === url ? result.error : undefined;
  const navigate: Navigate = (values) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    return `?${next}`;
  };
  const metadata = data?.metadata ?? {};
  const browsable =
    !!data && (data.format === "npm" || !!path || data.files.some((e) => e.kind === "directory"));
  const parent = path.split("/").slice(0, -1).join("/");
  return (
    <section
      aria-label="Version contents"
      aria-busy={!data && !error}
      className="min-w-0 rounded-pane bg-pane p-3.5 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 ref={heading} tabIndex={-1} className="m-0 text-title">
            Version contents
          </h2>
          <p className="mb-0 mt-1 mk-mono text-body-sm break-all">{version}</p>
        </div>
        <Link
          to={versionContentsSearch(params, null)}
          preventScrollReset
          className="mk-btn mk-btn--sm min-h-11"
          aria-label="Close version contents"
        >
          <ArrowLeftIcon aria-hidden />
          Back to versions
        </Link>
      </div>
      {error ? (
        <div role="alert" className="mt-4">
          <p className="text-body-sm text-danger-text">{error}</p>
          <button type="button" className="mk-btn min-h-11" onClick={() => setRetry((n) => n + 1)}>
            Retry contents
          </button>
        </div>
      ) : !data ? (
        <div role="status" className="mt-4">
          <p className="text-body-sm text-ink-muted">Loading version contents…</p>
          <div aria-hidden className="flex flex-col gap-3">
            {[0, 1, 2].map((n) => (
              <div key={n} className="h-11 rounded-pane bg-surface" />
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-4 min-w-0">
          {manifest && (
            <div className="mb-3">
              <Link
                to={navigate({ manifest: null, contentOffset: null })}
                preventScrollReset
                className="mk-btn mk-btn--sm min-h-11"
              >
                <ArrowLeftIcon aria-hidden />
                All platforms
              </Link>
              <p className="mb-0 mt-2 mk-mono text-body-sm text-ink-muted break-all">{manifest}</p>
            </div>
          )}
          <div className="min-w-0 overflow-hidden rounded-pane border border-line-soft">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line-soft px-3 py-1">
              {browsable ? (
                <Breadcrumbs
                  root={data.format === "npm" ? "Archive root" : "All files"}
                  path={path}
                  navigate={navigate}
                />
              ) : (
                <h3 className="m-0 min-h-11 content-center text-body font-semibold">
                  {data.format === "oci" ? "Manifests and blobs" : "Files"}
                </h3>
              )}
              <span className="text-body-sm text-ink-muted tabular-nums">
                {plural(data.total, "entry", "entries")}
              </span>
            </div>
            <div
              aria-hidden
              className={`grid gap-x-4 border-b border-line-soft px-3 py-1.5 text-body-sm text-ink-faint max-sm:hidden ${ROW}`}
            >
              <span>Name</span>
              <span className="text-right">Size</span>
              <span />
            </div>
            <ul className="m-0 list-none divide-y divide-line-soft p-0">
              {path && offset === 0 && (
                <li>
                  <Link
                    to={navigate({ path: parent || null, contentOffset: null })}
                    preventScrollReset
                    className="flex min-h-10 items-center gap-3 px-3 text-ink-muted no-underline hover:bg-raised max-sm:min-h-11"
                    aria-label="Parent directory"
                  >
                    <FolderSimpleIcon className="size-4" aria-hidden />
                    ..
                  </Link>
                </li>
              )}
              {data.files.map((entry) => (
                <EntryRow key={entry.id} entry={entry} navigate={navigate} />
              ))}
            </ul>
            {!data.files.length && (
              <p className="m-0 px-3 py-3 text-body-sm text-ink-muted">
                {offset > 0
                  ? "No files on this page. Return to the first page to browse this version."
                  : path
                    ? "This directory contains no files."
                    : "No downloadable files were recorded for this version."}
              </p>
            )}
            {(data.total > data.limit || offset > 0) && (
              <nav
                aria-label="Contents pagination"
                className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft px-3 py-2"
              >
                <span role="status" className="text-body-sm text-ink-muted tabular-nums">
                  {data.files.length
                    ? `${(data.offset + 1).toLocaleString()}–${(data.offset + data.files.length).toLocaleString()} of ${data.total.toLocaleString()}`
                    : `0 of ${data.total.toLocaleString()}`}
                </span>
                <div className="flex flex-wrap gap-2">
                  {offset > 0 && (
                    <Link
                      to={navigate({ contentOffset: null })}
                      preventScrollReset
                      className="mk-btn mk-btn--sm min-h-11"
                    >
                      First files
                    </Link>
                  )}
                  {data.offset > 0 && (
                    <Link
                      to={navigate({
                        contentOffset: String(Math.max(0, data.offset - data.limit)),
                      })}
                      preventScrollReset
                      className="mk-btn mk-btn--sm min-h-11"
                    >
                      Previous files
                    </Link>
                  )}
                  {data.offset + data.files.length < data.total && (
                    <Link
                      to={navigate({ contentOffset: String(data.offset + data.limit) })}
                      preventScrollReset
                      className="mk-btn mk-btn--sm min-h-11"
                    >
                      Next files
                    </Link>
                  )}
                </div>
              </nav>
            )}
          </div>
          {data.manifest !== null && (
            <JsonContent
              label={data.format === "npm" ? "package.json" : "Manifest JSON"}
              value={data.manifest}
            />
          )}
          {data.config !== null && <JsonContent label="Config JSON" value={data.config} />}
          {Object.keys(metadata).length > 0 && (
            <JsonContent label="Recorded metadata" value={metadata} />
          )}
        </div>
      )}
    </section>
  );
}
