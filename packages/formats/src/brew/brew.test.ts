import { describe, expect, it } from "vite-plus/test";

import {
  checkTapFile,
  downloadStrategySource,
  formulaClassName,
  parseBottleFileName,
  parseTapFile,
  renderFormula,
  rubyString,
  tapMetadata,
  tapReadme,
  validDownloadFileName,
  validTapName,
  versionFromUrl,
} from "./index.ts";

describe("names", () => {
  it("validates formula names and download files", () => {
    expect(validTapName("foo")).toBe(true);
    expect(validTapName("python@3.12")).toBe(true);
    expect(validTapName("gtk+3")).toBe(true);
    expect(validTapName("Foo")).toBe(false);
    expect(validTapName("-x")).toBe(false);
    expect(validTapName("a/b")).toBe(false);
    expect(validDownloadFileName("foo--1.0.arm64_sonoma.bottle.tar.gz")).toBe(true);
    expect(validDownloadFileName("../x")).toBe(false);
  });

  it("derives class names like Formulary.class_s", () => {
    expect(formulaClassName("foo")).toBe("Foo");
    expect(formulaClassName("foo-bar_baz")).toBe("FooBarBaz");
    expect(formulaClassName("python@3.12")).toBe("PythonAT312");
    expect(formulaClassName("gtk+3")).toBe("Gtkx3");
    expect(formulaClassName("node.js")).toBe("NodeJs");
  });

  it("parses bottle file names", () => {
    expect(parseBottleFileName("foo--1.2.3_1.arm64_sonoma.bottle.2.tar.gz")).toEqual({
      name: "foo",
      version: "1.2.3_1",
      tag: "arm64_sonoma",
      rebuild: 2,
    });
    expect(parseBottleFileName("foo-1.2.3.tar.gz")).toBeNull();
  });
});

describe("parsing", () => {
  it("reads version, revision and desc from formulae", () => {
    const source = `class Foo < Formula
  desc "Does \\"things\\""
  homepage "https://example.com"
  url "https://example.com/foo-1.2.3.tar.gz"
  sha256 "${"a".repeat(64)}"
  revision 2
end
`;
    expect(parseTapFile("formula", source)).toEqual({
      desc: 'Does "things"',
      homepage: "https://example.com",
      url: "https://example.com/foo-1.2.3.tar.gz",
      version: "1.2.3_2",
    });
    expect(checkTapFile("formula", "foo", source)).toBeNull();
    expect(checkTapFile("formula", "bar", source)).toContain("class Bar < Formula");
  });

  it("reads cask versions", () => {
    const cask = `cask "my-app" do\n  version "2.0"\nend\n`;
    expect(parseTapFile("cask", cask).version).toBe("2.0");
    expect(parseTapFile("cask", `cask "x" do\n  version :latest\nend\n`).version).toBe("latest");
    expect(checkTapFile("cask", "my-app", cask)).toBeNull();
    expect(checkTapFile("cask", "other", cask)).not.toBeNull();
  });

  it("guesses versions from download URLs", () => {
    expect(versionFromUrl("https://github.com/o/r/archive/refs/tags/v1.4.0.tar.gz")).toBe("1.4.0");
    expect(versionFromUrl("https://x.dev/tool-2.0.1-darwin-arm64.tar.gz")).toBe("2.0.1");
    expect(versionFromUrl("https://x.dev/tool.tar.gz")).toBeUndefined();
  });
});

describe("rendering", () => {
  const spec = {
    name: "my-tool",
    desc: "A #{dangerous} tool",
    homepage: "https://example.com",
    url: "https://pkg.test/brew/tap/bottles/my-tool-1.0.tar.gz",
    sha256: "b".repeat(64),
    version: "1.0",
    license: "MIT",
    dependsOn: ["openssl@3", { name: "cmake", type: "build" as const }],
    bottles: {
      arm64_sonoma: "c".repeat(64),
      x86_64_linux: { sha256: "d".repeat(64), cellar: "any_skip_relocation" },
    },
  };

  it("renders a private formula with the download strategy", () => {
    const rb = renderFormula(spec, {
      bottleRootUrl: "https://pkg.test/brew/tap/bottles",
      registryUrl: "https://pkg.test",
      authenticated: true,
    });
    expect(rb).toContain('require_relative "../lib/gitmatrix_download_strategy"');
    expect(rb).toContain("class MyTool < Formula");
    expect(rb).toContain('desc "A \\#{dangerous} tool"');
    expect(rb).toContain(
      'url "https://pkg.test/brew/tap/bottles/my-tool-1.0.tar.gz", using: GitmatrixDownloadStrategy',
    );
    expect(rb).toContain(
      'root_url "https://pkg.test/brew/tap/bottles", using: GitmatrixDownloadStrategy',
    );
    expect(rb).toContain(`sha256 arm64_sonoma: "${"c".repeat(64)}"`);
    expect(rb).toContain(`sha256 cellar: :any_skip_relocation, x86_64_linux: "${"d".repeat(64)}"`);
    expect(rb).toContain('depends_on "cmake" => :build');
    expect(rb).toContain('    bin.install "my-tool"');
    expect(checkTapFile("formula", "my-tool", rb)).toBeNull();
    expect(parseTapFile("formula", rb).version).toBe("1.0");
  });

  it("renders a public formula without the strategy", () => {
    const rb = renderFormula(
      {
        name: "x",
        url: "https://example.com/x-1.tar.gz",
        sha256: "e".repeat(64),
        install: 'bin.install "x"\nman1.install "x.1"',
      },
      {
        bottleRootUrl: "https://pkg.test/brew/tap/bottles",
        registryUrl: "https://pkg.test",
        authenticated: false,
      },
    );
    expect(rb).not.toContain("require_relative");
    expect(rb).not.toContain("using:");
    expect(rb).not.toContain("bottle do");
    expect(rb).toContain('    man1.install "x.1"');
  });

  it("escapes Ruby strings", () => {
    expect(rubyString('a"b\\c#{d}\n')).toBe('"a\\"b\\\\c\\#{d}\\n"');
  });

  it("generates the strategy, README and metadata", () => {
    const strategy = downloadStrategySource("pkg.test");
    expect(strategy).toContain("class GitmatrixDownloadStrategy < CurlDownloadStrategy");
    expect(strategy).toContain('ENV.fetch("HOMEBREW_GITMATRIX_TOKEN", "")');
    expect(strategy).toContain('GITMATRIX_HOST = "pkg.test"');
    const tap = {
      repository: "tap",
      tapName: "tools",
      tapUrl: "https://pkg.test/brew/tap/homebrew-tools.git",
      bottleRootUrl: "https://pkg.test/brew/tap/bottles",
      authenticated: true,
      formulae: [{ name: "foo", version: "1.0", desc: "a | b", sha256: "f".repeat(64) }],
      casks: [],
    };
    const readme = tapReadme(tap);
    expect(readme).toContain(
      "brew tap gitmatrix/tools https://pkg.test/brew/tap/homebrew-tools.git",
    );
    expect(readme).toContain("| foo | 1.0 | a \\| b |");
    expect(readme).toContain("HOMEBREW_GITMATRIX_TOKEN");
    expect(JSON.parse(tapMetadata(tap)).formulae.foo.version).toBe("1.0");
  });
});
