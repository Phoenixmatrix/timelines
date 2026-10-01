import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Form, Link, useLoaderData, useNavigation, type LoaderFunctionArgs } from "react-router";
import type {
  GraphLink,
  GraphNode,
  GraphNodeDetail,
  KnowledgeSearchResults,
  KnowledgeStatus,
} from "../../../shared/api.ts";
import { KnowledgeStatusPill, useKnowledgeStatus } from "../../components/KnowledgeStatus.tsx";
import { load } from "../../lib/api.ts";
import { timeAgo } from "../../lib/format.ts";
import { blobUrl, repoPath } from "../../lib/refs.ts";
import { useRepo } from "./RepoLayout.tsx";

export async function knowledgeLoader({ request, params }: LoaderFunctionArgs) {
  const base = `/repos/${params.owner}/${params.repo}/knowledge`;
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const nodeId = url.searchParams.get("node") ?? (q ? null : "repo");
  const [status, search, detail, components] = await Promise.all([
    load<KnowledgeStatus>(`${base}/status`, request),
    q ? load<KnowledgeSearchResults>(`${base}/search?q=${encodeURIComponent(q)}`, request) : null,
    nodeId
      ? load<GraphNodeDetail>(`${base}/graph/node?id=${encodeURIComponent(nodeId)}`, request).catch(
          () => null,
        )
      : null,
    !q && nodeId === "repo"
      ? load<{ nodes: GraphNode[] }>(`${base}/graph?kind=component&limit=200`, request)
      : null,
  ]);
  return { status, q, search, detail, components: components?.nodes ?? [] };
}

const KIND_LABEL: Record<string, string> = {
  repository: "Repository",
  directory: "Folder",
  file: "File",
  symbol: "Symbol",
  package: "Package",
  concept: "Concept",
  component: "Component",
};

function nodeHref(owner: string, name: string, id: string) {
  return `${repoPath(owner, name, "knowledge")}?node=${encodeURIComponent(id)}`;
}

/** A node data value as display text ("" for anything that isn't a plain value). */
function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function NodeChip({ kind }: { kind: string }) {
  return <span className="mk-chip mk-chip--tag shrink-0">{KIND_LABEL[kind] ?? kind}</span>;
}

