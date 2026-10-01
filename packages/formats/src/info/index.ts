/** What each format supports; shared by the registry and the web UI. */
export const FORMAT_IDS = [
  "npm",
  "oci",
  "pypi",
  "maven",
  "cargo",
  "go",
  "helm",
  "apt",
  "rpm",
  "brew",
  "generic",
  "releases",
] as const;

export type FormatId = (typeof FORMAT_IDS)[number];
export type RepoKind = "local" | "remote" | "virtual";
export type Visibility = "public" | "internal" | "private";

export interface FormatInfo {
  id: FormatId;
  label: string;
  /** Path prefix on the registry host (OCI lives at /v2). */
  prefix: string;
  kinds: RepoKind[];
  clients: string[];
  /** Upstream suggested when creating a remote repository. */
  defaultUpstream?: string;
  description: string;
}

export const FORMATS: Record<FormatId, FormatInfo> = {
  npm: {
    id: "npm",
    label: "npm",
    prefix: "npm",
    kinds: ["local", "remote", "virtual"],
    clients: ["npm", "pnpm", "yarn", "bun"],
    defaultUpstream: "https://registry.npmjs.org",
    description: "JavaScript packages for npm, pnpm, yarn and bun.",
  },
  oci: {
    id: "oci",
    label: "Docker / OCI",
    prefix: "v2",
    kinds: ["local", "remote", "virtual"],
    clients: ["docker", "podman", "crane", "oras", "helm", "cosign"],
    defaultUpstream: "https://registry-1.docker.io",
    description: "Container images, Helm charts and any OCI artifact.",
  },
  pypi: {
    id: "pypi",
    label: "PyPI",
    prefix: "pypi",
    kinds: ["local", "remote", "virtual"],
    clients: ["pip", "uv", "twine", "poetry", "pdm"],
    defaultUpstream: "https://pypi.org",
    description: "Python wheels and source distributions.",
  },
  maven: {
    id: "maven",
    label: "Maven",
    prefix: "maven",
    kinds: ["local", "remote", "virtual"],
    clients: ["mvn", "gradle", "sbt"],
    defaultUpstream: "https://repo.maven.apache.org/maven2",
    description: "JVM artifacts for Maven, Gradle and sbt.",
  },
  cargo: {
    id: "cargo",
    label: "Cargo",
    prefix: "cargo",
    kinds: ["local", "remote", "virtual"],
    clients: ["cargo"],
    defaultUpstream: "https://index.crates.io",
    description: "Rust crates through a sparse index.",
  },
  go: {
    id: "go",
    label: "Go modules",
    prefix: "go",
    kinds: ["local", "remote", "virtual"],
    clients: ["go"],
    defaultUpstream: "https://proxy.golang.org",
    description: "A GOPROXY for Go modules.",
  },
  helm: {
    id: "helm",
    label: "Helm",
    prefix: "helm",
    kinds: ["local", "remote", "virtual"],
    clients: ["helm"],
    description: "Classic Helm chart repositories (index.yaml).",
  },
  apt: {
    id: "apt",
    label: "Debian / APT",
    prefix: "apt",
    kinds: ["local", "remote"],
    clients: ["apt", "apt-get"],
    defaultUpstream: "https://deb.debian.org/debian",
    description: "Signed Debian and Ubuntu package repositories.",
  },
  rpm: {
    id: "rpm",
    label: "RPM / YUM",
    prefix: "rpm",
    kinds: ["local", "remote"],
    clients: ["dnf", "yum", "zypper"],
    description: "Signed RPM repositories for dnf, yum and zypper.",
  },
  brew: {
    id: "brew",
    label: "Homebrew",
    prefix: "brew",
    kinds: ["local"],
    clients: ["brew"],
    description: "A Homebrew tap served over git, with bottles.",
  },
  generic: {
    id: "generic",
    label: "Generic",
    prefix: "generic",
    kinds: ["local", "remote", "virtual"],
    clients: ["curl", "wget"],
    description: "Arbitrary files at arbitrary paths.",
  },
  releases: {
    id: "releases",
    label: "Releases",
    prefix: "releases",
    kinds: ["local"],
    clients: ["curl", "browser"],
    description: "Versioned software releases with notes and downloadable assets.",
  },
};

export function isFormatId(value: string): value is FormatId {
  return (FORMAT_IDS as readonly string[]).includes(value);
}

/** Repository keys: lowercase, URL- and OCI-safe, and not a reserved path. */
export const REPO_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const RESERVED_KEYS = new Set(["_catalog", "token", "api", "v2", "static", "assets", "health"]);

export function validRepoKey(key: string): boolean {
  return REPO_KEY_PATTERN.test(key) && !RESERVED_KEYS.has(key) && !key.includes("..");
}
