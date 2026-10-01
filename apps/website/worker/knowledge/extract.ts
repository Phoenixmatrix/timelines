// Deterministic structure: what language a file is, what it defines and what
// it imports, and which imports point at other files in the repository.
// Cheap, exact and instant, so the graph's skeleton never waits for a model;
// the models add meaning on top.

export type Language =
  | "typescript"
  | "javascript"
  | "rust"
  | "python"
  | "go"
  | "css"
  | "html"
  | "sql"
  | "markdown"
  | "json"
  | "toml"
  | "yaml"
  | "shell"
  | "text"
  | "binary";

const BY_EXTENSION: Record<string, Language> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
  css: "css",
  scss: "css",
  html: "html",
  sql: "sql",
  md: "markdown",
  mdx: "markdown",
  json: "json",
  jsonc: "json",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  txt: "text",
};

const BINARY =
  /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|wasm|mp4|webm|mp3|lock)$/i;

export function languageOf(path: string): Language {
  if (BINARY.test(path)) return "binary";
  const name = path.split("/").pop() ?? path;
  if (name === "Dockerfile" || name.endsWith(".dockerfile")) return "shell";
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  return BY_EXTENSION[ext] ?? "text";
}

/**
 * Files that are never worth a model's time: lockfiles, generated or vendored
 * output, minified bundles, binaries and anything huge.
 */
export function skipReason(path: string, size: number): string | null {
  const name = path.split("/").pop() ?? path;
  if (languageOf(path) === "binary") return "binary";
  if (
    /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|bun\.lockb?)$/.test(name)
  ) {
    return "lockfile";
  }
  if (/(^|\/)(node_modules|dist|build|target|vendor|\.wrangler|\.cloudflare)\//.test(path)) {
    return "generated";
  }
  if (/\.min\.(js|css)$|worker-configuration\.d\.ts$|\.snap$/.test(path)) return "generated";
  if (size > 200_000) return "too large";
  if (size === 0) return "empty";
  return null;
}

export interface ExtractedSymbol {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
}

export interface Extracted {
  language: Language;
  lines: number;
  /** Raw import specifiers as written. */
  imports: string[];
  symbols: ExtractedSymbol[];
}

const RULES: Partial<
  Record<Language, { imports: RegExp[]; symbols: { re: RegExp; kind: string }[] }>
> = {
  typescript: {
    imports: [
      /^\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/,
      /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/,
      /require\(\s*["']([^"']+)["']\s*\)/,
      /import\(\s*["']([^"']+)["']\s*\)/,
    ],
    symbols: [
      {
        re: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
        kind: "function",
      },
      {
        re: /^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
        kind: "class",
      },
      { re: /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
      { re: /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
      { re: /^\s*(export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
      { re: /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "const" },
    ],
  },
  rust: {
    imports: [/^\s*(?:pub\s+)?use\s+([\w:]+)/, /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/],
    symbols: [
      {
        re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+(\w+)/,
        kind: "function",
      },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: "struct" },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: "enum" },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: "trait" },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?type\s+(\w+)\s*=/, kind: "type" },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(\w+)\s*:/, kind: "const" },
    ],
  },
  python: {
    imports: [/^\s*from\s+([\w.]+)\s+import/, /^\s*import\s+([\w.]+)/],
    symbols: [
      { re: /^()(?:async\s+)?def\s+(\w+)/, kind: "function" },
      { re: /^()class\s+(\w+)/, kind: "class" },
    ],
  },
  go: {
    imports: [/^\s*import\s+"([^"]+)"/, /^\s+"([^"]+)"$/],
    symbols: [
      { re: /^()func\s+(?:\([^)]*\)\s*)?(\w+)/, kind: "function" },
      { re: /^()type\s+(\w+)\s+(?:struct|interface)/, kind: "type" },
    ],
  },
  sql: {
    imports: [],
    symbols: [
      { re: /^()\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/i, kind: "table" },
      {
        re: /^()\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/i,
        kind: "index",
      },
    ],
  },
  css: {
    imports: [/@import\s+(?:url\()?["']([^"']+)["']/],
    symbols: [],
  },
};
RULES.javascript = RULES.typescript;

