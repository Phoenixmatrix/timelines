import { BookOpenTextIcon, MapTrifoldIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLoaderData, useLocation, type LoaderFunctionArgs } from "react-router";
import type { KnowledgeTimelinePage, WikiCatalog, WikiPage } from "../../../shared/api.ts";
import { KnowledgeStatusPill, useKnowledgeStatus } from "../../components/KnowledgeStatus.tsx";
import { Markdown, outline } from "../../components/Markdown.tsx";
import { Mermaid } from "../../components/Mermaid.tsx";
import { FileRow, RailSection, railClass } from "../../components/Rail.tsx";
import { api, ApiError, load } from "../../lib/api.ts";
import { timeAgo } from "../../lib/format.ts";
import { blobUrl, repoPath } from "../../lib/refs.ts";
import { scopeOf, withScope } from "../../lib/timelineScope.ts";
import { setLabel } from "../../components/TimelinePages.tsx";
import { useRepo } from "./RepoLayout.tsx";

export async function wikiLoader({ request, params }: LoaderFunctionArgs) {
  const base = `/repos/${params.owner}/${params.repo}/knowledge`;
  const slug = params["*"] || "overview";
  // Scoped to a timeline: its own version of the page, where it wrote one
  // (CORE-84), from `set` or its newest set that has it.
  const url = new URL(request.url);
  const timeline = scopeOf(url.search);
  const set = url.searchParams.get("set");
  const missing = (error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  };
  const [catalog, page, timelinePage] = await Promise.all([
    load<WikiCatalog>(`${base}/wiki`, request),
    api<WikiPage>(`${base}/wiki/page?slug=${encodeURIComponent(slug)}`).catch(missing),
    timeline
      ? api<KnowledgeTimelinePage>(
          `${base}/overlay/page?ref=${encodeURIComponent(`timeline/${timeline}`)}&slug=${encodeURIComponent(slug)}${set ? `&set=${encodeURIComponent(set)}` : ""}`,
        ).catch(missing)
      : null,
  ]);
  return { catalog, page, slug, timelinePage };
}

/** Which version of the page this is, when the timeline has its own. */
function TimelineNote({
  page,
  owner,
  name,
}: {
  page: KnowledgeTimelinePage;
  owner: string;
  name: string;
}) {
  const main = withScope(repoPath(owner, name, "wiki", page.slug), null);
  return (
    <p className="m-0 mb-4 rounded-plate border border-line-soft bg-raised px-3 py-2 text-body-sm text-ink-muted">
      {page.outcome === "written" ? (
        <>
          Timeline <code className="mk-mono">{page.timeline}</code>'s version of this page, written
          at {setLabel(page.set)}. It describes the code as the timeline leaves it.{" "}
        </>
      ) : (
        <>
          Timeline <code className="mk-mono">{page.timeline}</code> changes what this page covers,
          but main's page still holds.{" "}
        </>
      )}
      <Link to={main}>Main's page</Link>
    </p>
  );
}

