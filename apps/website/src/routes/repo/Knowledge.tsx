/*
 * DIRECTION (impeccable, locked: atlas)
 *
 * THESIS       The codebase as territory. Components are regions, folders
 *              districts, files plots, symbols lots, laid out once and kept
 *              still so places become familiar. Semantic zoom shows only what
 *              fits; search flies you there; the inspector reads where you
 *              land. Refuses the page of cards that stopped at the first
 *              screen of a large graph.
 * OWN-WORLD    MatrixKit Neo: warm charcoal panes, amber only for the
 *              selection outline and focus, data hues for links (teal uses,
 *              violet used by) and berry for what the latest build changed.
 * STORY        Land on the whole map with region names; hover to see what a
 *              file touches; search a name or a question; read the summary
 *              and the wiki page in the inspector; follow a link and fly on.
 * FIRST VIEW   One status line, then the map filling the height with search
 *              floating top-left and zoom top-right, the inspector at right.
 * FORM         atlas, seed key dd61c7d6. Signature: one canvas with semantic
 *              zoom from regions to symbols, links lit on hover, fly-to on
 *              every selection.
 * FINISH       unreviewed and undocumented is unfinished; this build ends with
 *              the finish review, the verdict, DESIGN.md, and every shipping
 *              raster carrying its provenance
 */

