import { timingSafeEqual } from "node:crypto";

const CHALLENGE_MS = 10 * 60_000;
const SESSION_MS = 15 * 60_000;
const LOCKOUT_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

type Limits = { issued_at: number; failures: number; locked_until: number };
type Challenge = { code_digest: string; expires_at: number };

/** Authentication survives business-data restoration, but never changes admission. */
export class OperatorAuthStore {
  readonly #sql: SqlStorage;
  readonly #transaction: <T>(work: () => T) => T;

  constructor(ctx: Pick<DurableObjectState, "storage">) {
    this.#sql = ctx.storage.sql;
    this.#transaction = (work) => ctx.storage.transactionSync(work);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS operator_auth_limits (
      operator_id TEXT PRIMARY KEY, issued_at INTEGER NOT NULL,
      failures INTEGER NOT NULL, locked_until INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS operator_auth_challenges (
      operator_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, challenge_id TEXT NOT NULL,
      code_digest TEXT NOT NULL, expires_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS operator_auth_sessions (
      operator_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
      session_digest TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
  }

  issue(runId: string, operatorId: string, challengeId: string, codeDigest: string) {
    if (!/^[0-9a-f]{64}$/.test(codeDigest)) throw new Error("Invalid operator challenge");
    return this.#transaction(() => {
      const now = Date.now();
      const limits = this.#sql
        .exec<Limits>(
          "SELECT issued_at,failures,locked_until FROM operator_auth_limits WHERE operator_id=?",
          operatorId,
        )
        .toArray()[0];
      if (limits && (limits.locked_until > now || now - limits.issued_at < 60_000))
        throw new Error("Operator authentication temporarily limited");
      const failures = limits && limits.locked_until === 0 ? limits.failures : 0;
      this.#sql.exec(
        "INSERT INTO operator_auth_limits VALUES(?,?,?,0) ON CONFLICT(operator_id) DO UPDATE SET issued_at=excluded.issued_at,failures=excluded.failures,locked_until=0",
        operatorId,
        now,
        failures,
      );
      const expiresAt = now + CHALLENGE_MS;
      this.#sql.exec(
        "INSERT INTO operator_auth_challenges VALUES(?,?,?,?,?) ON CONFLICT(operator_id) DO UPDATE SET run_id=excluded.run_id,challenge_id=excluded.challenge_id,code_digest=excluded.code_digest,expires_at=excluded.expires_at",
        operatorId,
        runId,
        challengeId,
        codeDigest,
        expiresAt,
      );
      return { challengeId, expiresAt };
    });
  }

  verify(
    runId: string,
    operatorId: string,
    challengeId: string,
    codeDigest: string,
    sessionDigest: string,
  ) {
    if (!/^[0-9a-f]{64}$/.test(codeDigest) || !/^[0-9a-f]{64}$/.test(sessionDigest)) return null;
    return this.#transaction(() => {
      const now = Date.now();
      const limits = this.#sql
        .exec<Limits>(
          "SELECT issued_at,failures,locked_until FROM operator_auth_limits WHERE operator_id=?",
          operatorId,
        )
        .toArray()[0];
      if (!limits || limits.locked_until > now) return null;
      const challenge = this.#sql
        .exec<Challenge>(
          "SELECT code_digest,expires_at FROM operator_auth_challenges WHERE operator_id=? AND run_id=? AND challenge_id=?",
          operatorId,
          runId,
          challengeId,
        )
        .toArray()[0];
      if (!challenge || challenge.expires_at <= now) return null;
      if (
        !timingSafeEqual(Buffer.from(codeDigest, "hex"), Buffer.from(challenge.code_digest, "hex"))
      ) {
        const failures = limits.failures + 1;
        this.#sql.exec(
          "UPDATE operator_auth_limits SET failures=?,locked_until=? WHERE operator_id=?",
          failures,
          failures >= MAX_ATTEMPTS ? now + LOCKOUT_MS : 0,
          operatorId,
        );
        // Return, rather than throw: failed-attempt accounting must commit.
        return null;
      }
      this.#sql.exec("DELETE FROM operator_auth_challenges WHERE operator_id=?", operatorId);
      this.#sql.exec(
        "UPDATE operator_auth_limits SET failures=0,locked_until=0 WHERE operator_id=?",
        operatorId,
      );
      const expiresAt = now + SESSION_MS;
      this.#sql.exec(
        "INSERT INTO operator_auth_sessions VALUES(?,?,?,?) ON CONFLICT(operator_id) DO UPDATE SET run_id=excluded.run_id,session_digest=excluded.session_digest,expires_at=excluded.expires_at",
        operatorId,
        runId,
        sessionDigest,
        expiresAt,
      );
      return { expiresAt };
    });
  }

  session(runId: string, operatorId: string, sessionDigest: string): boolean {
    return (
      this.#sql
        .exec<{ present: number }>(
          "SELECT 1 AS present FROM operator_auth_sessions WHERE operator_id=? AND run_id=? AND session_digest=? AND expires_at>?",
          operatorId,
          runId,
          sessionDigest,
          Date.now(),
        )
        .toArray().length === 1
    );
  }
}
