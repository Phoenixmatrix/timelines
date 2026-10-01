/**
 * Homebrew tap content: file-name rules, formula class names, light parsing of
 * formula/cask Ruby for catalog metadata, a formula renderer, and the files
 * gitmatrix generates into every tap (README, download strategy, metadata).
 */

export type TapFileKind = "formula" | "cask";

export const TAP_DIRS: Record<TapFileKind, "Formula" | "Casks"> = {
  formula: "Formula",
  cask: "Casks",
};

/** Formula and cask names (the file name without `.rb`). */
export const TAP_NAME_PATTERN = /^[a-z0-9][a-z0-9@._+-]*$/;

export function validTapName(name: string): boolean {
  return name.length <= 100 && TAP_NAME_PATTERN.test(name) && !name.includes("..");
}

/** Bottle and source-archive file names under `bottles/`. */
export function validDownloadFileName(file: string): boolean {
  return file.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9@._+-]*$/.test(file) && !file.includes("..");
}

export interface BottleFileName {
  name: string;
  version: string;
  tag: string;
  rebuild: number;
}

/** `<name>--<version>.<tag>.bottle[.<rebuild>].tar.gz` */
export function parseBottleFileName(file: string): BottleFileName | null {
  const match = /^(.+?)--(.+)\.([a-z0-9_]+)\.bottle(?:\.(\d+))?\.tar\.gz$/.exec(file);
  if (!match) return null;
  return {
    name: match[1]!,
    version: match[2]!,
    tag: match[3]!,
    rebuild: match[4] ? Number(match[4]) : 0,
  };
}

/** Homebrew's `Formulary.class_s`: the Ruby class a formula file must define. */
export function formulaClassName(name: string): string {
  let out = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  out = out.replace(/[-_.\s]([a-zA-Z0-9])/g, (_, ch: string) => ch.toUpperCase());
  out = out.replace(/\+/g, "x");
  out = out.replace(/(.)@(\d)/, "$1AT$2");
  return out;
}

