// Shared by the Claude mod and the Oh My Pi extension. Never retain the raw
// response: /agents/self may gain fields that don't belong in a harness UI.
import type { GmAgentIdentity } from "../types";
type Run = (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>;

function label(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    ? value.trim()
    : null;
}

export function agentIdentity(value: unknown): GmAgentIdentity | null {
  if (!value || typeof value !== "object") return null;
  const agent = (value as Record<string, unknown>).agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return null;
  const fields = agent as Record<string, unknown>;
  const id = label(fields.id);
  const name = label(fields.name);
  if (
    !id ||
    !name ||
    (fields.kind !== undefined && fields.kind !== "agent") ||
    fields.revokedAt != null
  )
    return null;
  const owner = fields.accountable;
  const accountable =
    owner && typeof owner === "object" && !Array.isArray(owner)
      ? (label((owner as Record<string, unknown>).displayName) ??
        label((owner as Record<string, unknown>).id))
      : null;
  return { id, name, accountable };
}

export function identityLine(identity: GmAgentIdentity): string {
  return `Agent: ${identity.name}${identity.accountable ? ` · accountable: ${identity.accountable}` : ""}`;
}

export async function resolveIdentity(run: Run, cwd: string): Promise<GmAgentIdentity | null> {
  try {
    const checkout = await run(["git", "rev-parse", "--show-toplevel"], cwd);
    if (checkout.exitCode !== 0) return null;
    const result = await run(["gm", "agent", "show", "-o", "json"], cwd);
    return result.exitCode === 0 ? agentIdentity(JSON.parse(result.stdout)) : null;
  } catch {
    // No checkout, credentials, gm, network, or valid identity: fail closed.
    // In particular, never turn stderr or a thrown subprocess error into UI.
    return null;
  }
}
