import { createHmac, randomBytes, randomInt } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { readSecret } from "../../registry/core/secrets.ts";
import { spaceDigest } from "../../shared/space-cutover.ts";
import { sessionActor, type AppEnv } from "../auth.ts";
import { sendCode } from "../better-auth.ts";
import { findUserById } from "../db.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";

const cookieName = (url: URL) =>
  `${url.protocol === "https:" ? "__Secure-" : ""}gm.cutover_operator`;
const sessionDigest = (origin: string, token: string) =>
  spaceDigest(`operator-session:${origin}:${token}`);

/** Normal sessions can refresh or delete D1 rows; never resolve them while fenced. */
export async function cutoverHumanSession(c: Context<AppEnv>) {
  const control = cutoverControl(c.env);
  const run = await control.status();
  if (!run || ["prepared", "legacy-active", "active"].includes(run.phase)) return sessionActor(c);
  const url = new URL(c.req.url);
  const token = getCookie(c, cookieName(url));
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  if (!(await control.operatorSession(run.runId, await sessionDigest(url.origin, token))))
    return null;
  const actor = await findUserById(c.env.DB, run.operatorId);
  return actor?.isSiteAdmin && !actor.agent ? actor : null;
}

async function enrolledOperator(c: Context<AppEnv>) {
  const control = cutoverControl(c.env);
  const run = await control.status();
  if (
    !run ||
    ["prepared", "legacy-active", "active"].includes(run.phase) ||
    c.get("actor")?.id !== run.operatorId
  )
    return null;
  const person = await c.env.DB.prepare(
    "SELECT u.email FROM auth_users u JOIN accounts a ON a.id=u.id WHERE a.id=? AND a.kind='user' AND a.is_site_admin=1 AND u.emailVerified=1",
  )
    .bind(run.operatorId)
    .first<{ email: string }>();
  return person
    ? { control, runId: run.runId, operatorId: run.operatorId, email: person.email }
    : null;
}

async function codeDigest(
  c: Context<AppEnv>,
  runId: string,
  operatorId: string,
  challengeId: string,
  code: string,
) {
  return createHmac("sha256", await readSecret(c.env, "BETTER_AUTH_SECRET"))
    .update(
      JSON.stringify([
        "space-cutover-operator",
        new URL(c.req.url).origin,
        runId,
        operatorId,
        challengeId,
        code,
      ]),
    )
    .digest("hex");
}

async function credentials(c: Context<AppEnv>): Promise<{ challengeId?: unknown; code?: unknown }> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new Error("Operator authentication body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024) {
        await reader.cancel();
        throw new Error("Operator authentication body too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as { challengeId?: unknown; code?: unknown };
}

/** Mounted behind the same-origin, run-scoped recovery-capability middleware. */
export const operatorAuthApi = new Hono<AppEnv>();
operatorAuthApi.post("/start", async (c) => {
  const operator = await enrolledOperator(c);
  if (!operator) return c.json({ error: "Current enrolled human operator required" }, 403);
  const challengeId = crypto.randomUUID();
  const code = randomInt(100_000_000).toString().padStart(8, "0");
  const challenge = await operator.control.issueOperatorAuthentication(
    operator.runId,
    challengeId,
    await codeDigest(c, operator.runId, operator.operatorId, challengeId, code),
  );
  await sendCode(c.env, operator.email, code);
  return c.json({ challengeId: challenge.challengeId, expiresAt: challenge.expiresAt });
});
operatorAuthApi.post("/verify", async (c) => {
  const operator = await enrolledOperator(c);
  if (!operator) return c.json({ error: "Current enrolled human operator required" }, 403);
  const body = await credentials(c);
  if (
    typeof body?.challengeId !== "string" ||
    body.challengeId.length !== 36 ||
    typeof body.code !== "string" ||
    !/^\d{8}$/.test(body.code)
  )
    return c.json({ error: "Invalid or expired operator code" }, 403);
  const token = randomBytes(32).toString("base64url");
  const url = new URL(c.req.url);
  const session = await operator.control.verifyOperatorAuthentication(
    operator.runId,
    body.challengeId,
    await codeDigest(c, operator.runId, operator.operatorId, body.challengeId, body.code),
    await sessionDigest(url.origin, token),
  );
  if (!session) return c.json({ error: "Invalid or expired operator code" }, 403);
  setCookie(c, cookieName(url), token, {
    path: "/api/admin/space-cutover",
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Strict",
    maxAge: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
  });
  return c.json({ expiresAt: session.expiresAt });
});
