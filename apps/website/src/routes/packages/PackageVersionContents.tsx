import { ArrowLeftIcon, DownloadSimpleIcon, FolderIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
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

function ContentFile({
  entry,
  navigate,
}: {
  entry: PackageContentEntry;
  navigate: (values: Record<string, string | null>) => string;
}) {
  const checksums = Object.entries(entry.checksums ?? {});
  const destination =
    entry.kind === "directory"
      ? navigate({ path: entry.path, contentOffset: null })
      : entry.manifestDigest
        ? navigate({ manifest: entry.manifestDigest, path: null, contentOffset: null })
        : null;
  // Downloads remain ordinary authenticated navigations, never browser-sized blobs.
  const download =
    entry.downloadUrl?.startsWith("/") &&
    !entry.downloadUrl.startsWith("//") &&
    !entry.downloadUrl.includes("\\")
      ? entry.downloadUrl
      : null;
  return (
    <li className="min-w-0 border-t border-line-soft py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {entry.kind === "directory" && (
            <FolderIcon aria-hidden className="size-4 shrink-0 text-ink-muted" />
          )}
          {destination ? (
            <Link
              to={destination}
              preventScrollReset
              className="min-w-0 py-2 mk-mono text-body-sm text-signal underline-offset-4 hover:underline break-all"
              aria-label={
                entry.kind === "directory"
                  ? `Open directory ${entry.name}`
                  : `View platform ${entry.platform ?? entry.name}`
              }
            >
              {entry.platform ?? entry.name}
            </Link>
          ) : (
            <span className="min-w-0 mk-mono text-body-sm break-all">{entry.name}</span>
          )}
        </div>
        <span className="text-body-sm text-ink-muted tabular-nums">
          {entry.size === null
            ? entry.kind === "directory"
              ? "Directory"
              : "Size not recorded"
            : bytes(entry.size)}
        </span>
        {download && (
          <a
            className="mk-btn mk-btn--sm min-h-11"
            href={download}
            aria-label={`Download ${entry.name}`}
          >
            <DownloadSimpleIcon aria-hidden />
            Download
          </a>
        )}
      </div>
      {entry.digest && (
        <div className="mt-2">
          <CopyField label={`Digest for ${entry.name}`} value={entry.digest} />
        </div>
      )}
      {checksums.length > 0 && (
        <details className="mt-2 text-body-sm">
          <summary className="min-h-11 cursor-pointer content-center text-ink-muted">
            Checksums
          </summary>
          <div className="flex flex-col gap-2">
            {checksums.map(([algorithm, value]) => (
              <CopyField key={algorithm} label={`${algorithm} for ${entry.name}`} value={value} />
            ))}
          </div>
        </details>
      )}
      {entry.metadata && Object.keys(entry.metadata).length > 0 && (
        <JsonContent label={`Metadata for ${entry.name}`} value={entry.metadata} />
      )}
    </li>
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
  const navigate = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    return `?${next}`;
  };
  const directories = path.split("/").filter(Boolean);
  const metadata = data?.metadata ?? {};
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
          {data.format === "npm" && (
            <nav
              aria-label="Contents directory"
              className="mb-3 flex flex-wrap items-center gap-x-2 text-body-sm"
            >
              <Link
                to={navigate({ path: null, contentOffset: null })}
                preventScrollReset
                className="min-h-11 content-center text-signal hover:underline"
                aria-current={!path ? "location" : undefined}
              >
                Archive root
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
                    className="min-h-11 content-center text-signal hover:underline break-all"
                  >
                    {directory}
                  </Link>
                </span>
              ))}
            </nav>
          )}
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
          {data.manifest !== null && (
            <JsonContent
              label={data.format === "npm" ? "package.json" : "Manifest JSON"}
              value={data.manifest}
              open
            />
          )}
          {data.config !== null && <JsonContent label="Config JSON" value={data.config} />}
          {Object.keys(metadata).length > 0 && (
            <JsonContent
              label="Recorded metadata"
              value={metadata}
              open={data.format !== "npm" && data.format !== "oci"}
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-body font-semibold">
              {data.format === "oci" ? "Manifests and blobs" : "Files"}
            </h3>
            <span className="text-body-sm text-ink-muted tabular-nums">
              {data.total.toLocaleString()} {data.total === 1 ? "entry" : "entries"}
            </span>
          </div>
          {data.files.length ? (
            <ul className="m-0 mt-2 list-none p-0">
              {data.files.map((entry) => (
                <ContentFile key={entry.id} entry={entry} navigate={navigate} />
              ))}
            </ul>
          ) : (
            <p className="text-body-sm text-ink-muted">
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
              className="mb-4 mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3"
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
                    to={navigate({ contentOffset: String(Math.max(0, data.offset - data.limit)) })}
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
      )}
    </section>
  );
}