import {
  BookOpenTextIcon,
  CaretDownIcon,
  CaretUpIcon,
  MagnifyingGlassIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import {
  Link,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import type {
  GraphLink,
  GraphNodeDetail,
  KnowledgeMap,
  KnowledgeOverlay,
  KnowledgeOverlaySummary,
  KnowledgeSearchResults,
  KnowledgeStatus,
  WikiCatalog,
} from "../../../shared/api.ts";
import { KnowledgeStatusPill, useKnowledgeStatus } from "../../components/KnowledgeStatus.tsx";
import { link } from "../../components/ui.tsx";
import { load } from "../../lib/api.ts";
import { timeAgo } from "../../lib/format.ts";
import { blobUrl, repoPath } from "../../lib/refs.ts";
import { scopeOf, withScope } from "../../lib/timelineScope.ts";
import { AtlasMap, KIND_LABEL } from "./AtlasMap.tsx";
import { useRepo } from "./RepoLayout.tsx";
import { OverlayPanel, TimelinePicker } from "./TimelineOverlay.tsx";

// The map and wiki catalog change only when a build lands: keep the parsed
// copy for this repository and commit, so moving around never refetches it.
let cached: {
  repo: string;
  version: string;
  map: KnowledgeMap;
  wiki: WikiCatalog["pages"];
} | null = null;

export async function knowledgeLoader({ request, params }: LoaderFunctionArgs) {
  const base = `/repos/${params.owner}/${params.repo}/knowledge`;
  const repo = `${params.owner}/${params.repo}`;
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const nodeId = url.searchParams.get("node") ?? "repo";
  // The app-wide timeline scope (?tl=; the old ?timeline= is rewritten to it).
  const timeline = scopeOf(url.search);
  const reuse = cached?.repo === repo ? cached : null;
  const [status, fresh, search, detail, overlays, overlay] = await Promise.all([
    load<KnowledgeStatus>(`${base}/status`, request),
    reuse
      ? null
      : Promise.all([
          load<KnowledgeMap>(`${base}/graph/map`, request),
          load<WikiCatalog>(`${base}/wiki`, request),
        ]),
    q ? load<KnowledgeSearchResults>(`${base}/search?q=${encodeURIComponent(q)}`, request) : null,
    load<GraphNodeDetail>(`${base}/graph/node?id=${encodeURIComponent(nodeId)}`, request).catch(
      () => null,
    ),
    // Timelines' graph diffs against main (CORE-83).
    load<{ overlays: KnowledgeOverlaySummary[] }>(`${base}/overlays`, request)
      .then((r) => r.overlays)
      .catch(() => [] as KnowledgeOverlaySummary[]),
    timeline
      ? load<KnowledgeOverlay>(
          `${base}/overlay?ref=${encodeURIComponent(`timeline/${timeline}`)}`,
          request,
        ).catch(() => null)
      : null,
  ]);
  let current = fresh
    ? { repo, version: fresh[0].version, map: fresh[0], wiki: fresh[1].pages }
    : reuse!;
  if (!fresh && status.graphVersion !== reuse!.version) {
    const [map, wiki] = await Promise.all([
      load<KnowledgeMap>(`${base}/graph/map`, request),
      load<WikiCatalog>(`${base}/wiki`, request),
    ]);
    current = { repo, version: map.version, map, wiki: wiki.pages };
  }
  cached = current;
  // An entry the latest build dropped falls back to the repository overview.
  const missing = !detail && nodeId !== "repo";
  const shown = missing
    ? await load<GraphNodeDetail>(`${base}/graph/node?id=repo`, request).catch(() => null)
    : detail;
  return {
    status,
    q,
    search,
    detail: shown,
    missing,
    map: current.map,
    wiki: current.wiki,
    overlays,
    overlay,
  };
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

const VERBS: Record<string, [string, string]> = {
  contains: ["Contains", "Part of"],
  defines: ["Defines", "Defined in"],
  imports: ["Uses", "Used by"],
  depends_on: ["Depends on", "Depended on by"],
  mentions: ["Talks about", "Discussed in"],
  part_of: ["Part of", "Includes"],
  documents: ["Documents", "Documented by"],
};

function LinkGroup({
  title,
  links,
  href,
}: {
  title: string;
  links: GraphLink[];
  href: (id: string) => string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? links : links.slice(0, 6);
  return (
    <section className="border-t border-line-soft py-3">
      <h3 className="m-0 mb-1 flex items-baseline gap-2 text-body-sm font-semibold">
        {title}
        <span className="font-mono text-mono font-normal text-ink-faint tabular-nums">
          {links.length}
        </span>
      </h3>
      <ul className="m-0 list-none p-0">
        {shown.map((l) => (
          <li key={l.node.id}>
            <Link
              to={href(l.node.id)}
              className="-mx-2 flex h-8 items-center gap-2 rounded-plate px-2 text-body-sm text-ink no-underline hover:bg-raised"
              title={l.node.summary || l.node.path || l.node.name}
            >
              <span className="w-[4.5rem] shrink-0 truncate text-micro text-ink-faint">
                {KIND_LABEL[l.node.kind] ?? l.node.kind}
              </span>
              <span className="min-w-0 flex-1 truncate">{l.node.name}</span>
              {l.weight > 1 && (
                <span className="font-mono text-micro text-ink-faint">×{l.weight}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {links.length > 6 && (
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm -ml-2"
          onClick={() => setAll(!all)}
        >
          {all ? "Fewer" : `${links.length - 6} more`}
        </button>
      )}
    </section>
  );
}

function Inspector({
  detail,
  status,
  wiki,
  href,
}: {
  detail: GraphNodeDetail;
  status: KnowledgeStatus;
  wiki: WikiCatalog["pages"];
  href: (id: string) => string;
}) {
  const repo = useRepo();
  const { node } = detail;
  const data = node.data;
  const ref = status.indexedCommit ?? repo.defaultBranch;
  const page =
    wiki.find((p) => p.nodeId === node.id) ?? (node.kind === "repository" ? wiki[0] : undefined);
  const facts = [
    data.role && text(data.role),
    data.language && text(data.language),
    typeof data.lines === "number" && `${data.lines.toLocaleString()} lines`,
    typeof data.files === "number" && `${data.files.toLocaleString()} files`,
    data.kind && node.kind === "symbol" && `${text(data.kind)}${data.exported ? ", exported" : ""}`,
    Array.isArray(data.techStack) &&
      data.techStack.length > 0 &&
      (data.techStack as string[]).join(" · "),
    Array.isArray(data.aliases) &&
      data.aliases.length > 0 &&
      `Also: ${(data.aliases as string[]).join(", ")}`,
  ].filter(Boolean) as string[];
  const responsibilities = Array.isArray(data.responsibilities)
    ? (data.responsibilities as string[])
    : [];
  const keyFiles = Array.isArray(data.keyFiles)
    ? (data.keyFiles as { path: string; why: string }[])
    : [];
  const groups = (links: GraphLink[], direction: 0 | 1) => {
    const byKind = new Map<string, GraphLink[]>();
    for (const l of links) {
      // The map already shows what a region contains; listing it repeats it.
      if (node.kind === "repository" && l.kind === "contains") continue;
      byKind.set(l.kind, [...(byKind.get(l.kind) ?? []), l]);
    }
    return [...byKind].map(([kind, items]) => (
      <LinkGroup
        key={`${direction}-${kind}`}
        title={(VERBS[kind] ?? [kind, kind])[direction]}
        links={items}
        href={href}
      />
    ));
  };

  return (
    <article aria-label={node.name} className="flex flex-col">
      <header className="pb-3 pr-10 lg:pr-0">
        <h2 className="m-0 text-title break-words">{node.name}</h2>
        <span className="block text-micro text-ink-faint">
          {KIND_LABEL[node.kind] ?? node.kind}
        </span>
        {node.path && node.kind === "file" && (
          <Link
            className={`${link} mt-0.5 inline-block font-mono text-mono break-all`}
            to={blobUrl(repo.owner.slug, repo.name, ref, node.path)}
          >
            {node.path}
          </Link>
        )}
        {node.path && node.kind === "symbol" && (
          <Link
            className={`${link} mt-0.5 inline-block font-mono text-mono break-all`}
            to={href(`file:${node.path}`)}
          >
            {node.path}:{text(data.line)}
          </Link>
        )}
        {node.path && (node.kind === "component" || node.kind === "directory") && (
          <span className="mt-0.5 block font-mono text-mono text-ink-faint">
            {node.path || "/"}
          </span>
        )}
      </header>
      {page && (
        <Link
          to={repoPath(repo.owner.slug, repo.name, "wiki", page.slug)}
          className="mb-3 flex items-center gap-2 rounded-control bg-raised px-3 py-2 text-body-sm text-ink no-underline hover:bg-surface"
        >
          <BookOpenTextIcon className="size-4 shrink-0 text-ink-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-ink-muted">Wiki: </span>
            {page.title}
          </span>
        </Link>
      )}
      {node.summary ? (
        <p className="m-0 max-w-[48ch] text-body-sm">{node.summary}</p>
      ) : (
        <p className="m-0 text-body-sm text-ink-faint">
          No description{data.skipped ? ` (${text(data.skipped)})` : ""}.
        </p>
      )}
      {facts.length > 0 && (
        <p className="mt-2 mb-0 text-micro text-ink-faint">{facts.join(" · ")}</p>
      )}
      {responsibilities.length > 0 && (
        <ul className="mt-3 mb-0 list-disc pl-4 text-body-sm text-ink-muted marker:text-ink-faint">
          {responsibilities.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {keyFiles.length > 0 && (
        <section className="mt-3 border-t border-line-soft py-3">
          <h3 className="m-0 mb-1 text-body-sm font-semibold">Key files</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-body-sm">
            {keyFiles.map((k) => (
              <li key={k.path}>
                <Link
                  className={`${link} font-mono text-mono break-all`}
                  to={href(`file:${k.path}`)}
                >
                  {k.path}
                </Link>
                <span className="block text-ink-muted">{k.why}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className={keyFiles.length ? "" : "mt-3"}>
        {groups(detail.outgoing, 0)}
        {groups(detail.incoming, 1)}
      </div>
      <p className="mt-2 mb-0 border-t border-line-soft pt-3 text-micro text-ink-faint">
        Changed in <span className="font-mono">{node.changedIn.slice(0, 7)}</span>
      </p>
    </article>
  );
}

/** Instant name matches from the map; Enter with nothing picked asks the search index. */
function AtlasSearch({
  map,
  q,
  onPick,
  onAsk,
}: {
  map: KnowledgeMap;
  q: string;
  onPick: (node: number) => void;
  onAsk: (q: string) => void;
}) {
  const [value, setValue] = useState(q);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const term = value.trim().toLowerCase();
  const matches = useMemo(() => {
    if (term.length < 2) return [];
    const scored: [number, number][] = [];
    const rank: Record<string, number> = {
      component: 0,
      file: 1,
      directory: 2,
      concept: 3,
      symbol: 4,
      package: 5,
    };
    for (const [i, [, kind, name, path]] of map.nodes.entries()) {
      const n = name.toLowerCase();
      const score =
        n === term
          ? 0
          : n.startsWith(term)
            ? 1
            : n.includes(term)
              ? 2
              : path?.toLowerCase().includes(term)
                ? 3
                : -1;
      if (score >= 0) scored.push([i, score * 10 + (rank[kind] ?? 6)]);
    }
    return scored
      .sort((a, b) => a[1] - b[1])
      .slice(0, 8)
      .map(([i]) => i);
  }, [map, term]);
  const listId = "atlas-search-list";
  const narrow = typeof window !== "undefined" && window.innerWidth < 640;
  const pick = (i: number) => {
    setOpen(false);
    setActive(-1);
    onPick(i);
  };
  return (
    <form
      role="search"
      className="relative w-full max-w-[26rem]"
      onSubmit={(e) => {
        e.preventDefault();
        if (active >= 0 && matches[active] !== undefined) pick(matches[active]);
        else if (term) {
          setOpen(false);
          onAsk(value.trim());
        }
      }}
    >
      <MagnifyingGlassIcon
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
        aria-hidden
      />
      <input
        ref={input}
        className="mk-input h-10 w-full bg-pane pl-9 shadow-[var(--shadow-float)]"
        role="combobox"
        aria-expanded={open && term.length >= 2}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        aria-label="Find a file, symbol or concept, or ask a question"
        placeholder={narrow ? "Find or ask…" : "Find a file, or ask: where are tokens checked?"}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(matches.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(-1, a - 1));
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && term.length >= 2 && (
        <ul
          id={listId}
          role="listbox"
          className="mk-popup absolute inset-x-0 top-11 z-10 m-0 list-none p-1"
        >
          {matches.map((i, at) => {
            const [, kind, name, path] = map.nodes[i]!;
            return (
              <li
                key={i}
                id={`${listId}-${at}`}
                role="option"
                aria-selected={active === at}
                className="flex h-9 cursor-pointer items-center gap-2 rounded-plate px-2 text-body-sm aria-selected:bg-raised hover:bg-raised"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i);
                }}
              >
                <span className="w-[4.5rem] shrink-0 text-micro text-ink-faint">
                  {KIND_LABEL[kind]}
                </span>
                <span className="shrink-0 font-semibold">{name}</span>
                {path && path !== name && (
                  <span className="min-w-0 truncate font-mono text-micro text-ink-faint">
                    {path}
                  </span>
                )}
              </li>
            );
          })}
          <li
            role="option"
            aria-selected={false}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-plate px-2 text-body-sm text-ink-muted hover:bg-raised"
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen(false);
              onAsk(value.trim());
            }}
          >
            <MagnifyingGlassIcon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
              Search meaning and passages for <span className="text-ink">“{value.trim()}”</span>
            </span>
          </li>
        </ul>
      )}
    </form>
  );
}

function SearchPanel({
  search,
  map,
  byId,
  onPick,
  onClose,
}: {
  search: KnowledgeSearchResults;
  map: KnowledgeMap;
  byId: Map<string, number>;
  onPick: (node: number) => void;
  onClose: () => void;
}) {
  const repo = useRepo();
  return (
    <section
      aria-label={`Results for ${search.query}`}
      className="mk-popup mt-2 flex max-h-[min(30rem,calc(100%-5rem))] w-full max-w-[26rem] flex-col overflow-hidden p-0"
    >
      <header className="flex items-center gap-2 border-b border-line-soft py-1 pr-1 pl-3">
        <h2 className="m-0 min-w-0 flex-1 truncate text-body-sm font-semibold">“{search.query}”</h2>
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
          aria-label="Close the results"
          onClick={onClose}
        >
          <XIcon weight="bold" />
        </button>
      </header>
      <div className="min-h-0 overflow-y-auto p-1">
        {search.entities.length === 0 && search.passages.length === 0 && (
          <p className="m-0 p-3 text-body-sm text-ink-muted">
            Nothing matches. Try a name, or describe the behavior.
          </p>
        )}
        {search.entities.length > 0 && (
          <ul className="m-0 list-none p-0">
            {search.entities.map((e) => {
              const at = byId.get(e.id);
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    disabled={at === undefined}
                    className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-plate border-0 bg-transparent px-2 py-1.5 text-left text-ink hover:bg-raised disabled:cursor-default"
                    onClick={() => at !== undefined && onPick(at)}
                  >
                    <span className="flex w-full items-baseline gap-2">
                      <span className="w-[4.5rem] shrink-0 text-micro text-ink-faint">
                        {KIND_LABEL[e.kind]}
                      </span>
                      <span className="min-w-0 truncate text-body-sm font-semibold">{e.name}</span>
                    </span>
                    {e.summary && (
                      <span className="line-clamp-2 pl-[5rem] text-micro text-ink-muted">
                        {e.summary}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {search.passages.length > 0 && (
          <>
            <h3 className="m-0 mt-2 px-2 pb-1 text-label text-ink-faint">Passages</h3>
            <ul className="m-0 list-none p-0">
              {search.passages.map((p, i) => {
                const at = p.kind === "code" ? byId.get(`file:${p.path}`) : undefined;
                return (
                  <li key={`${p.path}-${i}`} className="rounded-plate px-2 py-1.5 hover:bg-raised">
                    {at !== undefined ? (
                      <button
                        type="button"
                        className="cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-micro text-ink hover:underline"
                        onClick={() => onPick(at)}
                      >
                        {p.path}
                      </button>
                    ) : (
                      <Link
                        className="font-mono text-micro text-ink"
                        to={
                          p.kind === "wiki"
                            ? repoPath(repo.owner.slug, repo.name, "wiki", p.path)
                            : blobUrl(repo.owner.slug, repo.name, repo.defaultBranch, p.path)
                        }
                      >
                        {p.kind === "wiki" ? `Wiki · ${p.path}` : p.path}
                      </Link>
                    )}
                    <p className="m-0 mt-0.5 line-clamp-2 font-mono text-micro text-ink-muted">
                      {p.text.slice(0, 240)}
                    </p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      <p className="m-0 border-t border-line-soft px-3 py-1.5 text-micro text-ink-faint">
        {search.entities.length} entities · {search.passages.length} passages ·{" "}
        {map.nodes.length.toLocaleString()} in the map
      </p>
    </section>
  );
}

export function Knowledge() {
  const {
    status: initial,
    q,
    search,
    detail,
    missing,
    map,
    wiki,
    overlays,
    overlay,
  } = useLoaderData<typeof knowledgeLoader>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const repo = useRepo();
  const status = useKnowledgeStatus(repo.owner.slug, repo.name, initial);
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const byId = useMemo(() => new Map(map.nodes.map((n, i) => [n[0], i])), [map]);
  const selected = detail ? (byId.get(detail.node.id) ?? null) : null;
  // Search hits, and what the selected timeline changes or removes.
  const hits = useMemo(
    () =>
      new Set([
        ...(search?.entities ?? []).flatMap((e) => byId.get(e.id) ?? []),
        ...(overlay?.changes ?? []).flatMap((c) => byId.get(c.id) ?? []),
      ]),
    [search, overlay, byId],
  );
  const base = repoPath(repo.owner.slug, repo.name, "knowledge");
  const href = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("node", id);
    return `${base}?${next}`;
  };
  const pick = (node: number) => navigate(href(map.nodes[node]![0]), { preventScrollReset: true });
  const counts = status.counts;
  const searching = navigation.state === "loading" && navigation.location.search.includes("q=");

  if (map.nodes.length === 0)
    return (
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <KnowledgeStatusPill status={status} />
        </div>
        <div className="mk-empty">
          Nothing indexed yet. The map builds automatically after each push.
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="m-0 min-w-0 flex-1 text-body-sm text-ink-muted tabular-nums max-sm:hidden">
          {["component", "file", "symbol", "concept", "package"]
            .filter((k) => counts[k])
            .map(
              (k) =>
                `${counts[k]!.toLocaleString()} ${KIND_LABEL[k]!.toLowerCase()}${counts[k] === 1 ? "" : "s"}`,
            )
            .join(" · ")}
          {status.indexedAt && (
            <span className="text-ink-faint"> · indexed {timeAgo(status.indexedAt)}</span>
          )}
        </p>
        {(overlays.length > 0 || overlay) && (
          <TimelinePicker
            overlays={overlays}
            value={scopeOf(params)}
            onChange={(timeline) => {
              // Choosing here switches the whole app's scope, as the switcher does.
              void navigate(withScope(`${base}?${params}`, timeline), { preventScrollReset: true });
            }}
          />
        )}
        <Link
          className="mk-btn mk-btn--ghost mk-btn--sm no-underline"
          to={repoPath(repo.owner.slug, repo.name, "wiki")}
        >
          <BookOpenTextIcon weight="bold" aria-hidden />
          Wiki
        </Link>
        <KnowledgeStatusPill status={status} />
      </div>
      <div className="grid gap-3 lg:h-[max(34rem,calc(100dvh-16rem))] lg:grid-cols-[minmax(0,1fr)_23rem]">
        <div
          className="grid h-[72dvh] min-h-[24rem] max-lg:mb-20 lg:h-auto lg:min-h-0"
          aria-busy={searching}
        >
          <AtlasMap map={map} selected={selected} hits={hits} onSelect={pick}>
            <AtlasSearch
              key={q}
              map={map}
              q={q}
              onPick={pick}
              onAsk={(query) => {
                const next = new URLSearchParams(params);
                next.set("q", query);
                void navigate(`${base}?${next}`, { preventScrollReset: true });
              }}
            />
            {search && (
              <SearchPanel
                search={search}
                map={map}
                byId={byId}
                onPick={pick}
                onClose={() => {
                  const next = new URLSearchParams(params);
                  next.delete("q");
                  void navigate(`${base}?${next}`, { preventScrollReset: true });
                }}
              />
            )}
          </AtlasMap>
        </div>
        {/* Below lg the inspector is a sheet over the map: it peeks with the
            selected name, and expands to read. */}
        <aside
          aria-label="Inspector"
          data-open={sheetOpen || undefined}
          className="min-h-0 overflow-y-auto rounded-pane bg-pane px-4 py-4 max-lg:fixed max-lg:inset-x-2 max-lg:bottom-2 max-lg:z-30 max-lg:max-h-[4.75rem] max-lg:overflow-hidden max-lg:pt-3 max-lg:shadow-[var(--shadow-float),0_0_0_1px_var(--line-soft)] max-lg:data-open:max-h-[65dvh] max-lg:data-open:overflow-y-auto"
        >
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm absolute top-2 right-2 lg:hidden"
            aria-expanded={sheetOpen}
            aria-label={sheetOpen ? "Collapse the inspector" : "Expand the inspector"}
            onClick={() => setSheetOpen(!sheetOpen)}
          >
            {sheetOpen ? <CaretDownIcon weight="bold" /> : <CaretUpIcon weight="bold" />}
          </button>
          {overlay && <OverlayPanel overlay={overlay} href={href} inMap={(id) => byId.has(id)} />}
          {missing && (
            <p className="m-0 mb-3 text-body-sm text-ink-muted">
              That entry isn't in the latest build. Here's the repository instead.
            </p>
          )}
          {detail ? (
            <Inspector
              key={detail.node.id}
              detail={detail}
              status={status}
              wiki={wiki}
              href={href}
            />
          ) : (
            <p className="m-0 text-body-sm text-ink-muted">Pick something on the map.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
