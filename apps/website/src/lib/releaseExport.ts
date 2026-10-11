// Getting written release notes out of the browser (CORE-151): a file download,
// the print dialog (which saves a PDF), and a real Word document built from
// the rendered notes. `docx` is imported only when Word is asked for, so no
// page load pays for it.

/** A file name for an export: `<base>-release-notes.<extension>`, safe on every system. */
export function exportFileName(base: string, extension: string): string {
  const safe = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${safe || "release"}-release-notes.${extension}`;
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const PRINT_STYLES = `
  body { font: 11pt/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; margin: 0 auto; max-width: 42rem; padding: 0; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.4em; break-after: avoid; }
  h1 { font-size: 1.7rem; } h2 { font-size: 1.3rem; } h3 { font-size: 1.1rem; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 0.9em; }
  li { margin: 0.2em 0; }
  a { color: #0b57d0; }
  code { font: 0.9em ui-monospace, Menlo, Consolas, monospace; background: #f1f1f1; padding: 0 0.25em; border-radius: 3px; }
  pre { background: #f6f6f6; padding: 0.6em 0.8em; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #ccc; padding-left: 1em; color: #444; }
  table { border-collapse: collapse; } th, td { border: 1px solid #ccc; padding: 0.3em 0.6em; text-align: left; }
  @page { margin: 18mm; }
`;

let printFrame: HTMLIFrameElement | null = null;

/** Print `html` alone, in a hidden frame, so the browser's dialog offers "Save as PDF" without the app around it. */
export function printHtml(html: string, title: string): Promise<void> {
  printFrame?.remove();
  const frame = document.createElement("iframe");
  printFrame = frame;
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0;";
  const escaped = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escaped}</title><style>${PRINT_STYLES}</style></head><body>${html}</body></html>`;
  return new Promise((resolve) => {
    frame.addEventListener(
      "load",
      () => {
        const win = frame.contentWindow;
        if (win) {
          win.addEventListener("afterprint", () => {
            frame.remove();
            if (printFrame === frame) printFrame = null;
          });
          win.focus();
          win.print();
        }
        resolve();
      },
      { once: true },
    );
    document.body.append(frame);
  });
}

type DocxModule = typeof import("docx");
type Child = import("docx").Paragraph | import("docx").Table;
type Inline = import("docx").TextRun | import("docx").ExternalHyperlink;

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
  strike?: boolean;
}

const MONO = "Consolas";
const MAX_LEVEL = 8;

/** A Word document (.docx) with the structure of rendered Markdown: headings, paragraphs, emphasis, links, nested lists, code. */
export async function wordDocument(root: HTMLElement, title: string): Promise<Blob> {
  const docx: DocxModule = await import("docx");
  const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel, LevelFormat } =
    docx;
  let lists = 0;

  const runs = (node: Node, style: RunStyle = {}): Inline[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ");
      return text
        ? [
            new TextRun({
              text,
              bold: style.bold,
              italics: style.italics,
              strike: style.strike,
              font: style.code ? MONO : undefined,
              shading: style.code ? { fill: "EEEEEE" } : undefined,
            }),
          ]
        : [];
    }
    if (!(node instanceof HTMLElement)) return [];
    const tag = node.tagName.toLowerCase();
    if (tag === "br") return [new TextRun({ break: 1 })];
    if (tag === "img") return [];
    const next: RunStyle = {
      ...style,
      bold: style.bold || tag === "strong" || tag === "b",
      italics: style.italics || tag === "em" || tag === "i",
      strike: style.strike || tag === "del" || tag === "s",
      code: style.code || tag === "code",
    };
    const children = [...node.childNodes].flatMap((child) => runs(child, next));
    const href = node.getAttribute("href") ?? "";
    // Only absolute links mean anything outside the app.
    if (tag === "a" && /^(https?:|mailto:)/i.test(href) && children.length)
      return [
        new ExternalHyperlink({ link: href, children: children as import("docx").TextRun[] }),
      ];
    return children;
  };

  const inlineOf = (el: HTMLElement) =>
    [...el.childNodes]
      .filter((child) => !(child instanceof HTMLElement && /^(ul|ol)$/i.test(child.tagName)))
      .flatMap((child) => runs(child));

  const list = (el: HTMLElement, level: number): Child[] => {
    const ordered = el.tagName.toLowerCase() === "ol";
    const instance = ordered ? ++lists : 0;
    return [...el.children].flatMap((item) => {
      if (!(item instanceof HTMLElement) || item.tagName.toLowerCase() !== "li") return [];
      const own = new Paragraph({
        children: inlineOf(item),
        numbering: {
          reference: ordered ? "numbers" : "bullets",
          level: Math.min(level, MAX_LEVEL),
          ...(ordered ? { instance } : {}),
        },
      });
      const nested = [...item.children].flatMap((child) =>
        /^(ul|ol)$/i.test(child.tagName) ? list(child as HTMLElement, level + 1) : [],
      );
      return [own, ...nested];
    });
  };

  const heading = (level: number) =>
    [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
      Math.min(level, 3) - 1
    ]!;

  const blocks = (parent: HTMLElement, indent = 0): Child[] =>
    [...parent.childNodes].flatMap((node): Child[] => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? "").trim();
        return text ? [new Paragraph({ children: [new TextRun({ text })] })] : [];
      }
      if (!(node instanceof HTMLElement)) return [];
      const tag = node.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag))
        return [new Paragraph({ heading: heading(Number(tag[1])), children: runs(node) })];
      if (tag === "p")
        return [
          new Paragraph({
            children: runs(node),
            spacing: { after: 160 },
            ...(indent ? { indent: { left: indent } } : {}),
          }),
        ];
      if (tag === "ul" || tag === "ol") return list(node, 0);
      if (tag === "blockquote") return blocks(node, indent + 480);
      if (tag === "pre")
        return (node.textContent ?? "")
          .replace(/\n$/, "")
          .split("\n")
          .map(
            (line) =>
              new Paragraph({
                children: [new TextRun({ text: line, font: MONO })],
                shading: { fill: "F4F4F4" },
                ...(indent ? { indent: { left: indent } } : {}),
              }),
          );
      if (tag === "table")
        // Tables keep their rows as lines; Markdown notes rarely need more.
        return [...node.querySelectorAll("tr")].map(
          (row) =>
            new Paragraph({
              children: [...row.children].flatMap((cell, i) => [
                ...(i ? [new TextRun({ text: "  |  " })] : []),
                ...runs(cell),
              ]),
            }),
        );
      if (tag === "hr") return [];
      // Anything else (a wrapper) contributes its blocks, or its text as a paragraph.
      const nested = blocks(node, indent);
      return nested.length ? nested : [new Paragraph({ children: runs(node) })];
    });

  const levels = (
    format: (typeof LevelFormat)[keyof typeof LevelFormat],
    text: (n: number) => string,
  ) =>
    Array.from({ length: MAX_LEVEL + 1 }, (_, level) => ({
      level,
      format,
      text: text(level),
      alignment: "left" as const,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    }));

  const doc = new Document({
    title,
    creator: "Gitmatrix",
    numbering: {
      config: [
        { reference: "bullets", levels: levels(LevelFormat.BULLET, () => "•") },
        {
          reference: "numbers",
          levels: levels(LevelFormat.DECIMAL, (level) => `%${level + 1}.`),
        },
      ],
    },
    sections: [{ children: blocks(root) }],
  });
  return Packer.toBlob(doc);
}
