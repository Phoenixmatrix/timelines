// What the workspace Atlas (CORE-184) adds to the shared inspector
// (repo/AtlasInspector.tsx): capabilities spanning repositories and the
// cross-repository links of a capability (CORE-167).
//
// A composite has no prose of its own. Its name comes from the concepts its
// members share; each member keeps its own repository's summary; its files
// are counted once each, in the member capability that holds them. Why its
// members belong together is a resolved dependency (one imports a package the
// other repository publishes) plus shared concepts, and the evidence is the
// importing files and the publishing repository at immutable commits.
//
// Cross-repository links are three different things, never blurred:
// `resolved` dependencies with that evidence, `unresolved` package imports
// (no selected repository publishes it, or several do) and `related`
// capabilities, which only share concepts: similarity, not a dependency.
// Every list is a bounded page pinned to the composite on screen.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type {
  AtlasCompositeCapability,
  AtlasCrossLink,
  AtlasDirection,
  AtlasEntitySummary,
  AtlasFileRef,
  AtlasLinkState,
  AtlasResolutionRule,
} from "../../../shared/atlas.ts";
import { atlasWorkspaceApi, type AtlasPageOf, type AtlasWorkspace } from "../../lib/atlas.ts";
import { blobUrl } from "../../lib/refs.ts";

