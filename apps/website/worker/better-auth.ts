// Real sign-in, with Better Auth: an emailed one-time code for people, a
// password for accounts a site admin created (worker/api/admin-accounts.ts),
// and the device authorization flow (RFC 8628) for `gm auth login`.
//
// A Better Auth user's id is the Gitmatrix person id ("acc_…"). Credentials
// and attribution retain that identity; content belongs to separately persisted
// Organizations and Spaces with explicit grants.
//
// Sign-up is by invitation: a code is only sent to an existing user, the
// instance owner (OWNER_EMAIL) or an address an admin invited, and anyone else
// gets the same "check your email" answer so addresses can't be probed.
// Nobody signs themselves up with a password: an admin sets it. People sign
// in with their username or email and it.
// Failed codes, passwords and device approvals count against the email and the client IP
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
import { createPerson } from "./spaces/store.ts";
import type { Timing } from "./timing.ts";

/** The only device client: the gm CLI. */
export const GM_CLIENT_ID = "gm";
const LOCKOUT_MS = 15 * 60_000;

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128;

const normalize = (email: string) => email.trim().toLowerCase();

/** Who a sign-in names: the email Better Auth looks up, and the key its failures count against. */
interface SignInIdentity {
  email: string;
  key: string;
}

/**
 * Who a password sign-in names: an email as given, or a username's. An unknown
 * username looks up an address no one has, so it fails exactly like a wrong
 * password; its failures count against the username itself (`user:`), a key
 * no email can reach, so lockouts don't tell known usernames apart either.
 */
async function signInIdentity(env: Env, identifier: string): Promise<SignInIdentity> {
  const name = normalize(identifier);
  if (name.includes("@")) return { email: name, key: `email:${name}` };
  const user = await db(env.DB)
    .selectFrom("accounts as a")
    .innerJoin("auth_users as u", "u.id", "a.id")
    .select("u.email")
    .where("a.slug", "=", name)
    .where("a.kind", "=", "user")
    .executeTakeFirst();
  if (user) return { email: normalize(user.email), key: `email:${normalize(user.email)}` };
  return {
    email: `${name.replace(/[^a-z0-9-]/g, "") || "user"}@users.invalid`,
    key: `user:${name}`,
  };
}

/**
 * Whether an email may receive a code: an existing user, the owner, or invited.
 * Not an account a site admin made with a password and an email nobody has
 * proven (worker/api/admin-accounts.ts): the address may be made up, or
 * someone else's, and a code sent there would hand them the account (and
 * Better Auth would drop the password on that first unproven sign-in).
 */
export async function mayJoin(env: Env, email: string): Promise<boolean> {
  const address = normalize(email);
  if (address === normalize(env.OWNER_EMAIL)) return true;
  const [user, invite] = await Promise.all([
    db(env.DB)
      .selectFrom("auth_users as u")
      .leftJoin("auth_accounts as p", (join) =>
        join.onRef("p.userId", "=", "u.id").on("p.providerId", "=", "credential"),
      )
      .select(["u.id", "u.emailVerified", "p.id as credential"])
      .where("u.email", "=", address)
      .executeTakeFirst(),
    db(env.DB)
      .selectFrom("auth_invites")
      .select("email")
      .where("email", "=", address)
      .executeTakeFirst(),
  ]);
  if (user) return Boolean(user.emailVerified) || !user.credential;
  return Boolean(invite);
}

/** A person/personal-tenant handle free in each independent namespace. */
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
    if (slug === Reflect.get(env, "OWNER_ORG")) continue;
    const taken = await Promise.all([
      db(env.DB).selectFrom("accounts").select("id").where("slug", "=", slug).executeTakeFirst(),
      db(env.DB)
        .selectFrom("organizations")
        .select("id")
        .where("slug", "=", slug)
        .executeTakeFirst(),
      db(env.DB).selectFrom("spaces").select("id").where("slug", "=", slug).executeTakeFirst(),
    ]);
    if (taken.every((row) => !row)) return slug;
  }
}

/** Create person, personal tenant, explicit grants and optional installation company atomically. */
export async function linkAccount(env: Env, user: { id: string; email: string; name: string }) {
  const existing = await db(env.DB)
    .selectFrom("accounts")
    .select("id")
    .where("id", "=", user.id)
    .executeTakeFirst();
  // Sign-in never repairs migration mappings or restores a revoked content grant.
  if (existing) return;
  const email = normalize(user.email);
  const slug = await freeSlug(env, email);
  const owner = email === normalize(env.OWNER_EMAIL);
  const ownerOrganizationSlug = owner
    ? (Reflect.get(env, "OWNER_ORG") as string | undefined)
    : undefined;
  await createPerson(env.DB, {
    id: user.id,
    slug,
    displayName: user.name || slug,
    email,
    isSiteAdmin: owner,
    ownerOrganizationSlug,
  });
}

