// People's profile pictures (CORE-116).
//
//   PUT    /api/account/avatar             the image itself (PNG, JPEG or WebP, ≤ 256 KiB)
//   DELETE /api/account/avatar             back to initials
//   GET    /api/account/avatar/options     the generated options, if any
//   POST   /api/account/avatar/options     generate them: once per person, ever
//   GET    /api/avatars/:user/:file        a chosen picture (public, immutable)
//   GET    /api/account/avatar/options/:n  one generated option (its owner only)
//
// The browser crops and scales every picture (uploads and chosen options
// alike) to 256×256 before PUT, so the Worker only checks and stores bytes.
// Generated options cost money, so there are exactly four, from fixed
// prompts nobody can edit, made at most once: no prompting, no rerolls.

import { Hono, type Context } from "hono";
import type { AvatarOptions } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import { fail, requirePerson } from "../api/http.ts";
import { findUserById, viewerFor } from "../db.ts";
import { db } from "../schema.ts";
import { sqlNow } from "../db.ts";

export const avatars = new Hono<AppEnv>();

/** The largest picture accepted: the browser sends 256×256 WebP, far smaller. */
export const MAX_AVATAR_BYTES = 256 * 1024;

export const AVATAR_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/**
 * The only prompts ever sent: abstract, no faces or text, so nothing anyone
 * types reaches the model and nothing generated imitates a person.
 */
const STYLES = [
  "flat geometric avatar icon, overlapping circles and triangles, bold {color} and cream palette, centered composition, no text, no letters, no faces",
  "soft watercolor blob avatar, {color} and pale gold washes, gentle texture, centered round shape, no text, no letters, no faces",
  "low-poly crystal avatar icon, faceted gem shape in {color} tones, subtle gradient background, centered, no text, no letters, no faces",
  "pixel art avatar icon, tiny landscape with hills and a sun in {color} tones, 16-bit style, centered, no text, no letters, no faces",
] as const;
const COLORS = ["teal", "coral", "indigo", "amber", "sage green", "plum", "sky blue", "terracotta"];

/** The four prompts for one person: fixed styles, colors seeded by their id. */
export function avatarPrompts(userId: string): string[] {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return STYLES.map((style, i) =>
    style.replace("{color}", COLORS[(hash + i * 3) % COLORS.length]!),
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

async function currentKey(c: Context<AppEnv>, userId: string) {
  const row = await db(c.env.DB)
    .selectFrom("accounts")
    .select("avatar_key")
    .where("id", "=", userId)
    .executeTakeFirst();
  return row?.avatar_key ?? null;
}

async function respondWithViewer(c: Context<AppEnv>, userId: string) {
  const user = await findUserById(c.env.DB, userId);
  return c.json({ viewer: user ? await viewerFor(c.env.DB, user) : null });
}

// Setting a picture is the person's own act: agents acting for them can't.
avatars.put("/account/avatar", async (c) => {
  const person = requirePerson(c);
  if (person instanceof Response) return person;
  const bytes = await boundedBody(c);
  if (bytes instanceof Response) return bytes;
  const type = imageType(bytes);
  if (!type) return fail(c, 415, "Send a PNG, JPEG or WebP picture.");
  const key = `avatars/${person.id}/${(await sha256(bytes)).slice(0, 32)}.${EXTENSION[type]}`;
  await c.env.AVATARS.put(key, bytes, { httpMetadata: { contentType: type } });
  const previous = await currentKey(c, person.id);
  await db(c.env.DB)
    .updateTable("accounts")
    .set({ avatar_key: key })
    .where("id", "=", person.id)
    .execute();
  if (previous && previous !== key) c.executionCtx.waitUntil(c.env.AVATARS.delete(previous));
  return respondWithViewer(c, person.id);
});

avatars.delete("/account/avatar", async (c) => {
  const person = requirePerson(c);
  if (person instanceof Response) return person;
  const previous = await currentKey(c, person.id);
  await db(c.env.DB)
    .updateTable("accounts")
    .set({ avatar_key: null })
    .where("id", "=", person.id)
    .execute();
  if (previous) c.executionCtx.waitUntil(c.env.AVATARS.delete(previous));
  return respondWithViewer(c, person.id);
});

// Pictures are as public as profiles; a key changes with its content, so
// they cache forever.
avatars.get("/avatars/:user/:file", async (c) => {
  const key = `avatars/${c.req.param("user")}/${c.req.param("file")}`;
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

async function optionsFor(c: Context<AppEnv>, userId: string): Promise<AvatarOptions> {
  const row = await db(c.env.DB)
    .selectFrom("avatar_generations")
    .selectAll()
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) return { status: "none", options: [] };
  const keys = JSON.parse(row.options) as string[];
  return {
    status: row.status,
    options: keys.map((_, index) => `/api/account/avatar/options/${index}`),
  };
}

avatars.get("/account/avatar/options", async (c) => {
  const person = requirePerson(c);
  if (person instanceof Response) return person;
  return c.json(await optionsFor(c, person.id));
});

avatars.get("/account/avatar/options/:n", async (c) => {
  const person = requirePerson(c);
  if (person instanceof Response) return person;
  const row = await db(c.env.DB)
    .selectFrom("avatar_generations")
    .select("options")
    .where("user_id", "=", person.id)
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
});

/**
 * Generates the four options, once. The row is claimed first (its primary key
 * makes a second claim fail), so a double click or a second tab can't pay
 * again. A generation that produced nothing can be tried again; one that
 * produced anything is final.
 */
avatars.post("/account/avatar/options", async (c) => {
  const person = requirePerson(c);
  if (person instanceof Response) return person;
  if (!c.env.AI) return fail(c, 503, "Generated pictures are off on this server.");
  const claimed = await db(c.env.DB)
    .insertInto("avatar_generations")
    .values({ user_id: person.id, status: "generating" })
    .onConflict((oc) =>
      oc
        .column("user_id")
        .doUpdateSet({ status: "generating", created_at: sqlNow, finished_at: null })
        .where("avatar_generations.status", "=", "failed"),
    )
    .executeTakeFirst();
  if (!Number(claimed.numInsertedOrUpdatedRows ?? 0n))
    return c.json(await optionsFor(c, person.id), 409);

  const keys: string[] = [];
  for (const [index, prompt] of avatarPrompts(person.id).entries()) {
    try {
      const result = (await c.env.AI.run(AVATAR_MODEL, { prompt, steps: 4 })) as { image?: string };
      if (!result.image) throw new Error("No image in the response.");
      const bytes = Uint8Array.from(atob(result.image), (char) => char.charCodeAt(0));
      const type = imageType(bytes) ?? "image/jpeg";
      const key = `avatar-options/${person.id}/${index}.${EXTENSION[type]}`;
      await c.env.AVATARS.put(key, bytes, { httpMetadata: { contentType: type } });
      keys.push(key);
    } catch (error) {
      console.error(`avatar option ${index} failed`, error);
    }
  }
  await db(c.env.DB)
    .updateTable("avatar_generations")
    .set({
      status: keys.length ? "ready" : "failed",
      options: JSON.stringify(keys),
      finished_at: sqlNow,
    })
    .where("user_id", "=", person.id)
    .execute();
  const body = await optionsFor(c, person.id);
  return c.json(body, keys.length ? 201 : 502);
});