const short = (sha: string) => sha.slice(0, 7);
const files = (n: number) => `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;

const RULE: Record<AtlasResolutionRule, string> = {
  "npm-name": "the npm package name",
  "cargo-crate": "the crate name",
  "pypi-module": "the Python module name",
  "go-module": "the Go module path",
};

const STATE_LABEL: Record<AtlasLinkState, string> = {
  resolved: "Dependencies",
  unresolved: "Unresolved imports",
  related: "Related",
};

/** Repository names by id, for the scope on screen. */
export type RepoNames = ReadonlyMap<string, string>;

/** A source file at an indexed commit, linked to that commit (never a branch). */
function FileAt({ space, names, file }: { space: string; names: RepoNames; file: AtlasFileRef }) {
  const repo = names.get(file.repoId);
  if (!repo) return <span className="font-mono">{file.path}</span>;
  return (
    <Link
      to={blobUrl(space, repo, file.commit, file.path, file.sourceId ?? "canonical")}
      className="min-w-0 truncate font-mono text-ink-muted hover:text-ink pointer-coarse:py-2.5"
      title={`${repo}/${file.path} at ${short(file.commit)}`}
    >
      {repo}/{file.path}
    </Link>
  );
}

/**
 * The cross-repository links of a capability (or a repository's unclassified
 * files), or, with `direction: "in"` on a repository's root, the resolved
 * dependencies on it. `state` is the page's (in the address) or fixed.
 */
export function CrossLinks({
  workspace,
  snapshot,
  entity,
  names,
  state,
  direction = "out",
  heading = "Across repositories",
  onState,
  onPick,
  onFailed,
}: {
  workspace: AtlasWorkspace;
  /** The composite snapshot on screen. */
  snapshot: string;
  entity: Pick<AtlasEntitySummary, "id" | "kind" | "name">;
  names: RepoNames;
  state: AtlasLinkState;
  direction?: AtlasDirection;
  heading?: string;
  /** Offer the other states; without it, only `state` is shown. */
  onState?: (state: AtlasLinkState) => void;
  onPick: (entity: AtlasEntitySummary) => void;
  onFailed: (error: unknown) => void;
}) {
  const [page, setPage] = useState<{
    key: string;
    status: "loading" | "ready" | "error";
    items: AtlasCrossLink[];
    counts: AtlasPageOf<AtlasCrossLink>["counts"] | null;
    next: string | null;
    error?: string;
  } | null>(null);
  const key = `${snapshot}|${entity.id}|${state}|${direction}`;
  const generation = useRef(0);
  const run = (cursor: string | null, previous: AtlasCrossLink[]) => {
    const mine = ++generation.current;
    const controller = new AbortController();
    if (!cursor) setPage({ key, status: "loading", items: [], counts: null, next: null });
    atlasWorkspaceApi
      .links(workspace, entity.id, state, {
        snapshot,
        direction,
        cursor,
        limit: 10,
        signal: controller.signal,
      })
      .then((p) => {
        if (mine !== generation.current) return;
        setPage({
          key,
          status: "ready",
          items: [...previous, ...p.items],
          counts: p.counts,
          next: p.next,
        });
      })
      .catch((error: unknown) => {
        if (mine !== generation.current || controller.signal.aborted) return;
        onFailed(error);
        setPage({
          key,
          status: "error",
          items: previous,
          counts: null,
          next: null,
          error: error instanceof Error ? error.message : "Couldn't load these links.",
        });
      });
    return () => controller.abort();
  };
  useEffect(() => run(null, []), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = page?.key === key ? page : null;
  const states: AtlasLinkState[] =
    direction === "in"
      ? ["resolved"]
      : entity.kind === "capability"
        ? ["resolved", "unresolved", "related"]
        : ["resolved", "unresolved"];

  return (
    <section aria-label={heading} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 mr-auto text-label text-ink-muted">{heading}</h3>
        {onState && states.length > 1 && (
          <div role="group" aria-label="Kind of cross-repository link" className="flex gap-1">
            {states.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={state === s}
                className="mk-chip cursor-pointer border-0 aria-pressed:bg-signal-wash aria-pressed:text-ink pointer-coarse:min-h-11"
                onClick={() => onState(s)}
              >
                {STATE_LABEL[s]}
              </button>
            ))}
          </div>
        )}
      </div>
      {(!current || current.status === "loading") && (
        <p role="status" className="m-0 text-body-sm text-ink-faint">
          Loading links across repositories…
        </p>
      )}
      {current?.status === "error" && (
        <p className="m-0 text-body-sm text-danger-text" role="alert">
          Couldn't load these links.{" "}
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--sm"
            onClick={() => run(null, [])}
          >
            Retry
          </button>
        </p>
      )}
      {current?.status === "ready" && current.items.length === 0 && (
        <p className="m-0 text-body-sm text-ink-faint">
          {state === "resolved"
            ? direction === "in"
              ? "No other selected repository has an indexed import of a package this one publishes."
              : "No indexed import here resolves to a package another selected repository publishes. That isn't proof of independence: resolution depends on this selection and on what each build recorded."
            : state === "unresolved"
              ? "Every package import here either resolves or stays inside its repository."
              : "No capability in another selected repository shares its concepts."}
        </p>
      )}
      {current && current.items.length > 0 && (
        <ul
          className="m-0 flex list-none flex-col gap-2 p-0"
          aria-label={`${STATE_LABEL[state]} of ${entity.name}`}
        >
          {current.items.map((link) => (
            <CrossLinkRow
              key={`${link.src}|${link.dst}|${link.package?.name ?? ""}`}
              space={workspace.space}
              names={names}
              link={link}
              direction={direction}
              onPick={onPick}
            />
          ))}
        </ul>
      )}
      {current?.counts && current.items.length > 0 && (
        <p className="m-0 text-micro text-ink-faint">
          {current.counts.knownTotal === null
            ? `${current.items.length.toLocaleString()} loaded`
            : `${current.items.length.toLocaleString()} of ${current.counts.knownTotal.toLocaleString()}`}
        </p>
      )}
      {current?.next && (
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm self-start"
          onClick={() => run(current.next, current.items)}
        >
          Show more
        </button>
      )}
      {state === "related" && (
        <p className="m-0 text-micro text-ink-faint">
          Related capabilities only share concepts: similarity, not an import, call or dependency.
        </p>
      )}
    </section>
  );
}

function CrossLinkRow({
  space,
  names,
  link,
  direction,
  onPick,
}: {
  space: string;
  names: RepoNames;
  link: AtlasCrossLink;
  direction: AtlasDirection;
  onPick: (entity: AtlasEntitySummary) => void;
}) {
  const other = link.neighbor;
  const otherRepo = other?.repoId ? names.get(other.repoId) : undefined;
  const target = other ? (
    <button
      type="button"
      className="cursor-pointer rounded-plate border-0 bg-transparent p-0 text-left font-semibold text-ink hover:underline pointer-coarse:min-h-11"
      onClick={() => onPick(other)}
    >
      {other.kind === "repository" ? (otherRepo ?? other.name) : other.name}
    </button>
  ) : null;
  const pkg = link.package ? (
    <span className="font-mono">
      {link.package.ecosystem}:{link.package.name}
    </span>
  ) : null;

  if (link.state === "related")
    return (
      <li className="flex flex-col gap-0.5 text-body-sm">
        <span>
          <span className="mk-chip mk-chip--tag mr-1.5">Related</span>
          {target}
          {otherRepo && <span className="text-ink-faint"> in {otherRepo}</span>}
        </span>
        <span className="text-micro text-ink-muted">
          Shares {link.concepts?.map((c) => c.name).join(", ") || "concepts"}; not a dependency.
        </span>
      </li>
    );

  if (link.state === "unresolved")
    return (
      <li className="flex flex-col gap-0.5 text-body-sm">
        <span>
          <span className="mk-chip mk-chip--tag mr-1.5">Unresolved</span>
          {pkg}
        </span>
        <span className="text-micro text-ink-muted">
          {link.unresolved ? `Imported by ${files(link.unresolved.files)}. ` : ""}
          {link.unresolved?.reason === "ambiguous"
            ? `Several selected repositories publish it (${link.unresolved.candidates
                .map((id) => names.get(id) ?? "another repository")
                .join(", ")}), so it isn't resolved to one.`
            : "No selected repository publishes it: it's external, or published from outside this selection."}
        </span>
      </li>
    );

  const evidence = link.evidence;
  const publisher = evidence ? names.get(evidence.publisher.repoId) : undefined;
  const publish = evidence?.publisher.publish;
  return (
    <li className="flex flex-col gap-1 text-body-sm">
      <span>
        <span className="mk-chip mk-chip--tag mr-1.5">Resolved</span>
        {direction === "in" ? (
          <>
            Used by {target}
            {otherRepo && <span className="text-ink-faint"> in {otherRepo}</span>}, through {pkg}
          </>
        ) : (
          <>
            Depends on {target ?? publisher ?? "another repository"} through {pkg}
          </>
        )}
      </span>
      {evidence && (
        <>
          <span className="text-micro text-ink-muted">
            The registry names {publisher ?? "that repository"} a source of{" "}
            <span className="font-mono">{evidence.publisher.registry.name}</span> in the{" "}
            {evidence.publisher.registry.feed} {evidence.publisher.registry.format} feed
            {publish
              ? `, last published as ${publish.version}${
                  publish.commit ? ` from ${short(publish.commit)}` : ""
                }${publish.runNumber !== null ? ` (CI #${publish.runNumber})` : ""}`
              : ""}
            ; matched by {RULE[evidence.publisher.rule]}.
          </span>
          <span className="text-micro text-ink-muted">
            Imported by {files(evidence.importers.total)} at{" "}
            {evidence.importers.files[0] ? short(evidence.importers.files[0].commit) : "its commit"}
            :
          </span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 pl-2 text-micro">
            {evidence.importers.files.map((f) => (
              <li key={`${f.repoId}|${f.path}`} className="flex min-w-0">
                <FileAt space={space} names={names} file={f} />
              </li>
            ))}
          </ul>
          {evidence.manifest && (
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-1 text-micro text-ink-faint">
              Nearest manifest: <FileAt space={space} names={names} file={evidence.manifest} />
              <span>(located by path; the Atlas doesn't read it)</span>
            </span>
          )}
        </>
      )}
    </li>
  );
}

/** A capability spanning repositories: its members, shared concepts and why they're one. */
export function CompositeInspector({
  workspace,
  snapshot,
  composite,
  names,
  autoFocus = false,
  onPick,
  onFailed,
}: {
  workspace: AtlasWorkspace;
  snapshot: string;
  composite: AtlasCompositeCapability;
  names: RepoNames;
  autoFocus?: boolean;
  onPick: (entity: AtlasEntitySummary) => void;
  onFailed: (error: unknown) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (autoFocus) heading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on showing only
  }, []);
  const member = new Map(composite.members.map((m) => [m.id, m]));
  const repos = composite.repos.map((id) => names.get(id) ?? "another repository");
  const sources = [...new Set(composite.rationale.map((r) => r.from))];
  return (
    <section
      aria-label={`Inspector: ${composite.name}`}
      className="flex flex-col gap-3 border-b border-line-soft pb-3"
    >
      <div className="flex flex-col gap-1">
        <h2 ref={heading} tabIndex={-1} className="m-0 text-body font-semibold break-words">
          {composite.name}
        </h2>
        <p className="m-0 text-micro text-ink-faint">
          Capability across repositories · spans {repos.join(" and ")}
        </p>
      </div>
      <p className="m-0 text-body-sm text-ink-muted tabular-nums">
        {files(composite.counts.files)} in {composite.counts.capabilities} capabilities, each file
        counted once, in the capability that holds it in its own repository.
      </p>
      <p className="m-0 text-micro text-ink-faint">
        {composite.nameSource === "concepts"
          ? "Named from the concepts its members share, not written by a model."
          : "Named after its largest member: its members share no concept name."}{" "}
        Each member keeps its own repository's summary; nothing here mixes them.
      </p>

      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-label text-ink-muted">In each repository</h3>
        <ul className="m-0 flex list-none flex-col p-0" aria-label={`Members of ${composite.name}`}>
          {composite.members.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onPick(m)}
                className="flex min-h-9 w-full cursor-pointer items-baseline gap-2 rounded-plate border-0 bg-transparent px-2 py-1 text-left hover:bg-raised pointer-coarse:min-h-11"
              >
                <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{m.name}</span>
                <span className="text-micro text-ink-faint">
                  {m.repoId ? names.get(m.repoId) : ""}
                  {m.counts.files !== undefined ? ` · ${files(m.counts.files)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {composite.concepts.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-label text-ink-muted">Shared concepts</h3>
          <p className="m-0 flex flex-wrap gap-1">
            {composite.concepts.map((c) => (
              <span key={c.id} className="mk-chip mk-chip--tag">
                {c.name} · {c.members} members
              </span>
            ))}
          </p>
        </div>
      )}

      {composite.rationale.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-label text-ink-muted">Why it's one capability</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-micro text-ink-muted">
            {composite.rationale.map((r) => (
              <li key={`${r.from}|${r.to}`}>
                {member.get(r.from)?.name ?? "A member"} (
                {names.get(r.from.slice(0, r.from.indexOf("/"))) ?? "a repository"}) imports{" "}
                <span className="font-mono">{r.packages.map((p) => p.name).join(", ")}</span>, which{" "}
                {names.get(r.publisher) ?? "another repository"} publishes; it shares{" "}
                {r.concepts.map((c) => c.name).join(", ") || "concepts"} with{" "}
                {member.get(r.to)?.name ?? "a member"} there.
              </li>
            ))}
          </ul>
        </div>
      )}

      {sources.map((id) => {
        const from = member.get(id);
        return from ? (
          <CrossLinks
            key={id}
            workspace={workspace}
            snapshot={snapshot}
            entity={from}
            names={names}
            state="resolved"
            heading={`Evidence: ${from.name}'s dependencies`}
            onPick={onPick}
            onFailed={onFailed}
          />
        ) : null;
      })}
    </section>
  );
}