function Sidebar({ catalog, owner, name }: { catalog: WikiCatalog; owner: string; name: string }) {
  const [filter, setFilter] = useState("");
  const term = filter.trim().toLowerCase();
  const sections = new Map<string, WikiCatalog["pages"]>();
  for (const page of catalog.pages)
    if (
      !term ||
      page.title.toLowerCase().includes(term) ||
      page.section.toLowerCase().includes(term)
    )
      sections.set(page.section, [...(sections.get(page.section) ?? []), page]);
  return (
    <nav aria-label="Wiki pages" className="flex flex-col gap-5">
      {catalog.pages.length > 12 && (
        <input
          className="mk-input h-9"
          type="search"
          aria-label="Filter pages"
          placeholder={`Filter ${catalog.pages.length} pages`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {sections.size === 0 && (
        <p className="m-0 px-2.5 text-body-sm text-ink-muted">No page matches.</p>
      )}
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

const diagramTitle = (page: WikiPage) =>
  page.slug === "architecture" ? "Component map" : "How the files connect";

/** On this page (from xl), the files the page was written from, and when. */
function PageRail({ page, owner, name }: { page: WikiPage; owner: string; name: string }) {
  const headings = useMemo(() => outline(page.body), [page.body]);
  const contents = page.diagram
    ? [...headings, { depth: 2 as const, text: diagramTitle(page), id: "diagram" }]
    : headings;
  return (
    <>
      {contents.length > 1 && (
        <RailSection title="On this page" className="max-xl:hidden">
          <ul className="m-0 list-none p-0">
            {contents.map((heading) => (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  className={`-mx-2 block truncate rounded-plate px-2 py-1 text-body-sm text-ink-muted no-underline transition-colors hover:bg-raised hover:text-ink ${heading.depth === 3 ? "pl-5" : ""}`}
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ul>
        </RailSection>
      )}
      {page.sources.length > 0 && (
        <RailSection title="Sources" count={page.sources.length}>
          <ul className="m-0 list-none p-0">
            {page.sources.map((path) => (
              <FileRow key={path} to={blobUrl(owner, name, page.generatedIn, path)} path={path} />
            ))}
          </ul>
        </RailSection>
      )}
      <p className="m-0 border-t border-line-soft pt-3 text-micro text-ink-faint">
        Written from commit <span className="mk-mono">{page.generatedIn.slice(0, 7)}</span>{" "}
        {timeAgo(page.updatedAt)}
        {page.model ? ` by ${page.model.replace("@cf/", "")}` : ""}. Pages are rewritten when the
        code they describe changes.
      </p>
    </>
  );
}

export function Wiki() {
  const { catalog, page: mainPage, timelinePage } = useLoaderData<typeof wikiLoader>();
  const page: WikiPage | null = timelinePage?.outcome === "written" ? timelinePage : mainPage;
  const repo = useRepo();
  const status = useKnowledgeStatus(repo.owner.slug, repo.name, catalog.status);
  const { hash } = useLocation();

  // The page renders after its loader, so the browser's own jump to #heading
  // on load finds nothing; do it once the page is there.
  useEffect(() => {
    if (hash.length > 1)
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [hash, page?.slug]);

  if (catalog.pages.length === 0) {
    return (
      <div className="mk-empty flex max-w-[44rem] flex-col items-center gap-3 py-12">
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
        <KnowledgeStatusPill status={status} repo={{ owner: repo.owner.slug, name: repo.name }} />
      </div>
    );
  }

  return (
    <div className="grid gap-x-8 gap-y-8 md:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,46rem)_minmax(15rem,19rem)] xl:gap-x-12">
      <aside className="md:row-span-3 md:sticky md:top-[calc(var(--scope-banner)+1.5rem)] md:max-h-[calc(100dvh-3rem-var(--scope-banner))] md:self-start md:overflow-y-auto">
        <Sidebar catalog={catalog} owner={repo.owner.slug} name={repo.name} />
      </aside>
      <article className="min-w-0 md:col-start-2 [&_h2]:scroll-mt-6 [&_h3]:scroll-mt-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-headline">{page?.title ?? "Page not found"}</h2>
          <div className="flex items-center gap-2">
            {page?.nodeId && (
              <Link
                className="mk-btn mk-btn--ghost mk-btn--sm no-underline"
                to={`${repoPath(repo.owner.slug, repo.name, "knowledge")}?select=${encodeURIComponent(page.nodeId)}`}
              >
                <MapTrifoldIcon weight="bold" aria-hidden />
                Show on the map
              </Link>
            )}
            <KnowledgeStatusPill
              status={status}
              repo={{ owner: repo.owner.slug, name: repo.name }}
            />
          </div>
        </div>
        {timelinePage && (
          <TimelineNote page={timelinePage} owner={repo.owner.slug} name={repo.name} />
        )}
        {page ? (
          <Markdown
            text={page.body}
            owner={repo.owner.slug}
            name={repo.name}
            refName={page.generatedIn}
          />
        ) : (
          <div className="mk-empty max-w-[44rem]">
            That page doesn't exist (yet). Pick one from the list.
          </div>
        )}
      </article>
      {page?.diagram && (
        <section id="diagram" className="min-w-0 scroll-mt-6 md:col-start-2 xl:col-span-2">
          <h3 className="mt-0 mb-3 text-title">{diagramTitle(page)}</h3>
          <Mermaid code={page.diagram} />
        </section>
      )}
      {page && (
        <aside
          aria-label="About this page"
          className={`md:col-start-2 xl:col-start-3 xl:row-start-1 ${railClass}`}
        >
          <PageRail page={page} owner={repo.owner.slug} name={repo.name} />
        </aside>
      )}
    </div>
  );
}
