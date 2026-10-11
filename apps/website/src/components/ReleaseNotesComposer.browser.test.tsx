// Custom release notes (CORE-151) in a real browser: the composer on both
// release-notes pages, against an in-memory server whose compose endpoint is
// canned (the model is the one thing it hasn't got), and the exports it offers.

import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { focusOn, focused, press } from "../testing/focus.ts";
import { renderApp } from "../testing/render.tsx";
import { reply, TestServer } from "../testing/server.ts";

const MARKDOWN = [
  "# Spring release",
  "",
  "Parcels can now be **verified** in batches, with _no_ extra setup. Read the [guide](https://example.com/docs) or run `gm verify`.",
  "",
  "## What is new",
  "",
  "- Faster scans",
  "  - Offline mode",
  "",
  "1. First",
  "2. Second",
].join("\n");

const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function world(markdown = MARKDOWN) {
  const server = await TestServer.start({ world: true });
  const repo = await server.repo("orbit", "notes-engine");
  await server.sql(
    "INSERT INTO release_note_state (repo_id, status, format_version, dirty) VALUES (?, 'ready', 1, 0)",
    repo.id,
  );
  await server.sql(
    "INSERT INTO release_notes (repo_id, release, to_oid, released_at, updated_at, format_version) VALUES (?, '@day:2026-09-20', 'c1', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', 1)",
    repo.id,
  );
  await server.sql(
    `INSERT INTO release_note_entries
      (id, repo_id, release, subject, kind, category, title, summary, tracker_owner_id,
       issue_id, issue_key, team_id, team_key, inputs_hash, shipped_at, updated_at)
     VALUES ('n1', ?, '@day:2026-09-20', 'issue:acc_orbit:ENG-1', 'issue', 'feature', 'Parcel verification', '', 'acc_orbit',
       'ENG-1', 'ENG-1', 'eng', 'ENG', 'h', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z')`,
    repo.id,
  );
  const asked: unknown[] = [];
  const compose = () => ({
    markdown,
    model: "@cf/test-model",
    entries: 1,
    truncated: false,
  });
  server.on("POST", "/api/tracker/:owner/release-notes/compose", ({ body }) => {
    asked.push(body);
    return compose();
  });
  server.on("POST", "/api/repos/:owner/:name/release-notes/compose", ({ body }) => {
    asked.push(body);
    return compose();
  });
  return { server, asked };
}

/** The repository's notes pages: the browser world's API has no such routes, so they are canned. */
function repoNotes(server: TestServer, state: "ready" | "disabled") {
  const at = "2026-09-20T00:00:00.000Z";
  server.on("GET", "/api/repos/:owner/:name/release-notes", {
    status: { state, generatedAt: null },
    releases: [
      {
        name: "@day:2026-09-20",
        kind: "daily",
        toOid: "c1",
        fromTag: null,
        lastCommitAt: at,
        updatedAt: at,
        entries: 1,
      },
    ],
  });
  server.on("GET", "/api/repos/:owner/:name/release-notes/release", {
    release: {
      name: "@day:2026-09-20",
      kind: "daily",
      toOid: "c1",
      fromTag: null,
      fromOid: null,
      truncated: false,
      lastCommitAt: at,
      updatedAt: at,
      entries: 1,
      intro: null,
      introModel: null,
    },
    entries: [
      {
        id: "n1",
        release: "@day:2026-09-20",
        releaseKind: "daily",
        kind: "commit",
        category: "feature",
        title: "Parcel verification",
        summary: "",
        issue: null,
        labels: [],
        workspaceIds: [],
        commits: ["c1"],
        provenance: [],
        timeline: null,
        changes: [],
        lastCommitAt: at,
        model: null,
        updatedAt: at,
      },
    ],
  });
}

const toggle = () => page.getByRole("button", { name: "Write custom release notes", exact: true });
const prompt = () => page.getByRole("textbox", { name: "What should these release notes be?" });
const write = () => page.getByRole("button", { name: "Write release notes", exact: true });

async function openAndWrite(text = "A customer announcement") {
  await toggle().click();
  await prompt().fill(text);
  await write().click();
  await expect.element(page.getByRole("heading", { name: "Spring release" })).toBeVisible();
}

/** The text files of a zip, read through its central directory (no zip dependency for one test). */
async function unzip(blob: Blob): Promise<Record<string, string>> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const files: Record<string, string> = {};
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    files[name] =
      method === 0
        ? new TextDecoder().decode(data)
        : await new Response(
            new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
          ).text();
    at += 46 + nameLength + extra;
  }
  return files;
}

