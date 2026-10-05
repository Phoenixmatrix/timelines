// The Markdown half of the autolinker (CORE-22): a remark plugin that marks
// candidate refs in prose as `gm-ref` elements, and the component that
// renders them. Code (inline and fenced), existing links and their text,
// images and raw HTML are left alone. A bare URL GFM linked is a candidate
// only when it has the shape of a tracker issue URL; until the server says
// it's ours and openable, it stays the link it was.

import { useMemo, type ReactNode } from "react";
import type { Components, Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { refKind, splitRefs, type RefContext } from "../../shared/refs.ts";
import { useRefContext } from "./context.ts";
import { RefNode } from "./RefLink.tsx";
import { contextKey } from "./resolver.ts";

/** The parts of mdast this plugin reads (react-markdown's tree). */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** Nodes whose text is never scanned. */
const SKIP = new Set([
  "code",
  "inlineCode",
  "html",
  "image",
  "imageReference",
  "definition",
  "linkReference",
  "footnoteDefinition",
]);

/** The element a candidate becomes; RefMarkdown components render it. */
export const REF_ELEMENT = "gm-ref";

function refNode(ref: string, kind: string, href?: string): MdNode {
  return {
    type: "gmRef",
    data: {
      hName: REF_ELEMENT,
      hProperties: { dataRef: ref, dataKind: kind, ...(href ? { dataHref: href } : {}) },
    },
    children: [{ type: "text", value: ref }],
  };
}

function transform(node: MdNode, commits: boolean) {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (SKIP.has(child.type)) {
      next.push(child);
    } else if (child.type === "link") {
      // A bare tracker URL (GFM's literal autolink: its text is its address).
      const only = child.children?.length === 1 ? child.children[0] : undefined;
      if (
        child.url &&
        only?.type === "text" &&
        only.value === child.url &&
        refKind(child.url) === "issue-url"
      )
        next.push(refNode(child.url, "issue-url", child.url));
      else next.push(child);
    } else if (child.type === "text" && child.value) {
      for (const piece of splitRefs(child.value, { commits }))
        next.push(
          piece.span ? refNode(piece.text, piece.span.kind) : { type: "text", value: piece.text },
        );
    } else {
      transform(child, commits);
      next.push(child);
    }
  }
  node.children = next;
}

/**
 * remark plugin: mark refs in prose. Hashes are candidates only with a
 * repository in context (`commits`).
 */
export function remarkRefs(options: { commits?: boolean } = {}) {
  return (tree: MdNode) => transform(tree, !!options.commits);
}

/**
 * The `gm-ref` renderer: links resolved refs; anything else renders as
 * written (a bare URL as `external`, its usual link).
 */
export function refElement(
  context: RefContext | undefined,
  external: (href: string, children: ReactNode) => ReactNode,
) {
  return function GmRef(props: Record<string, unknown>) {
    const ref = props["data-ref"];
    const text = typeof ref === "string" ? ref : "";
    const href = props["data-href"];
    return (
      <RefNode
        text={text}
        context={context}
        fallback={typeof href === "string" ? external(href, text) : undefined}
      />
    );
  };
}

/**
 * What a Markdown renderer adds to autolink refs: GFM plus remarkRefs, and the
 * `gm-ref` component (merge it into the renderer's own components). The
 * context is the page's unless `override` names one. `external` renders a
 * bare URL as the renderer would without refs; keep it a stable function.
 */
export function useRefMarkdown(
  external: (href: string, children: ReactNode) => ReactNode,
  override?: RefContext,
): { remarkPlugins: NonNullable<Options["remarkPlugins"]>; components: Components } {
  const context = useRefContext(override);
  const key = contextKey(context);
  return useMemo(
    () => ({
      remarkPlugins: [remarkGfm, [remarkRefs, { commits: !!context.repo }]],
      components: { [REF_ELEMENT]: refElement(context, external) } as Components,
    }),
    // context is fully described by key; external is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
}
