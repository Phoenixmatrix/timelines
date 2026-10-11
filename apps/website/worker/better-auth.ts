// Real sign-in, with Better Auth: an emailed one-time code for people, and the
// device authorization flow (RFC 8628) for `gm auth login`.
//
// A Better Auth user's id is the Gitmatrix account id ("acc_…"), created
// together with the accounts row on first sign-in, so a session resolves
// straight to the account that permissions, tokens and org membership use.
//
// Sign-up is by invitation: a code is only sent to an existing user, the
// instance owner (OWNER_EMAIL) or an address an admin invited, and anyone else
// gets the same "check your email" answer so addresses can't be probed.
// Failed codes and device approvals count against the email and the client IP
// through the AUTH_FAILURES rate limiter; crossing it locks the key out for
// LOCKOUT_MS (auth_lockouts).

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { emailOTP } from "better-auth/plugins/email-otp";
import { readSecret } from "../registry/core/secrets.ts";
import { RESERVED_SLUGS } from "./names.ts";
import { isPreview, productionOnly } from "./preview.ts";
import { db } from "./schema.ts";

/** The only device client: the gm CLI. */
export const GM_CLIENT_ID = "gm";
const LOCKOUT_MS = 15 * 60_000;

const normalize = (email: string) => email.trim().toLowerCase();

/** Whether an email may receive a code: an existing user, the owner, or invited. */
export async function mayJoin(env: Env, email: string): Promise<boolean> {
  const address = normalize(email);
  if (address === normalize(env.OWNER_EMAIL)) return true;
  const [user, invite] = await Promise.all([
    db(env.DB)
      .selectFrom("auth_users")
      .select("id")
      .where("email", "=", address)
      .executeTakeFirst(),
    db(env.DB)
      .selectFrom("auth_invites")
      .select("email")
      .where("email", "=", address)
      .executeTakeFirst(),
  ]);
  return Boolean(user || invite);
}

/** A slug from the email's local part, made unique against accounts and reserved names. */
async function freeSlug(env: Env, email: string): Promise<string> {
  const base =
    normalize(email)
      .split("@")[0]!
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "user";
  for (let n = 0; ; n++) {
    const slug = n || RESERVED_SLUGS.has(base) ? `${base}-${n + 1}` : base;
    const taken = await db(env.DB)
      .selectFrom("accounts")
      .select("id")
      .where("slug", "=", slug)
      .executeTakeFirst();
    if (!taken) return slug;
  }
}

/**
 * Create the Gitmatrix account for a new Better Auth user. The owner becomes a
 * site admin and, where OWNER_ORG is set (deployed), the owner of that org.
 */
