/**
 * Original initiating identity for durable content work, never cached rights.
 * Consumers persist this beside their exact repository/source/commit identity
 * and re-resolve the credential and resource grants at execution/publication.
 * A missing historical binding requires reconciliation, not a synthesized actor.
 */
export interface WorkAuthority {
  spaceId: string;
  migrationEpoch: number;
  personId: string;
  agentId: string | null;
  credential: { kind: "token" | "session"; id: string };
}
