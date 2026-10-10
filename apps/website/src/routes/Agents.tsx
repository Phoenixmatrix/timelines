// Your agents: identities that work on their own, accountable to you.

import { CheckIcon, KeyIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { Form, Link, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import type { Agent, AgentCapabilities, CreatedAccessToken } from "../../shared/api.ts";
import { filterToken, type AgentEligibility } from "../../shared/tracker-query.ts";
import { AgentTagChip } from "../components/Chips.tsx";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { Card, ConfirmDialog, CopyField, FormError, TextField } from "../components/ui.tsx";
import { api, attempt, field, load } from "../lib/api.ts";
import { fullDate, timeAgo } from "../lib/format.ts";
import { requireViewer } from "../lib/session.ts";

export async function agentsLoader({ request }: { request: Request }) {
  await requireViewer(request);
  const [{ agents }, eligibility] = await Promise.all([
    load<{ agents: Agent[] }>("/agents", request),
    // Which tracker work each agent can take (CORE-32); the page works without it.
    api<AgentEligibility>("/agent-eligibility", { signal: request.signal }).catch(
      (): AgentEligibility => ({ trackers: [] }),
    ),
  ]);
  return { agents, eligibility };
}

type Result = { created: Agent } | { token: CreatedAccessToken; agent: string } | { error: string };

export async function agentsAction({ request }: { request: Request }): Promise<Result | null> {
  const form = await request.formData();
  const intent = form.get("intent");
  const id = intent === "create" ? "" : field(form, "id");
  if (intent === "revoke-token")
    return attempt(async () => {
      await api(`/agents/${id}/tokens/${field(form, "tokenId")}`, { method: "DELETE" });
      return null;
    });
  if (intent === "revoke")
    return attempt(async () => {
      await api(`/agents/${id}`, { method: "DELETE" });
      return null;
    });
  if (intent === "token")
    return attempt(async () => ({
      token: await api<CreatedAccessToken>(`/agents/${id}/tokens`, { method: "POST", json: {} }),
      agent: field(form, "name"),
    }));
  return attempt(async () => ({
    created: (
      await api<{ agent: Agent }>("/agents", {
        method: "POST",
        json: { name: form.get("name"), description: form.get("description") },
      })
    ).agent,
  }));
}

export function Agents() {
  const { agents, eligibility } = useLoaderData<typeof agentsLoader>();
  const result = useActionData<Result | null | undefined>();
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement>(null);
  const fresh = result && "token" in result ? result : null;
  const error = result && "error" in result ? result.error : null;
  const creating = navigation.formData?.get("intent") === "create";

  useEffect(() => {
    if (result && "created" in result) formRef.current?.reset();
  }, [result]);

  return (
    <SettingsPage>
      <h1 className="m-0 text-headline">Agents</h1>
      <p className="mt-1.5 mb-0 max-w-[48ch] text-ink-muted">
        An agent works on its own: it claims tracker work, comments and checkpoints as itself, and
        everywhere it shows up it names you as accountable for it. It signs in with its own tokens
        and has your access.
      </p>

      <div className="mt-8 flex flex-col gap-6">
        <Card
          title="Set one up in a checkout"
          description="In a repository, gm creates the agent, keeps its token, writes the instructions and skill its harness reads, and publishes its profile. Run it again to update; the agent then just runs gm issue next."
        >
          <div className="mk-card-body">
            <CopyField value="gm agent setup" label="Command" />
            <span className="mk-hint">
              Add <code className="mk-mono">--model</code> or <code className="mk-mono">--tag</code>{" "}
              to describe it (tags come from the tracker's tag catalog, the same names issues are
              tagged with), and <code className="mk-mono">--under CORE-4</code> to point it at a
              project.
            </span>
          </div>
        </Card>

        <Card title="Create an agent">
          <Form method="post" ref={formRef} className="mk-card-body">
            <input type="hidden" name="intent" value="create" />
            <TextField
              label="Name"
              name="name"
              required
              maxLength={39}
              pattern="[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*"
              placeholder="builder"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              hint="Lowercase letters, digits and hyphens. Shown as “builder for you”."
            />
            <TextField
              label="Description"
              name="description"
              maxLength={500}
              placeholder="Works through the CORE graph"
              autoComplete="off"
            />
            <FormError message={error} />
            <div className="mk-form-actions">
              <button className="mk-btn mk-btn--primary" disabled={creating}>
                Create agent
              </button>
            </div>
          </Form>
        </Card>

        {fresh && (
          <section className="mk-card mk-enter-up flex flex-col gap-4 bg-signal-wash">
            <div>
              <h2 className="mk-card-title">Copy {fresh.agent}'s token now</h2>
              <p className="mk-card-desc">You won't be able to see “{fresh.token.name}” again.</p>
            </div>
            <CopyField value={fresh.token.secret} label="Token" />
            <div className="mk-field">
              <span className="mk-label">Use it with gm</span>
              <CopyField value={`GM_TOKEN=${fresh.token.secret} gm issue next`} label="Command" />
              <span className="mk-hint">
                Or give the agent the token as GM_TOKEN in its environment.
              </span>
            </div>
          </section>
        )}

        <Card title="Your agents">
          {agents.length === 0 ? (
            <div className="mk-empty mt-5">
              No agents yet.
              <br />
              <span className="text-body-sm text-ink-faint">Create one above.</span>
            </div>
          ) : (
            <ul className="m-0 mt-4 list-none divide-y divide-line-soft p-0">
              {agents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} eligibility={eligibility} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </SettingsPage>
  );
}

function AgentRow({ agent, eligibility }: { agent: Agent; eligibility: AgentEligibility }) {
  // Minting navigates (a plain Form) so the page's action data carries the secret to show.
  const navigation = useNavigation();
  const minting =
    navigation.formData?.get("intent") === "token" && navigation.formData.get("id") === agent.id;
  const revoke = useFetcher();
  const revoked = agent.revokedAt !== null;
  return (
    <li className={`flex flex-col gap-3 py-4 ${revoked ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start gap-3">
        <RobotIcon className="mt-0.5 size-5 shrink-0 text-ink-faint" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{agent.name}</span>
            <span className="mk-chip mk-chip--tag whitespace-nowrap">
              for {agent.accountable.displayName}
            </span>
            {revoked && <span className="mk-chip mk-chip--tag">Revoked</span>}
          </div>
          {agent.description && (
            <p className="m-0 max-w-[48ch] text-body-sm text-ink-muted">{agent.description}</p>
          )}
          <div className="text-body-sm text-ink-faint">
            {revoked ? (
              <span title={fullDate(agent.revokedAt!)}>Revoked {timeAgo(agent.revokedAt!)}</span>
            ) : (
              <span title={fullDate(agent.createdAt)}>Created {timeAgo(agent.createdAt)}</span>
            )}
            {agent.capabilitiesUpdatedAt && (
              <span title={fullDate(agent.capabilitiesUpdatedAt)}>
                {" · "}profile from {timeAgo(agent.capabilitiesUpdatedAt)}
              </span>
            )}
          </div>
          {agent.capabilities && <Profile profile={agent.capabilities} eligibility={eligibility} />}
          {!revoked && <TrackerWork agent={agent} eligibility={eligibility} />}
        </div>
        {!revoked && (
          <div className="flex shrink-0 flex-wrap justify-end gap-2 max-sm:w-full max-sm:justify-start max-sm:pl-8">
            <Form method="post">
              <input type="hidden" name="intent" value="token" />
              <input type="hidden" name="id" value={agent.id} />
              <input type="hidden" name="name" value={agent.name} />
              <button className="mk-btn mk-btn--sm" disabled={minting}>
                New token
              </button>
            </Form>
            <ConfirmDialog
              trigger={<button className="mk-btn mk-btn--danger-ghost mk-btn--sm">Revoke</button>}
              title={`Revoke ${agent.name}?`}
              description="Its tokens stop working at once. Its name stays on what it did."
              confirmLabel="Revoke agent"
              busy={revoke.state !== "idle"}
              onConfirm={() =>
                revoke.submit({ intent: "revoke", id: agent.id }, { method: "post" })
              }
            />
          </div>
        )}
      </div>
      {agent.tokens.length > 0 && (
        <ul className="m-0 ml-8 list-none p-0">
          {agent.tokens.map((token) => (
            <TokenRow key={token.id} agent={agent} token={token} />
          ))}
        </ul>
      )}
    </li>
  );
}

function TokenRow({ agent, token }: { agent: Agent; token: Agent["tokens"][number] }) {
  const revoke = useFetcher();
  return (
    <li className="flex items-center gap-3 py-1.5 text-body-sm">
      <KeyIcon className="size-4 shrink-0 text-ink-faint" aria-hidden />
      <span className="mk-mono text-mono text-ink-faint">gmx_…{token.lastFour}</span>
      <span className="min-w-0 flex-1 truncate text-ink-faint">
        {token.lastUsedAt ? (
          <span title={fullDate(token.lastUsedAt)}>Last used {timeAgo(token.lastUsedAt)}</span>
        ) : (
          "Never used"
        )}
      </span>
      <ConfirmDialog
        trigger={<button className="mk-btn mk-btn--ghost mk-btn--sm">Revoke</button>}
        title={`Revoke this token for ${agent.name}?`}
        description="Anything using it stops working at once."
        confirmLabel="Revoke token"
        busy={revoke.state !== "idle"}
        onConfirm={() =>
          revoke.submit(
            { intent: "revoke-token", id: agent.id, tokenId: token.id },
            { method: "post" },
          )
        }
      />
    </li>
  );
}

/**
 * The open tracker work it can take: issues may require tags, models or
 * hardware (CORE-32), and the agent only gets what its profile meets.
 */
function TrackerWork({ agent, eligibility }: { agent: Agent; eligibility: AgentEligibility }) {
  const rows = eligibility.trackers.flatMap(({ tracker, agents }) => {
    const work = agents.find((a) => a.agentId === agent.id);
    return work && work.open > 0 ? [{ tracker, work }] : [];
  });
  if (!rows.length) return null;
  return (
    <ul
      className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0 text-body-sm"
      aria-label={`${agent.name}'s tracker work`}
    >
      {rows.map(({ tracker, work }) => (
        <li key={tracker.slug} className="text-ink-muted">
          <Link
            className="text-ink underline-offset-2 hover:underline"
            to={`/tracker/${tracker.slug}?q=${encodeURIComponent(`is:open eligible:${agent.name}`)}`}
          >
            {tracker.displayName}
          </Link>
          {": "}
          {work.requiring === 0
            ? `no open issues require anything; it can take all ${work.open}`
            : `eligible for ${work.open - work.requiring + work.eligible} of ${work.open} open issues`}
          {work.takeable && work.takeable.length > 0 && (
            <ul
              className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 pl-3"
              aria-label={`What ${agent.name} can take in ${tracker.displayName}`}
            >
              {work.takeable.map((issue) => (
                <li key={issue.key} className="flex min-w-0 items-center gap-1.5">
                  <CheckIcon className="size-3 shrink-0 text-online" weight="bold" aria-hidden />
                  <Link
                    className="flex min-w-0 items-baseline gap-1.5 text-ink no-underline hover:underline"
                    to={`/tracker/${tracker.slug}/issues/${issue.key}`}
                  >
                    <span className="mk-mono shrink-0 text-ink-faint">{issue.key}</span>
                    <span className="min-w-0 truncate">{issue.title}</span>
                  </Link>
                  {issue.requires && <span className="sr-only">(its requirements are met)</span>}
                </li>
              ))}
            </ul>
          )}
          {work.missing.length > 0 && (
            <ul
              className="m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0 pl-3 text-ink-faint"
              aria-label={`What ${agent.name} can't take in ${tracker.displayName}`}
            >
              {work.missing.map((issue) => (
                <li key={issue.key} className="flex min-w-0 items-start gap-1.5">
                  <XIcon className="mt-1 size-3 shrink-0" weight="bold" aria-hidden />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="mk-mono">{issue.key}</span> {issue.unmet.join("; ")}
                  </span>
                </li>
              ))}
              {work.requiring - work.eligible > work.missing.length && (
                <li>and {work.requiring - work.eligible - work.missing.length} more</li>
              )}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

const HARNESSES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "cursor-agent": "Cursor",
  "gemini-agent": "Gemini CLI",
  opencode: "OpenCode",
  amp: "Amp",
  auggie: "Auggie",
  "qwen-code": "Qwen Code",
  warp: "Warp",
  "vscode-copilot-agent": "GitHub Copilot",
};

/**
 * Where an agent tag leads (CORE-271): the open issues tagged with it in the
 * first of your trackers whose tag catalog has it. Null when none has it.
 */
function tagHome(tag: string, eligibility: AgentEligibility): string | null {
  const name = tag.toLowerCase();
  const home = eligibility.trackers.find(({ tags }) =>
    tags?.some((known) => known.toLowerCase() === name),
  );
  return home
    ? `/tracker/${home.tracker.slug}?q=${encodeURIComponent(`is:open ${filterToken("tag", name)}`)}`
    : null;
}

/** What the agent reported about itself: advice for choosing whom to delegate to. */
function Profile({
  profile,
  eligibility,
}: {
  profile: AgentCapabilities;
  eligibility: AgentEligibility;
}) {
  // Catalogs are only known from servers that send them; without one, nothing is flagged.
  const catalogs = eligibility.trackers.some(({ tags }) => tags !== undefined);
  const strays = catalogs ? profile.tags.filter((tag) => !tagHome(tag, eligibility)) : [];
  const { environment: env } = profile;
  const memory = env.memoryBytes ? `${Math.round(env.memoryBytes / 2 ** 30)} GB` : null;
  const runs = [
    profile.harness && (HARNESSES[profile.harness] ?? profile.harness),
    profile.model,
    `${env.os}/${env.arch}${env.runtime !== "host" && env.runtime !== "unknown" ? ` (${env.runtime})` : ""}`,
    env.cpuCount && `${env.cpuCount} CPUs`,
    memory,
  ].filter(Boolean);
  return (
    <div className="mt-1.5 flex flex-col gap-1.5 text-body-sm text-ink-muted">
      <span>{runs.join(" · ")}</span>
      {(profile.tags.length > 0 || profile.skills.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {profile.tags.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Agent tags">
              {profile.tags.map((tag) => {
                const to = tagHome(tag, eligibility);
                return (
                  <li key={tag} className="flex min-w-0">
                    <AgentTagChip name={tag} to={to ?? undefined} unknown={catalogs && !to} />
                  </li>
                );
              })}
            </ul>
          )}
          {profile.skills.length > 0 && (
            <span
              className="text-ink-faint"
              title={profile.skills.map((skill) => skill.name).join(", ")}
            >
              {profile.skills.length} skill{profile.skills.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}
      {strays.length > 0 && (
        <span className="text-ink-faint">
          {strays.join(", ")} {strays.length === 1 ? "isn't" : "aren't"} in any of your trackers'
          tag catalogs, so no issue is tagged {strays.length === 1 ? "with it" : "with them"}.
          Rename with <code className="mk-mono">gm agent setup --drop-tag</code> and{" "}
          <code className="mk-mono">--tag</code>.
        </span>
      )}
    </div>
  );
}
