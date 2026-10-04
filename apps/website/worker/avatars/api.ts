// Account pictures: people's profile pictures (CORE-116) and organizations'
// icons (CORE-128), the same way.
//
//   PUT    /api/account/avatar             your picture (PNG, JPEG or WebP, ≤ 256 KiB)
//   DELETE /api/account/avatar             back to initials
//   GET    /api/account/avatar/options     your generated options, if any
//   POST   /api/account/avatar/options     generate them: once per account, ever
//   GET    /api/account/avatar/options/:n  one generated option (its account only)
//   …/api/accounts/:slug/avatar[/options[/:n]]  the same for an organization,
//                                          by its owners (and site admins)
//   GET    /api/avatars/:account/:file     a chosen picture (public, immutable)
//
// The browser crops and scales every picture (uploads and chosen options
// alike) to 256×256 before PUT, so the Worker only checks and stores bytes.
// Generated options cost money, so there are exactly four, from fixed
// prompts nobody can edit, made at most once: no prompting, no rerolls.

import { Hono, type Context } from "hono";
import type { AvatarOptions } from "../../shared/api.ts";
import { aiGatewayOptions } from "../ai-gateway.ts";
import type { AppEnv } from "../auth.ts";
import { fail, requirePerson } from "../api/http.ts";
import { findAccountBySlug, findUserById, sqlNow, viewerFor, type Actor } from "../db.ts";
import { db } from "../schema.ts";
import { recordAiCall } from "../usage/ai.ts";

export const avatars = new Hono<AppEnv>();

/** The largest picture accepted: the browser sends 256×256 WebP, far smaller. */
export const MAX_AVATAR_BYTES = 256 * 1024;

export const AVATAR_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** The most model calls one generation may make, retries included. */
export const MAX_GENERATION_CALLS = 10;

/**
 * The only prompts ever sent: abstract and wordless, so nothing anyone types
 * reaches the model and nothing generated imitates a person.
 */
const STYLES = [
  "flat geometric avatar icon, overlapping circles and triangles, bold {color} and cream palette, centered composition, no text, no letters",
  "watercolor painted circle avatar icon, {color} and pale gold paint on paper texture, centered, no text, no letters",
  "low-poly crystal avatar icon, faceted gem shape in {color} tones, subtle gradient background, centered, no text, no letters",
  "pixel art avatar icon, tiny landscape with hills and a sun in {color} tones, 16-bit style, centered, no text, no letters",
] as const;
const COLORS = [
  "teal",
  "coral",
  "indigo",
  "amber",
  "sage green",
  "violet",
  "sky blue",
  "terracotta",
];

/** Organizations get marks that read as an icon, still abstract and wordless. */
const ORG_STYLES = [
  "minimal geometric logo mark, interlocking circles and squares in {color} on an off-white background, flat vector icon, centered, no text, no letters",
  "monoline emblem icon, simple hexagon badge outline in {color} on a dark background, clean vector, centered, no text, no letters",
  "abstract logo icon, three overlapping rounded ribbons in {color} tones on a light grey background, flat vector, centered, no text, no letters",
  "pixel art badge icon, simple shield shape in {color} tones, 16-bit style, centered, no text, no letters",
] as const;

/**
 * Tried for a slot whose preset the provider keeps refusing, so no account is
 * left short; still fixed, still nothing anyone typed. (FLUX's input safety
 * filter refuses roughly one harmless preset in six, mostly at random: 13 of
 * 72 on 2026-10-04, 10 of those passing on a retry.)
 */
const FALLBACK_STYLE =
  "simple flat icon, a single circle with one geometric shape inside, {color} on a plain light background, centered, no text";

