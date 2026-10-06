import { link } from "./ui.tsx";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import { blobUrl, repoPath, sourceUrl } from "../lib/refs.ts";
import { Mermaid } from "./Mermaid.tsx";
import type { ReactNode } from "react";
import { useRefMarkdown } from "../refs/remark.tsx";

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    return textOf((node.props as { children?: unknown }).children);
  }
  return "";
}

/** A heading's anchor id: lowercase words joined by hyphens, punctuation dropped. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** The h2 and h3 headings of a Markdown text, with the ids `Markdown` gives them. */
export function outline(text: string): { depth: 2 | 3; text: string; id: string }[] {
  const headings: { depth: 2 | 3; text: string; id: string }[] = [];
  const seen = new Set<string>();
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    // Links and images read as their text; the rest of the markup slug() drops.
    const label = match[2]!.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
    const id = slug(label);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    headings.push({
      depth: match[1]!.length as 2 | 3,
      text: label.replace(/[`*_]/g, ""),
      id,
    });
  }
  return headings;
}

/** A bare URL in a generated page: a new tab, like its other outside links. */
function outsideLink(href: string, children: ReactNode) {
  return (
    <a className={link} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/**
 * Markdown for generated pages: `wiki:<slug>` links open wiki pages, repo
 * paths open the code browser at `refName`, and ```mermaid blocks render as
 * diagrams. Raw HTML is never rendered.
 */
export function Markdown({
  text,
  owner,
  name,
  refName,
  sourceId,
  sourceLocations,
}: {
  text: string;
  owner: string;
  name: string;
  refName: string;
  sourceId?: string;
  sourceLocations?: { path: string; sourceId: string; commit: string }[];
}) {
  // Refs in the page link when they resolve, in this repository (CORE-22).
  const refs = useRefMarkdown(outsideLink, { owner, repo: name });
  return (
    <div className="gm-prose" dir="auto">
      <ReactMarkdown
        remarkPlugins={refs.remarkPlugins}
        components={{
          ...refs.components,
          h2({ children }) {
            return <h2 id={slug(textOf(children))}>{children}</h2>;
          },
          h3({ children }) {
            return <h3 id={slug(textOf(children))}>{children}</h3>;
          },
          a({ href = "", children }) {
            if (href.startsWith("wiki:")) {
              return (
                <Link
                  className={link}
                  to={sourceUrl(repoPath(owner, name, "wiki", href.slice(5)), sourceId)}
                >
                  {children}
                </Link>
              );
            }
            if (/^[a-z]+:/i.test(href) || href.startsWith("#")) {
              return (
                <a
                  className={link}
                  href={href}
                  target={href.startsWith("#") ? undefined : "_blank"}
                  rel="noreferrer"
                >
                  {children}
                </a>
              );
            }
            // App-absolute links (/tracker/…, /owner/repo/…) open in place, as written.
            if (href.startsWith("/") && !href.startsWith("//")) {
              return (
                <Link className={link} to={href}>
                  {children}
                </Link>
              );
            }
            const path = href.replace(/^\.\//, "").replace(/#.*$/, "");
            const location = sourceLocations?.find((source) => source.path === path);
            return (
              <Link
                className={link}
                to={`${blobUrl(owner, name, location?.commit ?? refName, path, location?.sourceId ?? sourceId)}${href.includes("#") ? href.slice(href.indexOf("#")) : ""}`}
              >
                {children}
              </Link>
            );
          },
          code({ className, children }) {
            const language = /language-(\w+)/.exec(className ?? "")?.[1];
            if (language === "mermaid") return <Mermaid code={textOf(children).trim()} />;
            return <code className={className}>{children}</code>;
          },
          pre({ children }) {
            // Mermaid diagrams render their own container.
            const child = Array.isArray(children) ? children[0] : children;
            const isMermaid =
              typeof child === "object" &&
              child !== null &&
              "props" in child &&
              /language-mermaid/.test((child.props as { className?: string }).className ?? "");
            return isMermaid ? <>{children}</> : <pre>{children}</pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
