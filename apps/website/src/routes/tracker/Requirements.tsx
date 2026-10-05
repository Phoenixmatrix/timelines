// What an issue requires of the agent that works on it (CORE-32), in the
// inspector: requirements as chips, edited in place, and which of the
// tracker's agents meet them. Pickup policy still applies to both people
// and explicit assignments.

import { useState } from "react";
import { CheckIcon, XIcon } from "@phosphor-icons/react";
import {
  hasRequirements,
  parseRequirements,
  RequirementError,
  requirementTerms,
  requirementsText,
  unmetRequirements,
  withoutTerm,
  type IssueRequirements,
} from "../../../shared/requirements.ts";
import {
  attribution,
  issuePickup,
  ISSUE_PICKUPS,
  type Issue,
  type Snapshot,
} from "../../../shared/tracker.ts";
import { agentEligible } from "../../../shared/tracker-query.ts";
import { FormError } from "../../components/ui.tsx";
import { Actor } from "./Actor.tsx";
import type { Mutate } from "./IssueDetail.tsx";

/** The list and board mark: the issue asks something of the agents that take it. */
export function RequiresMark({ requires }: { requires: IssueRequirements | null | undefined }) {
  if (!hasRequirements(requires)) return null;
  const text = requirementsText(requires);
  return (
    <span
      className="mk-chip mk-chip--tag mr-1.5 align-[1px]"
      title={`Agents need: ${text}`}
      aria-label={`Requires ${text}`}
    >
      Requires
    </span>
  );
}

/** "needs tag ux; needs …": an agent's unmet requirements, if any. */
function mismatch(issue: Issue, snapshot: Snapshot, actorId: string | null | undefined) {
  const agent = actorId ? snapshot.agents.find((a) => a.id === actorId) : undefined;
  if (!agent) return null;
  const unmet = unmetRequirements(issue.requires, agent.capabilities);
  return unmet.length ? { agent, unmet } : null;
}

export function Requirements({
  issue,
  snapshot,
  mutate,
  busy,
}: {
  issue: Issue;
  snapshot: Snapshot;
  mutate: Mutate;
  busy: boolean;
}) {
  const [adding, setAdding] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const terms = requirementTerms(issue.requires);
  const save = async (requires: IssueRequirements | null) => {
    setSaving(true);
    setError("");
    const result = await mutate([
      { kind: "issue.update", id: issue.id, expectedVersion: issue.version, data: { requires } },
    ]);
    setSaving(false);
    if (!result.ok) setError(result.error);
    return result.ok;
  };
  const add = async () => {
    let requires: IssueRequirements | null;
    try {
      requires = parseRequirements(`${requirementsText(issue.requires)} ${adding}`);
    } catch (cause) {
      setError(cause instanceof RequirementError ? cause.message : String(cause));
      return;
    }
    if (await save(requires)) setAdding("");
  };
  const agents = snapshot.agents.filter((agent) => agent.revokedAt === null);
  const assigned = mismatch(issue, snapshot, issue.assigneeId);
  const holder = issue.claim ? mismatch(issue, snapshot, issue.claim.actorId) : null;
  const disabled = busy || saving;
  const pickup = issuePickup(issue);
  return (
    <section className="border-t border-line-soft py-4" aria-label="Agent requirements">
      <h3 className="m-0 text-body-sm font-semibold">Agent requirements</h3>
      <p className="mt-1 mb-2 text-body-sm text-ink-muted">
        {pickup !== "anyone"
          ? `${ISSUE_PICKUPS[pickup]}: agents cannot pick up this issue, even when assigned. A person must change Pickup to Anyone first.`
          : terms.length
            ? "Agents need these capabilities unless explicitly assigned. People do not need an agent profile. Pickup and readiness rules still apply."
            : "No agent capability requirements. Add what an agent must report in its profile (gm agent setup), such as tag:ux or memory>=16GiB."}
      </p>
      {terms.length > 0 && (
        <ul className="m-0 mb-2 flex list-none flex-wrap gap-1 p-0" aria-label="Requirements">
          {terms.map((term) => (
            <li key={term} className="mk-chip mk-chip--tag gap-1 font-mono text-mono">
              {term}
              <button
                type="button"
                className="inline-flex cursor-pointer items-center border-0 bg-transparent p-0 text-ink-faint hover:text-ink disabled:cursor-default"
                aria-label={`Remove ${term}`}
                disabled={disabled}
                onClick={() => void save(withoutTerm(issue.requires, term))}
              >
                <XIcon className="size-3" weight="bold" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (adding.trim()) void add();
        }}
      >
        <input
          className="mk-input min-w-0 flex-1 font-mono text-mono"
          aria-label="Add requirements"
          placeholder="tag:ux model:claude-* memory>=16GiB"
          value={adding}
          disabled={disabled}
          onChange={(event) => {
            setAdding(event.target.value);
            setError("");
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="mk-btn mk-btn--sm" disabled={disabled || !adding.trim()}>
          Add
        </button>
      </form>
      <FormError message={error} />
      {assigned && (
        <p className="mt-3 mb-0 rounded-control bg-sunken px-3 py-2 text-body-sm" role="note">
          Assigned to {assigned.agent.name}, which doesn't meet them:{" "}
          {assigned.unmet.map((u) => u.message).join("; ")}.{" "}
          {pickup === "anyone"
            ? "Assignment overrides capability requirements, but readiness rules still apply."
            : "Assignment does not override the pickup restriction."}
        </p>
      )}
      {holder && holder.agent.id !== assigned?.agent.id && (
        <p className="mt-3 mb-0 rounded-control bg-sunken px-3 py-2 text-body-sm" role="note">
          {holder.agent.name} holds it but doesn't meet them:{" "}
          {holder.unmet.map((u) => u.message).join("; ")}.
        </p>
      )}
      {terms.length > 0 && agents.length > 0 && (
        <>
          <h4 className="mt-4 mb-1 text-label text-ink-faint">Eligible agents</h4>
          <ul className="m-0 list-none p-0" aria-label="Agent eligibility">
            {agents.map((agent) => {
              const unmet = unmetRequirements(issue.requires, agent.capabilities);
              const exempt = unmet.length > 0 && issue.assigneeId === agent.id;
              const eligible = agentEligible(issue, agent);
              return (
                <li
                  key={agent.id}
                  className="flex items-start gap-2 border-b border-line-soft py-1.5 text-body-sm last:border-b-0"
                  data-eligible={eligible ? "true" : "false"}
                >
                  {eligible && unmet.length === 0 ? (
                    <CheckIcon
                      className="mt-1 size-3 shrink-0 text-online"
                      weight="bold"
                      aria-hidden
                    />
                  ) : (
                    <XIcon
                      className="mt-1 size-3 shrink-0 text-ink-faint"
                      weight="bold"
                      aria-hidden
                    />
                  )}
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <Actor who={attribution(snapshot, agent.id)} />
                    <span className="text-ink-muted">
                      {pickup !== "anyone"
                        ? ` · ${ISSUE_PICKUPS[pickup]}: agents cannot pick up`
                        : unmet.length === 0
                          ? " · Eligible"
                          : ` · ${exempt ? "Assigned, so it may claim anyway; " : ""}${unmet.map((u) => u.message).join("; ")}`}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
