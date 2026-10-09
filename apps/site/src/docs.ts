// The docs sidebar and pager (CORE-115): Markdown pages by section and order,
// then the generated gm reference.
import { getCollection, type CollectionEntry } from "astro:content";

export interface DocLink {
  title: string;
  href: string;
}
export interface DocSection {
  title: string;
  links: DocLink[];
}

const SECTIONS = ["Start", "Concepts"] as const;
export const REFERENCE: DocLink = { title: "gm commands", href: "/docs/gm/" };

/** Where a docs page lives: `index` is /docs/, `concepts/ci` is /docs/concepts/ci/. */
export function docHref(entry: Pick<CollectionEntry<"docs">, "id">): string {
  return entry.id === "index" ? "/docs/" : `/docs/${entry.id}/`;
}

export async function docSections(): Promise<DocSection[]> {
  const entries = await getCollection("docs");
  const sections: DocSection[] = SECTIONS.map((title) => ({
    title,
    links: entries
      .filter((entry) => entry.data.section === title)
      .sort((a, b) => a.data.order - b.data.order)
      .map((entry) => ({ title: entry.data.title, href: docHref(entry) })),
  }));
  sections.push({ title: "Reference", links: [REFERENCE] });
  return sections;
}

/** The pages before and after `href`, reading the sidebar top to bottom. */
export function neighbours(sections: DocSection[], href: string) {
  const all = sections.flatMap((section) => section.links);
  const at = all.findIndex((link) => link.href === href);
  return { previous: at > 0 ? all[at - 1] : undefined, next: at >= 0 ? all[at + 1] : undefined };
}