/** Keys a failure counts against: who it names (when known) and the client IP. */
function failureKeys(request: Request | undefined, key?: string): string[] {
  const ip = request?.headers.get("cf-connecting-ip");
  return [...(key ? [key] : []), ...(ip ? [`ip:${ip}`] : [])];
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

/** Sign-in paths whose failures count: wrong codes, passwords and device codes. */
const GUARDED = new Set([
  "/sign-in/email-otp",
  "/sign-in/email",
  "/device",
  "/device/approve",
  "/device/deny",
]);

/** Who a guarded request names, with a password sign-in's username resolved. */
async function requestIdentity(
  env: Env,
  path: string,
  body: unknown,
): Promise<SignInIdentity | undefined> {
  const email = (body as { email?: unknown } | undefined)?.email;
  if (typeof email !== "string") return undefined;
  if (path === "/sign-in/email") return signInIdentity(env, email);
  return { email, key: `email:${normalize(email)}` };
}

/**
 * Who each guarded request named, as the before hook resolved it: the after
 * hook sees the body that hook rewrote (an unknown username's made-up address),
 * so it reuses this rather than resolving again.
 */
const identities = new WeakMap<Request, SignInIdentity>();

/**
 * Better Auth routes nobody here uses, all ways to set a password or change or
 * prove an email outside an admin: passwords are set by site admins
 * (worker/api/admin-accounts.ts) and changed with /change-password.
 */
const DISABLED_PATHS = [
  "/email-otp/request-password-reset",
  "/email-otp/reset-password",
  "/forget-password/email-otp",
  "/request-password-reset",
  "/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/email-otp/verify-email",
  "/send-verification-email",
  "/verify-email",
];

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
    disabledPaths: DISABLED_PATHS,
    user: { modelName: "auth_users" },
    session: {
      modelName: "auth_sessions",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    account: { modelName: "auth_accounts" },
    verification: { modelName: "auth_verifications" },
    emailAndPassword: {
      enabled: true,
      // Invite only: site admins create password accounts, nobody else.
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD,
      maxPasswordLength: MAX_PASSWORD,
      revokeSessionsOnPasswordReset: true,
    },
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
      session: {
        create: {
          async before(session) {
            // A failed user.create.after can leave only the authentication row.
            // Retry its atomic person bootstrap before issuing any session.
            const user = await db(env.DB)
              .selectFrom("auth_users")
              .select(["id", "email", "name"])
              .where("id", "=", session.userId)
              .executeTakeFirst();
            if (!user) return false;
            await linkAccount(env, user);
            return { data: session };
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Codes only sign in: none reset a password or verify an address.
        if (ctx.path === "/email-otp/send-verification-otp" && ctx.body?.type !== "sign-in")
          throw new APIError("BAD_REQUEST", { message: "Only sign-in codes are sent." });
        if (!GUARDED.has(ctx.path)) return;
        const identity = await requestIdentity(env, ctx.path, ctx.body);
        if (identity && ctx.request) identities.set(ctx.request, identity);
        if (await lockedOut(env, failureKeys(ctx.request, identity?.key)))
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many failed attempts. Try again in 15 minutes.",
          });
        // No code was sent to an address that may not join (see mayJoin):
        // refuse a guessed one like any wrong code.
        if (
          ctx.path === "/sign-in/email-otp" &&
          identity &&
          !(await mayJoin(env, identity.email))
        ) {
          await recordFailure(env, failureKeys(ctx.request, identity.key));
          throw APIError.from("BAD_REQUEST", { code: "INVALID_OTP", message: "Invalid OTP" });
        }
        // A password sign-in may name a username; Better Auth wants the email.
        if (ctx.path === "/sign-in/email" && identity)
          return { context: { body: { ...ctx.body, email: identity.email } } };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!GUARDED.has(ctx.path)) return;
        const returned = ctx.context.returned;
        if (!(returned instanceof APIError)) return;
        const identity =
          (ctx.request && identities.get(ctx.request)) ??
          (await requestIdentity(env, ctx.path, ctx.body));
        await recordFailure(env, failureKeys(ctx.request, identity?.key));
      }),
    },
  } satisfies BetterAuthOptions;
}

/**
 * Better Auth for this request; bindings are request-scoped, so never cached.
 * The signing secret is a plain value locally and a Secrets Store binding
 * (gitmatrix_better_auth_secret) once deployed, read through readSecret.
 */
export async function createAuth(env: Env, origin?: string, timing?: Timing) {
  const read = readSecret(env, "BETTER_AUTH_SECRET");
  const secret = await (timing ? timing.measure("auth-secret", read) : read);
  const options = authOptions(env, secret, origin);
  return timing ? timing.measureSync("auth-init", () => betterAuth(options)) : betterAuth(options);
}
