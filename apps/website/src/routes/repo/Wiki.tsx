import { BookOpenTextIcon } from "@phosphor-icons/react";
import { NavLink, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { WikiCatalog, WikiPage } from "../../../shared/api.ts";
import { KnowledgeStatusPill, useKnowledgeStatus } from "../../components/KnowledgeStatus.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { Mermaid } from "../../components/Mermaid.tsx";
import { api, ApiError, load } from "../../lib/api.ts";
import { timeAgo } from "../../lib/format.ts";
import { repoPath } from "../../lib/refs.ts";
import { useRepo } from "./RepoLayout.tsx";

export async function wikiLoader({ request, params }: LoaderFunctionArgs) {
  const base = `/repos/${params.owner}/${params.repo}/knowledge`;
  const slug = params["*"] || "overview";
  const [catalog, page] = await Promise.all([
    load<WikiCatalog>(`${base}/wiki`, request),
    api<WikiPage>(`${base}/wiki/page?slug=${encodeURIComponent(slug)}`).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }),
  ]);
  return { catalog, page, slug };
}

function Sidebar({ catalog, owner, name }: { catalog: WikiCatalog; owner: string; name: string }) {
  const sections = new Map<string, WikiCatalog["pages"]>();
  for (const page of catalog.pages)
    sections.set(page.section, [...(sections.get(page.section) ?? []), page]);
  return (
    <nav aria-label="Wiki pages" className="flex flex-col gap-5">
      {[...sections].map(([section, pages]) => (
        <div key={section}>
          <div className="mk-menu-label px-2.5 pt-0">{section}</div>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {pages.map((page) => (
              <li key={page.slug}>
                <NavLink
                  to={repoPath(owner, name, "wiki", page.slug)}
                  end
                  className="block truncate rounded-plate px-2.5 py-1.5 text-body-sm text-ink-muted no-underline hover:bg-pane hover:text-ink aria-[current=page]:bg-raised aria-[current=page]:font-semibold aria-[current=page]:text-ink"
                >
                  {page.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function Wiki() {
  const { catalog, page } = useLoaderData<typeof wikiLoader>();
  const repo = useRepo();
  const status = useKnowledgeStatus(repo.owner.slug, repo.name, catalog.status);

  if (catalog.pages.length === 0) {
    return (
      <div className="mk-empty flex flex-col items-center gap-3 py-12">
        <BookOpenTextIcon size={28} className="text-ink-faint" aria-hidden />
        <div>
          The wiki is written from this repository's knowledge graph.
          <br />
          <span className="text-body-sm text-ink-faint">
            {status.state === "empty"
              ? "Push a commit to start it."
              : "The first version is on its way."}
          </span>
        </div>
        <KnowledgeStatusPill status={status} />
      </div>
    );
  }

  return (
    <div className="grid gap-8 md:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="md:sticky md:top-6 md:self-start">
        <Sidebar catalog={catalog} owner={repo.owner.slug} name={repo.name} />
      </aside>
      <article className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-headline">{page?.title ?? "Page not found"}</h2>
          <KnowledgeStatusPill status={status} />
        </div>
        {page ? (
          <>
            <Markdown
              text={page.body}
              owner={repo.owner.slug}
              name={repo.name}
              refName={page.generatedIn}
            />
            {page.diagram && (
              <section className="mt-8">
                <h3 className="mt-0 mb-3 text-title">
                  {page.slug === "architecture" ? "Component map" : "How the files connect"}
                </h3>
                <Mermaid code={page.diagram} />
              </section>
            )}
            <p className="mt-8 mb-0 border-t border-line-soft pt-3 text-micro text-ink-faint">
              Written from commit <span className="mk-mono">{page.generatedIn.slice(0, 7)}</span>{" "}
              {timeAgo(page.updatedAt)}
              {page.model ? ` by ${page.model.replace("@cf/", "")}` : ""}. Pages are rewritten when
              the code they describe changes.
            </p>
          </>
        ) : (
          <div className="mk-empty">That page doesn't exist (yet). Pick one from the list.</div>
        )}
      </article>
    </div>
  );
}