function LinkGroups({ links, direction }: { links: GraphLink[]; direction: "out" | "in" }) {
  const repo = useRepo();
  const groups = new Map<string, GraphLink[]>();
  for (const link of links) groups.set(link.kind, [...(groups.get(link.kind) ?? []), link]);
  const verb: Record<string, [string, string]> = {
    contains: ["Contains", "Part of"],
    defines: ["Defines", "Defined in"],
    imports: ["Imports", "Imported by"],
    depends_on: ["Depends on", "Used by"],
    mentions: ["Talks about", "Discussed in"],
    part_of: ["Part of", "Includes"],
  };
  return (
    <>
      {[...groups].map(([kind, items]) => (
        <section key={`${direction}-${kind}`} className="rounded-pane bg-pane">
          <h3 className="m-0 border-b border-line-soft px-4 py-2.5 text-body-sm font-semibold text-ink-muted">
            {(verb[kind] ?? [kind, kind])[direction === "out" ? 0 : 1]}{" "}
            <span className="font-normal text-ink-faint">{items.length}</span>
          </h3>
          <ul className="m-0 max-h-80 list-none divide-y divide-line-soft overflow-y-auto p-0">
            {items.map((link) => (
              <li key={link.node.id}>
                <Link
                  to={nodeHref(repo.owner.slug, repo.name, link.node.id)}
                  className="flex items-start gap-3 px-4 py-2 text-ink no-underline hover:bg-raised"
                >
                  <NodeChip kind={link.node.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{link.node.name}</span>
                    {link.node.summary && (
                      <span className="block truncate text-body-sm text-ink-muted">
                        {link.node.summary}
                      </span>
                    )}
                  </span>
                  {link.weight > 1 && (
                    <span className="mk-mono text-mono text-ink-faint">×{link.weight}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function NodeView({ detail, status }: { detail: GraphNodeDetail; status: KnowledgeStatus }) {
  const repo = useRepo();
  const { node } = detail;
  const data = node.data;
  const facts = [
    data.role && `Role: ${text(data.role)}`,
    data.language && `Language: ${text(data.language)}`,
    typeof data.lines === "number" && `${data.lines} lines`,
    typeof data.files === "number" && `${data.files} files`,
    data.kind && node.kind === "symbol" && `${text(data.kind)}${data.exported ? ", exported" : ""}`,
    Array.isArray(data.techStack) &&
      data.techStack.length > 0 &&
      (data.techStack as string[]).join(" · "),
    Array.isArray(data.aliases) &&
      data.aliases.length > 0 &&
      `Also called: ${(data.aliases as string[]).join(", ")}`,
    Array.isArray(data.topics) &&
      data.topics.length > 0 &&
      `Topics: ${(data.topics as string[]).join(", ")}`,
  ].filter(Boolean) as string[];
  const responsibilities = Array.isArray(data.responsibilities)
    ? (data.responsibilities as string[])
    : [];
  const keyFiles = Array.isArray(data.keyFiles)
    ? (data.keyFiles as { path: string; why: string }[])
    : [];
  const ref = status.indexedCommit ?? repo.defaultBranch;

  return (
    <div className="flex flex-col gap-5">
      <section className="mk-card">
        <div className="flex flex-wrap items-center gap-2">
          <NodeChip kind={node.kind} />
          <h2 className="m-0 text-title-lg">{node.name}</h2>
        </div>
        {node.path && node.kind === "file" && (
          <Link
            className="gm-link mk-mono mt-1 inline-block text-mono"
            to={blobUrl(repo.owner.slug, repo.name, ref, node.path)}
          >
            {node.path}
          </Link>
        )}
        {node.path && node.kind === "symbol" && (
          <Link
            className="gm-link mk-mono mt-1 inline-block text-mono"
            to={nodeHref(repo.owner.slug, repo.name, `file:${node.path}`)}
          >
            {node.path}:{text(data.line)}
          </Link>
        )}
        {node.summary ? (
          <p className="mt-3 mb-0 max-w-[70ch]">{node.summary}</p>
        ) : (
          <p className="mt-3 mb-0 text-ink-faint">
            No description{data.skipped ? ` (${text(data.skipped)})` : ""}.
          </p>
        )}
        {facts.length > 0 && (
          <p className="mt-2 mb-0 text-body-sm text-ink-faint">{facts.join(" · ")}</p>
        )}
        {responsibilities.length > 0 && (
          <ul className="mt-3 mb-0 list-disc pl-5 text-body-sm text-ink-muted">
            {responsibilities.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {keyFiles.length > 0 && (
          <div className="mt-4">
            <div className="mk-label">Key files</div>
            <ul className="m-0 mt-1 list-none p-0 text-body-sm">
              {keyFiles.map((k) => (
                <li key={k.path}>
                  <Link
                    className="gm-link mk-mono text-mono"
                    to={nodeHref(repo.owner.slug, repo.name, `file:${k.path}`)}
                  >
                    {k.path}
                  </Link>{" "}
                  <span className="text-ink-muted">{k.why}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-4 mb-0 text-micro text-ink-faint">
          Last changed in <span className="mk-mono">{node.changedIn.slice(0, 7)}</span> · id{" "}
          <span className="mk-mono">{node.id}</span>
        </p>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <LinkGroups
          links={detail.outgoing.filter(
            (l) =>
              !(node.kind === "repository" && l.kind === "contains" && l.node.kind === "directory"),
          )}
          direction="out"
        />
        <LinkGroups links={detail.incoming} direction="in" />
      </div>
    </div>
  );
}

function SearchResults({ search }: { search: KnowledgeSearchResults }) {
  const repo = useRepo();
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section>
        <h2 className="mt-0 mb-3 text-title">Entities</h2>
        {search.entities.length === 0 ? (
          <div className="mk-empty">No matching entities.</div>
        ) : (
          <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
            {search.entities.map((e) => (
              <li key={e.id}>
                <Link
                  to={nodeHref(repo.owner.slug, repo.name, e.id)}
                  className="flex items-start gap-3 px-4 py-3 text-ink no-underline hover:bg-raised"
                >
                  <NodeChip kind={e.kind} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{e.name}</span>
                    {e.path && e.path !== e.name && (
                      <span className="mk-mono block truncate text-mono text-ink-faint">
                        {e.path}
                      </span>
                    )}
                    <span className="line-clamp-2 text-body-sm text-ink-muted">{e.summary}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="mt-0 mb-3 text-title">Passages</h2>
        {search.passages.length === 0 ? (
          <div className="mk-empty">No matching passages.</div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {search.passages.map((p, i) => (
              <li key={`${p.path}-${i}`} className="rounded-pane bg-pane">
                <Link
                  to={
                    p.kind === "wiki"
                      ? repoPath(repo.owner.slug, repo.name, "wiki", p.path)
                      : blobUrl(repo.owner.slug, repo.name, repo.defaultBranch, p.path)
                  }
                  className="flex items-center gap-2 border-b border-line-soft px-4 py-2 text-body-sm text-ink no-underline hover:bg-raised"
                >
                  <span className="mk-chip mk-chip--tag">
                    {p.kind === "wiki" ? "Wiki" : "Code"}
                  </span>
                  <span className="mk-mono truncate text-mono">{p.path}</span>
                </Link>
                <pre className="m-0 max-h-40 overflow-hidden px-4 py-2 font-mono text-[0.75rem] leading-5 whitespace-pre-wrap text-ink-muted">
                  {p.text.slice(0, 600)}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function Knowledge() {
  const {
    status: initial,
    q,
    search,
    detail,
    components,
  } = useLoaderData<typeof knowledgeLoader>();
  const repo = useRepo();
  const status = useKnowledgeStatus(repo.owner.slug, repo.name, initial);
  const navigation = useNavigation();
  const searching = navigation.state === "loading" && navigation.location.search.includes("q=");
  const counts = status.counts;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Form method="get" className="flex min-w-0 flex-1 gap-2">
          <label className="mk-search min-w-0 flex-1">
            <MagnifyingGlassIcon className="mk-icon" aria-hidden />
            <input
              className="mk-input"
              name="q"
              defaultValue={q}
              placeholder="Ask about this codebase: where are tokens checked?"
              aria-label="Search the knowledge graph"
            />
          </label>
          <button className="mk-btn" disabled={searching}>
            {searching ? "Searching…" : "Search"}
          </button>
        </Form>
        <KnowledgeStatusPill status={status} />
      </div>

      {Object.keys(counts).length > 0 && !q && (
        <p className="m-0 text-body-sm text-ink-faint">
          {["component", "file", "symbol", "concept", "package"]
            .filter((k) => counts[k])
            .map((k) => `${counts[k]} ${KIND_LABEL[k]?.toLowerCase()}${counts[k] === 1 ? "" : "s"}`)
            .join(" · ")}
          {status.indexedAt && ` · indexed ${timeAgo(status.indexedAt)}`}
        </p>
      )}

      {search && <SearchResults search={search} />}
      {!search && detail && <NodeView detail={detail} status={status} />}
      {!search && !detail && (
        <div className="mk-empty">
          Nothing indexed yet.
          <br />
          <span className="text-body-sm text-ink-faint">
            The graph builds automatically after each push.
          </span>
        </div>
      )}

      {!search && detail?.node.id === "repo" && components.length > 0 && (
        <section>
          <h2 className="mt-0 mb-3 text-title">Components</h2>
          <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
            {components.map((c) => (
              <li key={c.id}>
                <Link
                  to={nodeHref(repo.owner.slug, repo.name, c.id)}
                  className="block h-full rounded-pane bg-pane p-4 text-ink no-underline hover:bg-raised"
                >
                  <span className="block font-semibold">{c.name}</span>
                  <span className="mk-mono block text-mono text-ink-faint">{c.path || "/"}</span>
                  <span className="mt-1 line-clamp-3 text-body-sm text-ink-muted">
                    {c.summary || "Summary on its way…"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!search && detail?.node.id === "repo" && status.recent.length > 0 && (
        <section>
          <h2 className="mt-0 mb-3 text-title">Recent updates</h2>
          <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0 text-body-sm">
            {status.recent.map((b) => {
              const s = b.stats as Record<string, number>;
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                  <span className="mk-mono text-mono">{b.toCommit.slice(0, 7)}</span>
                  <span className={b.status === "failed" ? "text-danger-text" : "text-ink-muted"}>
                    {b.status === "running" ? `running: ${b.phase}` : b.status}
                  </span>
                  <span className="text-ink-faint">
                    {[
                      s.changedFiles !== undefined && `${s.changedFiles} files changed`,
                      s.analyzed !== undefined && `${s.analyzed} analyzed`,
                      s.reused ? `${s.reused} cosmetic` : null,
                      s.graphChanged !== undefined &&
                        `${(s.graphAdded ?? 0) + (s.graphChanged ?? 0) + (s.graphRemoved ?? 0)} graph changes`,
                      s.pagesWritten !== undefined && `${s.pagesWritten} pages rewritten`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span className="ml-auto text-ink-faint">
                    {b.finishedAt
                      ? `${Math.round((Date.parse(b.finishedAt) - Date.parse(b.startedAt)) / 1000)}s · ${timeAgo(b.finishedAt)}`
                      : timeAgo(b.startedAt)}
                  </span>
                  {b.error && <span className="w-full text-danger-text">{b.error}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