function unquote(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

const STRING = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'`;

function stringField(source: string, field: string): string | undefined {
  const match = new RegExp(String.raw`^\s*${field}\s+(?:${STRING})`, "m").exec(source);
  if (!match) return undefined;
  return unquote(match[1] ?? match[2] ?? "");
}

const ARCHIVE_SUFFIX =
  /\.(?:tar\.gz|tar\.bz2|tar\.xz|tar\.zst|tgz|tbz2?|txz|zip|gem|jar|dmg|pkg|zst|gz|bz2|xz|7z|rar|deb|rpm)$/i;

/** A version from a download URL's file name (a small subset of `Version.parse`). */
export function versionFromUrl(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const base = decodeURIComponent(path.split("/").pop() ?? "").replace(ARCHIVE_SUFFIX, "");
  const match =
    /(?:^|[-_])v?(\d+(?:\.\d+)+(?:[-._]?(?:alpha|beta|rc|pre|p)\.?\d*)?)(?:[-_.](?:darwin|linux|macos|mac|osx|arm64|x86_64|amd64|aarch64|universal|all|src|source)\S*)?$/i.exec(
      base,
    ) ?? /^v?(\d+(?:\.\d+)*)$/.exec(base);
  return match?.[1];
}

export interface TapFileInfo {
  /** Declared (or URL-derived) version plus `_<revision>`, if any. */
  version?: string;
  desc?: string;
  homepage?: string;
  url?: string;
}

export function parseTapFile(kind: TapFileKind, source: string): TapFileInfo {
  const info: TapFileInfo = {
    desc: stringField(source, "desc"),
    homepage: stringField(source, "homepage"),
    url: stringField(source, "url"),
  };
  let version = stringField(source, "version");
  if (!version && kind === "cask" && /^\s*version\s+:latest\b/m.test(source)) version = "latest";
  if (!version && kind === "formula" && info.url) version = versionFromUrl(info.url);
  const revision = /^\s*revision\s+(\d+)/m.exec(source)?.[1];
  if (version && kind === "formula" && revision && revision !== "0") {
    version = `${version}_${revision}`;
  }
  if (version) info.version = version;
  return info;
}

/** Checks a formula or cask file defines what Homebrew will look for; null when fine. */
export function checkTapFile(kind: TapFileKind, name: string, source: string): string | null {
  if (!source.trim()) return "The file is empty";
  if (source.includes("\0")) return "The file is not text";
  if (kind === "formula") {
    const className = formulaClassName(name);
    if (!new RegExp(String.raw`^\s*class\s+${className}\s*<`, "m").test(source)) {
      return `Formula/${name}.rb must define \`class ${className} < Formula\``;
    }
  } else if (!new RegExp(String.raw`^\s*cask\s+(["'])${escapeRegExp(name)}\1`, "m").test(source)) {
    return `Casks/${name}.rb must start with \`cask "${name}" do\``;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A Ruby double-quoted string literal. */
export function rubyString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/#([{$@])/g, "\\#$1")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

export type DependencyType = "build" | "test" | "recommended" | "optional";

export interface FormulaSpec {
  name: string;
  desc?: string;
  homepage?: string;
  url: string;
  sha256: string;
  version?: string;
  revision?: number;
  license?: string;
  dependsOn?: (string | { name: string; type?: DependencyType })[];
  /** Ruby body of `def install`; defaults to `bin.install "<name>"`. */
  install?: string;
  /** Ruby body of `test do`; defaults to running `<name> --version`. */
  test?: string;
  caveats?: string;
  /** Bottle tag (e.g. `arm64_sonoma`, `x86_64_linux`) to sha256, or with a cellar. */
  bottles?: Record<string, string | { sha256: string; cellar?: string }>;
}

export interface RenderOptions {
  /** `<registry>/brew/<repo>/bottles` */
  bottleRootUrl: string;
  /** Registry origin; URLs under it use the gitmatrix strategy when `authenticated`. */
  registryUrl: string;
  /** Private or internal repository: downloads need HOMEBREW_GITMATRIX_TOKEN. */
  authenticated: boolean;
}

export const DOWNLOAD_STRATEGY_CLASS = "GitmatrixDownloadStrategy";
export const DOWNLOAD_STRATEGY_PATH = "lib/gitmatrix_download_strategy.rb";
export const TOKEN_ENV = "HOMEBREW_GITMATRIX_TOKEN";

function indent(body: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return body
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => (line.trim() ? pad + line : ""))
    .join("\n");
}

function cellarValue(cellar: string): string {
  if (cellar === "any" || cellar === "any_skip_relocation") return `:${cellar}`;
  if (cellar.startsWith(":any")) return cellar;
  return rubyString(cellar);
}

/** Renders a formula `.rb` from a structured spec. Validate the spec first. */
export function renderFormula(spec: FormulaSpec, options: RenderOptions): string {
  const own = (url: string) => url.startsWith(`${options.registryUrl.replace(/\/+$/, "")}/`);
  const using = options.authenticated ? `, using: ${DOWNLOAD_STRATEGY_CLASS}` : "";
  const lines: string[] = [];
  if (options.authenticated) {
    lines.push(`require_relative "../${DOWNLOAD_STRATEGY_PATH.replace(/\.rb$/, "")}"`, "");
  }
  lines.push(`class ${formulaClassName(spec.name)} < Formula`);
  if (spec.desc) lines.push(`  desc ${rubyString(spec.desc)}`);
  if (spec.homepage) lines.push(`  homepage ${rubyString(spec.homepage)}`);
  lines.push(`  url ${rubyString(spec.url)}${own(spec.url) ? using : ""}`);
  if (spec.version) lines.push(`  version ${rubyString(spec.version)}`);
  lines.push(`  sha256 ${rubyString(spec.sha256)}`);
  if (spec.license) lines.push(`  license ${rubyString(spec.license)}`);
  if (spec.revision) lines.push(`  revision ${spec.revision}`);

  const bottles = Object.entries(spec.bottles ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (bottles.length > 0) {
    lines.push("", "  bottle do", `    root_url ${rubyString(options.bottleRootUrl)}${using}`);
    for (const [tag, value] of bottles) {
      const { sha256, cellar } =
        typeof value === "string" ? { sha256: value, cellar: undefined } : value;
      const cellarPart = cellar ? `cellar: ${cellarValue(cellar)}, ` : "";
      lines.push(`    sha256 ${cellarPart}${tag}: ${rubyString(sha256)}`);
    }
    lines.push("  end");
  }

  const deps = spec.dependsOn ?? [];
  if (deps.length > 0) {
    lines.push("");
    for (const dep of deps) {
      const { name, type } = typeof dep === "string" ? { name: dep, type: undefined } : dep;
      lines.push(`  depends_on ${rubyString(name)}${type ? ` => :${type}` : ""}`);
    }
  }

  lines.push(
    "",
    "  def install",
    indent(spec.install ?? `bin.install ${rubyString(spec.name)}`, 4),
    "  end",
  );
  if (spec.caveats) {
    lines.push("", "  def caveats", `    ${rubyString(spec.caveats)}`, "  end");
  }
  lines.push(
    "",
    "  test do",
    indent(spec.test ?? `system bin/${rubyString(spec.name)}, "--version"`, 4),
    "  end",
    "end",
    "",
  );
  return lines.join("\n");
}

/** `lib/gitmatrix_download_strategy.rb`: curl with a bearer token for this registry only. */
export function downloadStrategySource(registryHost: string): string {
  return `# typed: false
# frozen_string_literal: true

# Generated by gitmatrix; changes are overwritten.
#
# Downloads from ${registryHost} with \`Authorization: Bearer $${TOKEN_ENV}\`
# so formulae can fetch private bottles and source archives. Homebrew only
# passes HOMEBREW_* variables through, hence the name.
require "download_strategy"
require "uri"

class ${DOWNLOAD_STRATEGY_CLASS} < CurlDownloadStrategy
  GITMATRIX_HOST = ${rubyString(registryHost)}

  private

  def _curl_args
    args = super
    token = ENV.fetch(${rubyString(TOKEN_ENV)}, "")
    return args if token.empty?
    return args unless URI(url).host == GITMATRIX_HOST

    args + ["--header", "Authorization: Bearer #{token}"]
  end
end
`;
}

export interface TapSummaryEntry {
  name: string;
  version?: string;
  desc?: string;
  sha256: string;
}

export interface TapSummary {
  repository: string;
  tapName: string;
  /** The clone URL, `<registry>/brew/<repo>/homebrew-<tap>.git`. */
  tapUrl: string;
  bottleRootUrl: string;
  authenticated: boolean;
  formulae: TapSummaryEntry[];
  casks: TapSummaryEntry[];
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function tapReadme(tap: TapSummary): string {
  const user = "gitmatrix";
  const first = tap.formulae[0]?.name ?? "<formula>";
  const lines = [
    `# homebrew-${tap.tapName}`,
    "",
    `A Homebrew tap generated by gitmatrix from the \`${tap.repository}\` repository.`,
    "It is read-only: publish formulae, casks and bottles through the gitmatrix API.",
    "",
    "## Install",
    "",
    "```sh",
    `brew tap ${user}/${tap.tapName} ${tap.tapUrl}`,
    `brew install ${user}/${tap.tapName}/${first}`,
    "```",
  ];
  if (tap.authenticated) {
    lines.push(
      "",
      "This tap is private. Git asks for credentials (use a personal access token as",
      `the password, or a credential helper), and bottles need \`${TOKEN_ENV}\`:`,
      "",
      "```sh",
      `export ${TOKEN_ENV}=<personal access token>`,
      "```",
    );
  }
  const table = (title: string, entries: TapSummaryEntry[]) => {
    if (entries.length === 0) return;
    lines.push("", `## ${title}`, "", "| Name | Version | Description |", "| --- | --- | --- |");
    for (const e of entries) {
      lines.push(
        `| ${markdownCell(e.name)} | ${markdownCell(e.version ?? "")} | ${markdownCell(e.desc ?? "")} |`,
      );
    }
  };
  table("Formulae", tap.formulae);
  table("Casks", tap.casks);
  lines.push("");
  return lines.join("\n");
}

/** `.gitmatrix.json`: machine-readable tap metadata (no timestamps, so it is stable). */
export function tapMetadata(tap: TapSummary): string {
  const entries = (list: TapSummaryEntry[]) =>
    Object.fromEntries(list.map((e) => [e.name, { version: e.version ?? null, sha256: e.sha256 }]));
  return `${JSON.stringify(
    {
      generator: "gitmatrix",
      repository: tap.repository,
      tap: tap.tapName,
      url: tap.tapUrl,
      bottleRootUrl: tap.bottleRootUrl,
      private: tap.authenticated,
      tokenEnv: TOKEN_ENV,
      formulae: entries(tap.formulae),
      casks: entries(tap.casks),
    },
    null,
    2,
  )}\n`;
}