/** Capture what the page would download, without downloading it. */
function captureDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return "blob:test";
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return { blobs, names };
}

test("the composer is collapsed until asked for, and the starting prompts fill the request", async () => {
  await world();
  renderApp("/tracker/orbit/releases");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await expect.element(toggle()).toBeVisible();
  await expect.element(toggle()).toHaveAttribute("aria-expanded", "false");
  await expect.element(prompt()).not.toBeInTheDocument();

  await toggle().click();
  await expect.element(toggle()).toHaveAttribute("aria-expanded", "true");
  await expect.element(prompt()).toHaveFocus();
  await expect.element(write()).toBeDisabled();
  for (const label of [
    "Client-ready announcement",
    "Changelog by category",
    "Short email to customers",
    "Internal summary for the team",
  ])
    await expect.element(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Short email to customers", exact: true }).click();
  await expect
    .element(prompt())
    .toHaveValue(
      "A short email to customers, under 150 words, with a subject line and the two or three changes they will care about most.",
    );
  await expect.element(write()).toBeEnabled();
  await expect.element(page.getByText(/Writes from the notes in the current feed/)).toBeVisible();
});

test("writing shows the Markdown rendered, asked of the filter on the page", async () => {
  const { asked } = await world();
  renderApp("/tracker/orbit/releases?q=type%3Afeature");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await openAndWrite();
  await expect.element(page.getByRole("heading", { name: "What is new" })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "guide" }))
    .toHaveAttribute("href", "https://example.com/docs");
  await expect.element(page.getByText("Offline mode", { exact: true })).toBeVisible();
  expect(asked).toEqual([{ prompt: "A customer announcement", q: "type:feature" }]);
  await expect
    .element(page.getByText(/Writes from the notes matching the filter “type:feature”/))
    .toBeVisible();
  await expect.element(page.getByText(/Check it before you publish it/)).toBeVisible();
});

test("a repository's composer writes from the selected release", async () => {
  const { server, asked } = await world();
  repoNotes(server, "ready");
  renderApp("/orbit/notes-engine/releases");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await openAndWrite("Changelog");
  expect(asked).toEqual([{ prompt: "Changelog", release: "@day:2026-09-20" }]);
  await expect
    .element(page.getByText(/Writes from the selected release, 2026-09-20/))
    .toBeVisible();
});

test("Copy puts the Markdown and the rendered HTML on the clipboard", async () => {
  await world();
  const items: ClipboardItem[] = [];
  vi.spyOn(navigator.clipboard, "write").mockImplementation(async (data) => {
    items.push(...data);
  });
  renderApp("/tracker/orbit/releases");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await openAndWrite();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => items.length).toBe(1);
  expect(await (await items[0]!.getType("text/plain")).text()).toBe(MARKDOWN);
  expect(await (await items[0]!.getType("text/html")).text()).toContain("<h1>Spring release</h1>");
});

test("Download Markdown saves the text as a .md file", async () => {
  await world();
  const downloads = captureDownloads();
  renderApp("/tracker/orbit/releases");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await openAndWrite();
  await page.getByRole("button", { name: "Download Markdown", exact: true }).click();
  await expect.poll(() => downloads.blobs.length).toBe(1);
  expect(await downloads.blobs[0]!.text()).toBe(MARKDOWN);
  expect(downloads.names).toEqual(["orbit-release-notes.md"]);
});

test("Download Word builds a real .docx with the structure of the notes", async () => {
  await world();
  const downloads = captureDownloads();
  renderApp("/tracker/orbit/releases");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await openAndWrite();
  await page.getByRole("button", { name: "Download Word", exact: true }).click();
  await expect.poll(() => downloads.blobs.length, { timeout: 10_000 }).toBe(1);
  const blob = downloads.blobs[0]!;
  expect(blob.type).toBe(WORD);
  expect(blob.size).toBeGreaterThan(1000);
  expect(downloads.names).toEqual(["orbit-release-notes.docx"]);
  const files = await unzip(blob);
  const xml = files["word/document.xml"]!;
  expect(xml).toContain("Spring release");
  expect(xml).toMatch(/w:pStyle w:val="Heading1"/);
  expect(xml).toMatch(/w:pStyle w:val="Heading2"/);
  expect(xml).toContain("<w:b/>");
  expect(xml).toContain("<w:i/>");
  expect(xml).toContain("<w:hyperlink");
  expect(xml).toContain("Offline mode");
  expect(xml).toMatch(/<w:ilvl w:val="1"\/>/);
  expect(files["word/_rels/document.xml.rels"]!).toContain("https://example.com/docs");
});