export async function linkAccount(env: Env, user: { id: string; email: string; name: string }) {
  const email = normalize(user.email);
  const existing = await db(env.DB)
    .selectFrom("accounts")
    .select("id")
    .where("id", "=", user.id)
    .executeTakeFirst();
  const owner = email === normalize(env.OWNER_EMAIL);
  if (!existing) {
    const slug = await freeSlug(env, email);
    await db(env.DB)
      .insertInto("accounts")
      .values({
        id: user.id,
        kind: "user",
        slug,
        display_name: user.name || slug,
        email,
        is_site_admin: owner ? 1 : 0,
      })
      .execute();
  }
  await db(env.DB).deleteFrom("auth_invites").where("email", "=", email).execute();
  const org = Reflect.get(env, "OWNER_ORG") as string | undefined;
  if (owner && org) {
    let orgRow = await db(env.DB)
      .selectFrom("accounts")
      .select("id")
      .where("slug", "=", org)
      .where("kind", "=", "org")
      .executeTakeFirst();
    if (!orgRow) {
      orgRow = { id: `acc_${crypto.randomUUID()}` };
      await db(env.DB)
        .insertInto("accounts")
        .values({
          id: orgRow.id,
          kind: "org",
          slug: org,
          display_name: org,
          member_repo_role: "read",
        })
        .execute();
    }
    await db(env.DB)
      .insertInto("org_members")
      .values({ org_id: orgRow.id, user_id: user.id, role: "owner" })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

/** Keys a failure counts against: the email (when known) and the client IP. */
function failureKeys(request: Request | undefined, email?: string): string[] {
  const ip = request?.headers.get("cf-connecting-ip");
  return [...(email ? [`email:${normalize(email)}`] : []), ...(ip ? [`ip:${ip}`] : [])];
}

async function lockedOut(env: Env, keys: string[]): Promise<boolean> {
  if (!keys.length) return false;
  const row = await db(env.DB)
    .selectFrom("auth_lockouts")
    .select("key")
    .where("key", "in", keys)
    .where("until", ">", new Date().toISOString())
    .executeTakeFirst();
  return Boolean(row);
}

/** Count a failure; past the limit, lock the key out for LOCKOUT_MS. */
export async function recordFailure(env: Env, keys: string[]) {
  for (const key of keys) {
    const { success } = await env.AUTH_FAILURES.limit({ key });
    if (success) continue;
    const until = new Date(Date.now() + LOCKOUT_MS).toISOString();
    await db(env.DB)
      .insertInto("auth_lockouts")
      .values({ key, until })
      .onConflict((oc) => oc.column("key").doUpdateSet({ until }))
      .execute();
  }
}

/** Sign-in paths whose failures count: wrong codes and wrong device codes. */
const GUARDED = new Set(["/sign-in/email-otp", "/device", "/device/approve", "/device/deny"]);

/** Email a sign-in code. A preview sends none: its people are the seeded personas. */
export async function sendCode(env: Env, email: string, otp: string) {
  if (!productionOnly(env, "email", "a sign-in code"))
    throw new APIError("BAD_REQUEST", {
      message: "Previews send no email. Sign in as one of the personas instead.",
    });
  if (Reflect.get(env, "DEV_MODE") === "true")
    console.log(`[auth] sign-in code for ${email}: ${otp}`);
  await env.EMAIL.send({
    from: { email: env.EMAIL_FROM, name: "Timelines" },
    to: email,
    subject: `Your Timelines sign-in code: ${otp}`,
    text: `Your Timelines sign-in code is ${otp}.\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
    html: `<p>Your Timelines sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px;font-family:monospace">${otp}</p><p>It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p>`,
  });
}

export function authOptions(env: Env, secret: string, origin?: string) {
  const baseURL = (Reflect.get(env, "PUBLIC_URL") as string | undefined) ?? origin;
  return {
    database: env.DB,
    secret,
    baseURL,
    // /api/auth/ssh is SSH-key sign-in for gm; Better Auth lives beside it.
    basePath: "/api/identity",
    trustedOrigins: baseURL ? [baseURL] : [],
    user: { modelName: "auth_users" },
    session: {
      modelName: "auth_sessions",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    account: { modelName: "auth_accounts" },
    verification: { modelName: "auth_verifications" },
    // Failures are limited by AUTH_FAILURES; Better Auth's own limiter keeps
    // in-memory state, which a Worker can't share between isolates.
    rateLimit: { enabled: false },
    advanced: {
      cookiePrefix: "gm",
      database: {
        generateId: ({ model }) =>
          model === "user" || model === "auth_users"
            ? `acc_${crypto.randomUUID()}`
            : crypto.randomUUID(),
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        async sendVerificationOTP({ email, otp }) {
          // Unknown addresses get the same answer as known ones (and in a
          // preview, every address hears that it sends no email).
          if (isPreview(env) || (await mayJoin(env, email))) await sendCode(env, email, otp);
        },
      }),
      deviceAuthorization({
        expiresIn: "10m",
        interval: "5s",
        verificationUri: "/device",
        validateClient: (clientId) => clientId === GM_CLIENT_ID,
        schema: { deviceCode: { modelName: "auth_device_codes" } },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          async before(user) {
            if (!(await mayJoin(env, user.email))) return false;
            return { data: { ...user, email: normalize(user.email) } };
          },
          async after(user) {
            await linkAccount(env, user);
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!GUARDED.has(ctx.path)) return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : undefined;
        if (await lockedOut(env, failureKeys(ctx.request, email)))
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many failed attempts. Try again in 15 minutes.",
          });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!GUARDED.has(ctx.path)) return;
        const returned = ctx.context.returned;
        if (!(returned instanceof APIError)) return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : undefined;
        await recordFailure(env, failureKeys(ctx.request, email));
      }),
    },
  } satisfies BetterAuthOptions;
}

/**
 * Better Auth for this request; bindings are request-scoped, so never cached.
 * The signing secret is a plain value locally and a Secrets Store binding
 * (gitmatrix_better_auth_secret) once deployed, read through readSecret.
 */
export async function createAuth(env: Env, origin?: string) {
  return betterAuth(authOptions(env, await readSecret(env, "BETTER_AUTH_SECRET"), origin));
}