export function extract(path: string, content: string): Extracted {
  const language = languageOf(path);
  const lines = content.split("\n");
  const rules = RULES[language];
  const imports: string[] = [];
  const symbols: ExtractedSymbol[] = [];
  if (rules) {
    lines.forEach((line, index) => {
      for (const re of rules.imports) {
        const match = line.match(re);
        if (match?.[1] && !imports.includes(match[1])) imports.push(match[1]);
      }
      for (const { re, kind } of rules.symbols) {
        const match = line.match(re);
        const name = match?.[2];
        if (name && !symbols.some((s) => s.name === name)) {
          // Python and Go export by convention, not keyword.
          const exported =
            language === "python"
              ? !name.startsWith("_")
              : language === "go"
                ? /^[A-Z]/.test(name)
                : language === "sql"
                  ? true
                  : Boolean(match[1]);
          symbols.push({ name, kind, line: index + 1, exported });
          break;
        }
      }
    });
  }
  return { language, lines: lines.length, imports, symbols };
}

// ---- resolving imports ------------------------------------------------------

export type ResolvedImport =
  | { type: "file"; path: string }
  | { type: "package"; ecosystem: string; name: string };

function normalize(parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** The npm package a bare specifier refers to (`@scope/pkg/sub` -> `@scope/pkg`). */
function npmPackage(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

/**
 * Where an import points: another file in the repository (when one exists),
 * or an external package. Unresolvable relative imports are dropped.
 */
export function resolveImport(
  fromPath: string,
  spec: string,
  language: Language,
  files: Set<string>,
): ResolvedImport | null {
  const dir = fromPath.split("/").slice(0, -1);
  const firstExisting = (candidates: string[]) => candidates.find((c) => files.has(c));

  if (language === "typescript" || language === "javascript" || language === "css") {
    if (spec.startsWith(".") || spec.startsWith("/")) {
      const base = normalize([...(spec.startsWith("/") ? [] : dir), ...spec.split("/")]);
      const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
      const found = firstExisting([
        base,
        ...["ts", "tsx", "mts", "js", "jsx", "mjs", "css"].map((ext) => `${stem}.${ext}`),
        ...["ts", "tsx", "js"].map((ext) => `${base}/index.${ext}`),
      ]);
      return found ? { type: "file", path: found } : null;
    }
    if (spec.startsWith("node:") || spec.startsWith("cloudflare:")) {
      return { type: "package", ecosystem: "platform", name: spec };
    }
    return { type: "package", ecosystem: "npm", name: npmPackage(spec) };
  }

  if (language === "rust") {
    // `mod foo;` names a sibling file; `use crate::a::b` walks from src/.
    const crateRoot = fromPath.includes("/src/")
      ? fromPath.slice(0, fromPath.indexOf("/src/") + 5)
      : "src/";
    if (/^\w+$/.test(spec)) {
      const here =
        fromPath.endsWith("/mod.rs") || /\/(main|lib)\.rs$/.test(fromPath)
          ? dir
          : [...dir, (fromPath.split("/").pop() ?? "").replace(/\.rs$/, "")];
      const found = firstExisting([
        `${normalize([...here, spec])}.rs`,
        `${normalize([...here, spec])}/mod.rs`,
      ]);
      return found ? { type: "file", path: found } : null;
    }
    const segments = spec.split("::");
    if (segments[0] === "crate" || segments[0] === "super" || segments[0] === "self") {
      const start =
        segments[0] === "crate"
          ? crateRoot.replace(/\/$/, "").split("/")
          : segments[0] === "super"
            ? dir.slice(0, -1)
            : dir;
      // Try the longest module path that exists as a file.
      for (let n = segments.length - 1; n >= 1; n--) {
        const module = normalize([...start, ...segments.slice(1, n + 1)]);
        const found = firstExisting([`${module}.rs`, `${module}/mod.rs`]);
        if (found) return { type: "file", path: found };
      }
      return null;
    }
    if (["std", "core", "alloc"].includes(segments[0] ?? "")) {
      return { type: "package", ecosystem: "platform", name: `rust:${segments[0]}` };
    }
    return { type: "package", ecosystem: "crates", name: segments[0] ?? spec };
  }

  if (language === "python") {
    const module = spec.replace(/\./g, "/");
    const found = firstExisting([
      `${module}.py`,
      `${module}/__init__.py`,
      normalize([...dir, `${module}.py`]),
    ]);
    if (found) return { type: "file", path: found };
    return { type: "package", ecosystem: "pypi", name: spec.split(".")[0] ?? spec };
  }

  if (language === "go") {
    return { type: "package", ecosystem: "go", name: spec };
  }
  return null;
}