test("Print opens the print dialog on the notes alone", async () => {
  await world();
  const print = vi.fn();
  const real = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow")!;
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get(this: HTMLIFrameElement) {
      const win = real.get!.call(this) as Window | null;
      return (
        win &&
        new Proxy(win, {
          get(target, key) {
            if (key === "print") return print;
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      );
    },
  });
  onTestFinished(() => {
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", real);
    document.querySelectorAll("iframe").forEach((frame) => frame.remove());
  });
  renderApp("/tracker/orbit/releases");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await openAndWrite();
  await page.getByRole("button", { name: "Print / Save as PDF", exact: true }).click();
  await expect.poll(() => print.mock.calls.length).toBe(1);
  const html = document.querySelector("iframe")!.srcdoc;
  expect(html).toContain("<h1>Spring release</h1>");
  expect(html).not.toContain("Write custom release notes");
  // Once printing is over the hidden frame goes away.
  const frame = document.querySelector("iframe")!;
  (real.get!.call(frame) as Window).dispatchEvent(new Event("afterprint"));
  expect(document.querySelector("iframe")).toBeNull();
});

test("the result is plain: no images, no autolinked references, the same in what is copied", async () => {
  await world(
    "![pixel](https://example.com/pixel.png)\n\nFixed ENG-1 in commit 1a2b3c4d, see [the guide](https://example.com/g).",
  );
  const items: ClipboardItem[] = [];
  vi.spyOn(navigator.clipboard, "write").mockImplementation(async (data) => {
    items.push(...data);
  });
  renderApp("/tracker/orbit/releases");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await toggle().click();
  await prompt().fill("Announcement");
  await write().click();
  await expect.element(page.getByText(/Fixed ENG-1 in commit 1a2b3c4d/)).toBeVisible();
  const result = document.querySelector<HTMLElement>(
    "section[aria-label='Custom release notes'] .gm-prose",
  )!;
  expect(result.querySelector("img")).toBeNull();
  // The reference stays text; only the link the model wrote is a link.
  expect([...result.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["the guide"]);
  expect(
    performance.getEntriesByType("resource").some((entry) => entry.name.includes("pixel.png")),
  ).toBe(false);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => items.length).toBe(1);
  const html = await (await items[0]!.getType("text/html")).text();
  expect(html).toContain("Fixed ENG-1 in commit 1a2b3c4d");
  expect(html).not.toContain("<img");
  expect(html.match(/<a /g)).toHaveLength(1);
});

test("an environment without AI explains itself instead of offering a dead button", async () => {
  const { server } = await world();
  // The repository page knows from its notes status.
  repoNotes(server, "disabled");
  renderApp("/orbit/notes-engine/releases");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await toggle().click();
  await expect.element(page.getByText(/custom release notes can't be written/)).toBeVisible();
  await expect.element(write()).not.toBeInTheDocument();
});

test("the server's refusal is shown beside the request, with where to fix it", async () => {
  const { server } = await world();
  server.on("POST", "/api/tracker/:owner/release-notes/compose", () =>
    reply({ error: "AI release-note writing is off for Orbit." }, 409),
  );
  renderApp("/tracker/orbit/releases");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await toggle().click();
  await prompt().fill("Announcement");
  await write().click();
  await expect.element(page.getByText(/AI release-note writing is off for Orbit\./)).toBeVisible();
  await expect.element(page.getByRole("alert")).toBeVisible();
});

test("on a phone the composer and its result fit the screen and the keyboard reaches everything in order", async () => {
  await world();
  const size = { width: window.innerWidth, height: window.innerHeight };
  onTestFinished(() => page.viewport(size.width, size.height));
  await page.viewport(390, 800);
  renderApp("/tracker/orbit/releases");
  await expect.element(page.getByText("Parcel verification", { exact: true })).toBeVisible();
  await focusOn(toggle());
  await press("Enter");
  await expect.element(prompt()).toHaveFocus();
  await page.getByRole("button", { name: "Client-ready announcement", exact: true }).click();
  await expect.element(prompt()).toHaveFocus();
  await press("Tab");
  expect(focused().name).toBe("Client-ready announcement");
  for (const label of [
    "Changelog by category",
    "Short email to customers",
    "Internal summary for the team",
    "Write release notes",
  ]) {
    await press("Tab");
    expect(focused().name).toBe(label);
  }
  await press("Enter");
  await expect.element(page.getByRole("heading", { name: "Spring release" })).toBeVisible();
  for (const label of ["Copy", "Download Markdown", "Download Word", "Print / Save as PDF"]) {
    await press("Tab");
    expect(focused().name).toBe(label);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
