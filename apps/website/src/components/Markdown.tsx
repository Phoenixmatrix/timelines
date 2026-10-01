import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { blobUrl, repoPath } from "../lib/refs.ts";
import { Mermaid } from "./Mermaid.tsx";

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Array.isArray(node) ? node.map(textOf).join("") : "";
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
}: {
  text: string;
  owner: string;
  name: string;
  refName: string;
}) {
  return (
    <div className="gm-prose" dir="auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href = "", children }) {
            if (href.startsWith("wiki:")) {
              return (
                <Link className="gm-link" to={repoPath(owner, name, "wiki", href.slice(5))}>
                  {children}
                </Link>
              );
            }
            if (/^[a-z]+:/i.test(href) || href.startsWith("#")) {
              return (
                <a
                  className="gm-link"
                  href={href}
                  target={href.startsWith("#") ? undefined : "_blank"}
                  rel="noreferrer"
                >
                  {children}
                </a>
              );
            }
            const path = href.replace(/^\.?\//, "").replace(/#.*$/, "");
            return (
              <Link className="gm-link" to={blobUrl(owner, name, refName, path)}>
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
