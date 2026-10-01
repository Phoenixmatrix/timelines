import { describe, expect, it } from "vite-plus/test";

import {
  checkDistFilename,
  compareVersions,
  isValidProjectName,
  multipartBoundary,
  negotiateSimple,
  normalizeName,
  normalizeVersion,
  parseCoreMetadata,
  parseMultipart,
  parseProjectHtml,
  parseProjectJson,
  parseSdistFilename,
  parseWheelFilename,
  renderIndexHtml,
  renderProjectHtml,
  renderProjectJson,
  uploadTimeString,
  type SimpleProject,
} from "./index.ts";

describe("names", () => {
  it("normalizes per PEP 503", () => {
    expect(normalizeName("Friendly-Bard")).toBe("friendly-bard");
    expect(normalizeName("FRIENDLY_._bard")).toBe("friendly-bard");
    expect(normalizeName("friendly.bard")).toBe("friendly-bard");
  });

  it("validates project names", () => {
    expect(isValidProjectName("requests")).toBe(true);
    expect(isValidProjectName("zope.interface")).toBe(true);
    expect(isValidProjectName("-bad")).toBe(false);
    expect(isValidProjectName("bad-")).toBe(false);
    expect(isValidProjectName("a/b")).toBe(false);
  });
});

describe("PEP 440", () => {
  it("normalizes versions", () => {
    expect(normalizeVersion("1.0.0-RC1")).toBe("1.0.0rc1");
    expect(normalizeVersion("v1.0")).toBe("1.0");
    expect(normalizeVersion("1.0-1")).toBe("1.0.post1");
    expect(normalizeVersion("1.0.dev")).toBe("1.0.dev0");
    expect(normalizeVersion("1!2.0alpha2.post3-dev4+Ubuntu-1")).toBe("1!2.0a2.post3.dev4+ubuntu.1");
    expect(normalizeVersion("1.01")).toBe("1.1");
    expect(normalizeVersion("not a version")).toBeNull();
    expect(normalizeVersion("1.0+")).toBeNull();
  });

  it("orders versions like packaging", () => {
    const ordered = [
      "1.0.dev456",
      "1.0a1",
      "1.0a2.dev456",
      "1.0a12.dev456",
      "1.0a12",
      "1.0b1.dev456",
      "1.0b2",
      "1.0b2.post345.dev456",
      "1.0b2.post345",
      "1.0rc1.dev456",
      "1.0rc1",
      "1.0",
      "1.0+abc.5",
      "1.0+abc.7",
      "1.0+5",
      "1.0.post456.dev34",
      "1.0.post456",
      "1.1.dev1",
      "2!0.1",
    ];
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(compareVersions)).toEqual(ordered);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
});

describe("filenames", () => {
  it("parses wheels", () => {
    expect(parseWheelFilename("demo_pkg-1.0.0-py3-none-any.whl")).toMatchObject({
      name: "demo_pkg",
      version: "1.0.0",
      pythonTag: "py3",
    });
    expect(parseWheelFilename("torch-2.0.0+cpu-1-cp311-cp311-linux_x86_64.whl")).toMatchObject({
      version: "2.0.0+cpu",
      buildTag: "1",
    });
    expect(parseWheelFilename("../x-1.0-py3-none-any.whl")).toBeNull();
    expect(parseWheelFilename("x-1.0-py3-any.whl")).toBeNull();
  });

  it("parses sdists with dashes in legacy names", () => {
    expect(parseSdistFilename("demo_pkg-1.0.0.tar.gz")).toMatchObject({
      name: "demo_pkg",
      version: "1.0.0",
    });
    expect(parseSdistFilename("my-cool-pkg-2.1.zip", "my-cool-pkg")).toMatchObject({
      name: "my-cool-pkg",
      version: "2.1",
    });
    expect(parseSdistFilename("x-1.0.exe")).toBeNull();
  });

  it("checks uploads against name and version", () => {
    expect(
      checkDistFilename("demo_pkg-1.0-py3-none-any.whl", "Demo.Pkg", "1.0.0", "bdist_wheel"),
    ).toBeNull();
    expect(
      checkDistFilename("demo_pkg-1.0-py3-none-any.whl", "Demo.Pkg", "1.0", "bdist_wheel"),
    ).toBeNull();
    expect(checkDistFilename("other-1.0-py3-none-any.whl", "demo", "1.0", "bdist_wheel")).toContain(
      "Start filename",
    );
    expect(checkDistFilename("demo-1.1.tar.gz", "demo", "1.0", "sdist")).toContain("Version");
    expect(checkDistFilename("demo-1.0.tar.gz", "demo", "1.0", "bdist_egg")).toContain(
      "Unsupported",
    );
    expect(checkDistFilename("demo-1.0.tar.gz", "demo", "1.0", "bdist_wheel")).not.toBeNull();
  });
});

describe("core metadata", () => {
  it("parses multi-valued fields, continuations and the body", () => {
    const meta = parseCoreMetadata(
      [
        "Metadata-Version: 2.1",
        "Name: demo",
        "Version: 1.0",
        "Requires-Python: >=3.8",
        "Requires-Dist: requests (>=2)",
        "Requires-Dist: rich; extra == 'cli'",
        "License: MIT",
        "        and more",
        "",
        "# Demo",
        "",
        "Long description.",
      ].join("\r\n"),
    );
    expect(meta.fields["requires-dist"]).toEqual(["requests (>=2)", "rich; extra == 'cli'"]);
    expect(meta.fields["requires-python"]).toEqual([">=3.8"]);
    expect(meta.fields.license).toEqual(["MIT\nand more"]);
    expect(meta.body).toBe("# Demo\n\nLong description.");
  });
});

describe("simple API", () => {
  const project: SimpleProject = {
    name: "demo",
    files: [
      {
        filename: "demo-1.0-py3-none-any.whl",
        url: "https://pkg.test/pypi/r/packages/demo/1.0/demo-1.0-py3-none-any.whl",
        hashes: { sha256: "ab".repeat(32) },
        requiresPython: ">=3.8,<4",
        coreMetadata: { sha256: "cd".repeat(32) },
        yanked: "broken <build>",
        size: 10,
        uploadTime: "2024-01-02T03:04:05.678Z",
      },
      {
        filename: "demo-1.1.tar.gz",
        url: "https://pkg.test/pypi/r/packages/demo/1.1/demo-1.1.tar.gz",
        hashes: { sha256: "ef".repeat(32) },
        size: 20,
      },
    ],
  };

  it("negotiates content types", () => {
    expect(negotiateSimple(null).contentType).toBe("text/html");
    expect(
      negotiateSimple(
        "application/vnd.pypi.simple.v1+json, application/vnd.pypi.simple.v1+html; q=0.1, text/html; q=0.01",
      ).format,
    ).toBe("json");
    expect(negotiateSimple("application/vnd.pypi.simple.v1+html").contentType).toBe(
      "application/vnd.pypi.simple.v1+html",
    );
    expect(
      negotiateSimple("text/html;q=0.9, application/vnd.pypi.simple.v1+json;q=0.5").format,
    ).toBe("html");
    expect(negotiateSimple("application/json").format).toBe("html");
    expect(negotiateSimple(null, "application/vnd.pypi.simple.v1+json").format).toBe("json");
  });

  it("renders HTML with hashes and escaped attributes", () => {
    const html = renderProjectHtml(project);
    expect(html).toContain(
      `href="https://pkg.test/pypi/r/packages/demo/1.0/demo-1.0-py3-none-any.whl#sha256=${"ab".repeat(32)}"`,
    );
    expect(html).toContain('data-requires-python="&#62;=3.8,&#60;4"');
    expect(html).toContain(`data-core-metadata="sha256=${"cd".repeat(32)}"`);
    expect(html).toContain(`data-dist-info-metadata="sha256=${"cd".repeat(32)}"`);
    expect(html).toContain('data-yanked="broken &#60;build&#62;"');
    expect(html).toContain('<meta name="pypi:repository-version" content="1.1">');
  });

  it("renders PEP 691/700 JSON", () => {
    const doc = JSON.parse(renderProjectJson(project));
    expect(doc.meta["api-version"]).toBe("1.1");
    expect(doc.versions).toEqual(["1.0", "1.1"]);
    expect(doc.files[0]).toMatchObject({
      "requires-python": ">=3.8,<4",
      yanked: "broken <build>",
      size: 10,
      "upload-time": "2024-01-02T03:04:05.678000Z",
      "core-metadata": { sha256: "cd".repeat(32) },
      "dist-info-metadata": { sha256: "cd".repeat(32) },
    });
    expect(doc.files[1].yanked).toBe(false);
  });

  it("round-trips through the upstream parsers", () => {
    const fromHtml = parseProjectHtml(
      renderProjectHtml(project),
      "https://pkg.test/simple/demo/",
      "demo",
    );
    expect(fromHtml.files[0]).toMatchObject({
      filename: "demo-1.0-py3-none-any.whl",
      url: project.files[0]!.url,
      hashes: { sha256: "ab".repeat(32) },
      requiresPython: ">=3.8,<4",
      yanked: "broken <build>",
      coreMetadata: { sha256: "cd".repeat(32) },
    });
    const fromJson = parseProjectJson(renderProjectJson(project), "https://pkg.test/simple/demo/");
    expect(fromJson.files[0]).toMatchObject({ size: 10, yanked: "broken <build>" });
    expect(fromJson.versions).toEqual(["1.0", "1.1"]);
  });

  it("resolves relative upstream links", () => {
    const page = parseProjectHtml(
      '<a href="../../packages/x-1.0.tar.gz#sha256=AA" data-yanked>x-1.0.tar.gz</a>',
      "https://up.test/simple/x/",
      "x",
    );
    expect(page.files[0]).toMatchObject({
      url: "https://up.test/packages/x-1.0.tar.gz",
      hashes: { sha256: "aa" },
      yanked: true,
    });
  });

  it("renders the project index with normalized links", () => {
    expect(renderIndexHtml(["Demo_Pkg"])).toContain('<a href="demo-pkg/">Demo_Pkg</a>');
  });

  it("formats upload times with microseconds", () => {
    expect(uploadTimeString("2024-01-02T03:04:05Z")).toBe("2024-01-02T03:04:05.000000Z");
  });
});

describe("streaming multipart", () => {
  const enc = new TextEncoder();
  const boundary = "----xyzBOUNDARY";

  function body(parts: { name: string; filename?: string; data: string | Uint8Array }[]) {
    const chunks: Uint8Array[] = [enc.encode("preamble\r\n")];
    for (const p of parts) {
      const disposition = `form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}`;
      chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n\r\n`));
      chunks.push(typeof p.data === "string" ? enc.encode(p.data) : p.data);
      chunks.push(enc.encode("\r\n"));
    }
    chunks.push(enc.encode(`--${boundary}--\r\nepilogue`));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  function streamOf(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
    let at = 0;
    return new ReadableStream({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(at, at + chunk));
        at += chunk;
      },
    });
  }

  async function collect(stream: ReadableStream<Uint8Array>) {
    const out: Record<string, string> = {};
    for await (const part of parseMultipart(stream, boundary)) {
      out[part.name + (part.filename ? `:${part.filename}` : "")] = await part.text(1 << 20);
    }
    return out;
  }

  // Content that looks almost like a delimiter must survive intact.
  const tricky = `a\r\n--${boundary.slice(0, -1)}X\r\n--\r\nb`;
  const parts = [
    { name: "name", data: "demo" },
    { name: "content", filename: "demo-1.0.tar.gz", data: tricky },
    { name: "empty", data: "" },
    { name: "version", data: "1.0" },
  ];

  it("parses parts at every chunk size", async () => {
    const bytes = body(parts);
    for (const size of [1, 2, 3, 7, 16, 64, 4096]) {
      expect(await collect(streamOf(bytes, size))).toEqual({
        name: "demo",
        "content:demo-1.0.tar.gz": tricky,
        empty: "",
        version: "1.0",
      });
    }
  });

  it("drains parts the caller does not read", async () => {
    const names: string[] = [];
    for await (const part of parseMultipart(streamOf(body(parts), 5), boundary)) {
      names.push(part.name);
    }
    expect(names).toEqual(["name", "content", "empty", "version"]);
  });

  it("caps text fields", async () => {
    const big = body([{ name: "description", data: "x".repeat(100) }]);
    await expect(
      (async () => {
        for await (const part of parseMultipart(streamOf(big, 10), boundary)) await part.text(10);
      })(),
    ).rejects.toThrow(/too large/);
  });

  it("rejects truncated bodies", async () => {
    const bytes = body(parts);
    await expect(collect(streamOf(bytes.slice(0, 120), 16))).rejects.toThrow(/Unexpected end/);
  });

  it("extracts the boundary", () => {
    expect(multipartBoundary(`multipart/form-data; boundary="${boundary}"`)).toBe(boundary);
    expect(multipartBoundary("multipart/form-data; boundary=abc")).toBe("abc");
    expect(multipartBoundary("application/json")).toBeNull();
  });
});