/** The four prompts for one account: fixed styles, colors seeded by its id. */
export function avatarPrompts(accountId: string, kind: "user" | "org" = "user"): string[] {
  let hash = 0;
  for (const char of accountId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (kind === "org" ? ORG_STYLES : STYLES).map((style, i) =>
    style.replace("{color}", COLORS[(hash + i * 3) % COLORS.length]!),
  );
}

/** The fallback prompt for one slot, in that slot's color. */
export function fallbackPrompt(accountId: string, slot: number): string {
  let hash = 0;
  for (const char of accountId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FALLBACK_STYLE.replace("{color}", COLORS[(hash + slot * 3) % COLORS.length]!);
}

/** Every prompt the server can ever send, for checking against the provider. */
export function everyPrompt(): string[] {
  return [...STYLES, ...ORG_STYLES, FALLBACK_STYLE].flatMap((style) =>
    COLORS.map((color) => style.replace("{color}", color)),
  );
}

/** What a picture's bytes say it is: PNG, JPEG or WebP, or nothing we accept. */
export function imageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const at = (i: number) => bytes[i];
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

const EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

/** The public URL for a stored picture key ("avatars/<user>/<hash>.<ext>"). */
export function avatarUrl(key: string | null): string | null {
  return key ? `/api/${key}` : null;
}

/** The request body, counted as it streams; null (with a response sent) when too big. */
async function boundedBody(c: Context<AppEnv>): Promise<Uint8Array | Response> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) return fail(c, 400, "Send the picture as the request body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AVATAR_BYTES) {
        await reader.cancel();
        return fail(c, 413, "Keep the picture under 256 KiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whose picture a request changes, and how to answer once it has. */
interface Target {
  id: string;
  kind: "user" | "org";
  /** Where its generated options are served. */
  optionsPath: string;
  respond: (c: Context<AppEnv>) => Promise<Response>;
}

/** Your own picture: the person's act, never an agent's acting for them. */
function self(c: Context<AppEnv>): Target | Response {
  const person = requirePerson(c);
  if (person instanceof Response) return person;
  return {
    id: person.id,
    kind: "user",
    optionsPath: "/api/account/avatar/options",
    respond: async (ctx) => {
      const user = await findUserById(ctx.env.DB, person.id);
      return ctx.json({ viewer: user ? await viewerFor(ctx.env.DB, user) : null });
    },
  };
}

/** An organization's icon: its owners' (and site admins') act, never an agent's. */
async function organization(c: Context<AppEnv>): Promise<Target | Response> {
  const person = requirePerson(c);
  if (person instanceof Response) return person;
  const slug = c.req.param("slug") ?? "";
  const org = await findAccountBySlug(c.env.DB, slug);
  if (!org || org.kind !== "org") return fail(c, 404, "No such organization.");
  if (!(await canManageOrg(c.env.DB, person, org.id)))
    return fail(c, 403, "Only the organization's owners can change its icon.");
  return {
    id: org.id,
    kind: "org",
    optionsPath: `/api/accounts/${encodeURIComponent(org.slug)}/avatar/options`,
    respond: async (ctx) => {
      const row = await findAccountBySlug(ctx.env.DB, org.slug);
      return ctx.json({ avatarUrl: avatarUrl(row?.avatar_key ?? null) });
    },
  };
}

/** Owners of the organization, and site admins, manage its icon. */
export async function canManageOrg(d1: D1Database, person: Actor, orgId: string) {
  if (person.isSiteAdmin) return true;
  const membership = await db(d1)
    .selectFrom("org_members")
    .select("role")
    .where("org_id", "=", orgId)
    .where("user_id", "=", person.id)
    .executeTakeFirst();
  return membership?.role === "owner";
}

async function currentKey(c: Context<AppEnv>, accountId: string) {
  const row = await db(c.env.DB)
    .selectFrom("accounts")
    .select("avatar_key")
    .where("id", "=", accountId)
    .executeTakeFirst();
  return row?.avatar_key ?? null;
}

async function setPicture(c: Context<AppEnv>, target: Target) {
  const bytes = await boundedBody(c);
  if (bytes instanceof Response) return bytes;
  const type = imageType(bytes);
  if (!type) return fail(c, 415, "Send a PNG, JPEG or WebP picture.");
  const key = `avatars/${target.id}/${(await sha256(bytes)).slice(0, 32)}.${EXTENSION[type]}`;
  await c.env.AVATARS.put(key, bytes, { httpMetadata: { contentType: type } });
  const previous = await currentKey(c, target.id);
  await db(c.env.DB)
    .updateTable("accounts")
    .set({ avatar_key: key })
    .where("id", "=", target.id)
    .execute();
  if (previous && previous !== key) c.executionCtx.waitUntil(c.env.AVATARS.delete(previous));
  return target.respond(c);
}

async function removePicture(c: Context<AppEnv>, target: Target) {
  const previous = await currentKey(c, target.id);
  await db(c.env.DB)
    .updateTable("accounts")
    .set({ avatar_key: null })
    .where("id", "=", target.id)
    .execute();
  if (previous) c.executionCtx.waitUntil(c.env.AVATARS.delete(previous));
  return target.respond(c);
}

async function optionsFor(c: Context<AppEnv>, target: Target): Promise<AvatarOptions> {
  const row = await db(c.env.DB)
    .selectFrom("avatar_generations")
    .selectAll()
    .where("user_id", "=", target.id)
    .executeTakeFirst();
  if (!row) return { status: "none", options: [] };
  const keys = JSON.parse(row.options) as string[];
  return {
    status: row.status,
    options: keys.map((_, index) => `${target.optionsPath}/${index}`),
  };
}

async function serveOption(c: Context<AppEnv>, target: Target) {
  const row = await db(c.env.DB)
    .selectFrom("avatar_generations")
    .select("options")
    .where("user_id", "=", target.id)
    .executeTakeFirst();
  const key = row ? (JSON.parse(row.options) as string[])[Number(c.req.param("n"))] : undefined;
  const object = key ? await c.env.AVATARS.get(key) : null;
  if (!object) return fail(c, 404, "Not found.");
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/jpeg",
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Generates the four options, once per account. The row is claimed first (its
 * primary key makes a second claim fail), so a double click or a second tab
 * can't pay again. A generation that produced nothing can be tried again; one
 * that produced anything is final.
 */
async function generateOptions(c: Context<AppEnv>, target: Target) {
  if (!c.env.AI) return fail(c, 503, "Generated pictures are off on this server.");
  const claimed = await db(c.env.DB)
    .insertInto("avatar_generations")
    .values({ user_id: target.id, status: "generating" })
    .onConflict((oc) =>
      oc
        .column("user_id")
        .doUpdateSet({ status: "generating", created_at: sqlNow, finished_at: null })
        .where("avatar_generations.status", "=", "failed"),
    )
    .executeTakeFirst();
  if (!Number(claimed.numInsertedOrUpdatedRows ?? 0n))
    return c.json(await optionsFor(c, target), 409);

  const keys: string[] = [];
  const generate = async (prompt: string) => {
    const result = (await c.env.AI!.run(
      AVATAR_MODEL,
      { prompt, steps: 4 },
      aiGatewayOptions(c.env, "avatars"),
    )) as { image?: string };
    // Metering (CORE-207): an image call, no tokens.
    c.executionCtx.waitUntil(
      recordAiCall(c.env, AVATAR_MODEL, {}, { work: { feature: "avatars", account: target.id } }),
    );
    if (!result.image) throw new Error("No image in the response.");
    return Uint8Array.from(atob(result.image), (char) => char.charCodeAt(0));
  };
  // Refusals are retried, within a hard budget: per slot its preset twice,
  // then the fallback; never more than MAX_GENERATION_CALLS in all.
  let budget = MAX_GENERATION_CALLS;
  for (const [index, prompt] of avatarPrompts(target.id, target.kind).entries()) {
    let bytes: Uint8Array | null = null;
    for (const attempt of [prompt, prompt, fallbackPrompt(target.id, index)]) {
      if (budget <= 0) break;
      budget--;
      try {
        bytes = await generate(attempt);
        break;
      } catch (error) {
        console.error(`avatar option ${index} failed`, error);
      }
    }
    if (!bytes) continue;
    const type = imageType(bytes) ?? "image/jpeg";
    const key = `avatar-options/${target.id}/${index}.${EXTENSION[type]}`;
    await c.env.AVATARS.put(key, bytes, { httpMetadata: { contentType: type } });
    keys.push(key);
  }
  await db(c.env.DB)
    .updateTable("avatar_generations")
    .set({
      status: keys.length ? "ready" : "failed",
      options: JSON.stringify(keys),
      finished_at: sqlNow,
    })
    .where("user_id", "=", target.id)
    .execute();
  return c.json(await optionsFor(c, target), keys.length ? 201 : 502);
}

type Resolve = (c: Context<AppEnv>) => Target | Response | Promise<Target | Response>;

/** The same five routes for each kind of account picture. */
function routes(base: string, resolve: Resolve) {
  const run =
    (handler: (c: Context<AppEnv>, target: Target) => Promise<Response>) =>
    async (c: Context<AppEnv>) => {
      const target = await resolve(c);
      return target instanceof Response ? target : handler(c, target);
    };
  avatars.put(base, run(setPicture));
  avatars.delete(base, run(removePicture));
  avatars.get(
    `${base}/options`,
    run(async (c, target) => c.json(await optionsFor(c, target))),
  );
  avatars.post(`${base}/options`, run(generateOptions));
  avatars.get(`${base}/options/:n`, run(serveOption));
}
routes("/account/avatar", self);
routes("/accounts/:slug/avatar", organization);

// Pictures are as public as profiles; a key changes with its content, so
// they cache forever.
avatars.get("/avatars/:account/:file", async (c) => {
  const key = `avatars/${c.req.param("account")}/${c.req.param("file")}`;
  if (!/^avatars\/[\w-]+\/[0-9a-f]{32}\.(png|jpg|webp)$/.test(key))
    return fail(c, 404, "Not found.");
  const object = await c.env.AVATARS.get(key);
  if (!object) return fail(c, 404, "Not found.");
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
});
