import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import {
  CONTENT_CONTRACT_VERSION,
  type SpacePage,
  type SpaceSummary,
} from "../../shared/spaces.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import { findSpaceById, findSpaceBySlug, resolveSpaceAccess } from "../spaces/access.ts";
import {
  archiveSpace,
  createSpace,
  listOrganizations,
  listSpaceDirectory,
  listSpaceGrants,
  organizationRole,
  restoreSpace,
  revokeSpaceGrant,
  setSpaceGrant,
  updateSpace,
} from "../spaces/store.ts";
import { slugProblem } from "../names.ts";
import { fail, readJson, requireActor } from "./http.ts";

export async function spacePage(
  c: Context<AppEnv>,
  actor: Actor,
  space: SpaceSummary,
): Promise<SpacePage | null> {
  const [access, role] = await Promise.all([
    resolveSpaceAccess(c.env.DB, actor, space.id),
    organizationRole(c.env.DB, actor, space.organizationId),
  ]);
  if (!access && role !== "owner") return null;
  const admission = await cutoverControl(c.env).admission(CONTENT_CONTRACT_VERSION);
  if (!admission.allowed) throw new Error("space_cutover_fenced");
  return {
    space,
    grant: access?.grant ?? null,
    capabilities: {
      canReadContent: !!access,
      canAdministerContent: access?.grant.role === "admin",
      canCreateRepository: !!access,
      canManageGrants: role === "owner",
    },
    contractVersion: CONTENT_CONTRACT_VERSION,
    migrationEpoch: admission.epoch,
  };
}

export const spaces = new Hono<AppEnv>();
spaces.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const pages: SpacePage[] = [];
  for (const organization of await listOrganizations(c.env.DB, actor)) {
    for (const entry of await listSpaceDirectory(c.env.DB, actor, organization.id)) {
      if (entry.archivedAt) continue;
      const space = await findSpaceById(c.env.DB, entry.id);
      if (!space) continue;
      const page = await spacePage(c, actor, space);
      if (page?.grant) pages.push(page);
    }
  }
  return c.json({ spaces: pages });
});
spaces.post("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<{ organizationId: string; slug: string; displayName: string }>(c);
  if (
    typeof body.organizationId !== "string" ||
    typeof body.slug !== "string" ||
    typeof body.displayName !== "string" ||
    !body.displayName.trim() ||
    body.displayName.length > 80
  )
    return fail(c, 400, "Provide organizationId, slug and a display name of up to 80 characters.");
  const slug = body.slug.trim().toLowerCase();
  const problem = slugProblem(slug);
  if (problem) return fail(c, 400, problem);
  if ((await organizationRole(c.env.DB, actor, body.organizationId)) !== "owner")
    return fail(c, 403, "Organization owner access required.");
  if (await findSpaceBySlug(c.env.DB, slug)) return fail(c, 409, "Space handle is taken.");
  const id = await createSpace(c.env.DB, actor, body.organizationId, {
    slug,
    displayName: body.displayName.trim(),
  });
  const space = await findSpaceById(c.env.DB, id);
  return c.json(await spacePage(c, actor, space!), 201);
});
spaces.get("/:space", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const space = await findSpaceBySlug(c.env.DB, c.req.param("space"));
  const page = space ? await spacePage(c, actor, space) : null;
  return page ? c.json(page) : fail(c, 404, "No such Space.");
});

// These are directory/grant operations, not Space-content administrator powers.
const requireOrganizationOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const space = await findSpaceBySlug(c.env.DB, c.req.param("space")!);
  if (!space || (await organizationRole(c.env.DB, actor, space.organizationId)) !== "owner")
    return fail(c, 404, "No such Space.");
  return next();
};
spaces.use("/:space/archive", requireOrganizationOwner);
spaces.use("/:space/restore", requireOrganizationOwner);
spaces.use("/:space/grants", requireOrganizationOwner);
spaces.use("/:space/grants/:accountId", requireOrganizationOwner);
spaces.patch("/:space", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const space = await findSpaceBySlug(c.env.DB, c.req.param("space"));
  if (!space || (await organizationRole(c.env.DB, actor, space.organizationId)) !== "owner")
    return fail(c, 404, "No such Space.");
  const body = await readJson<{ displayName: string }>(c);
  if (
    typeof body.displayName !== "string" ||
    !body.displayName.trim() ||
    body.displayName.length > 80
  )
    return fail(c, 400, "Give a display name of up to 80 characters.");
  await updateSpace(c.env.DB, actor, space.organizationId, space.id, body.displayName.trim());
  return c.body(null, 204);
});
spaces.post("/:space/archive", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const space = (await findSpaceBySlug(c.env.DB, c.req.param("space")))!;
  const body = await readJson<{ replacementDefaultSpaceId: string }>(c);
  if (
    body.replacementDefaultSpaceId !== undefined &&
    typeof body.replacementDefaultSpaceId !== "string"
  )
    return fail(c, 400, "replacementDefaultSpaceId must be a Space ID.");
  if (space.archivedAt) return fail(c, 409, "Space is already archived.");
  if (space.organization.defaultSpaceId === space.id && !body.replacementDefaultSpaceId)
    return fail(c, 409, "Choose an explicit replacement default Space before archiving.");
  if (body.replacementDefaultSpaceId) {
    const replacement = await findSpaceById(c.env.DB, body.replacementDefaultSpaceId);
    if (
      !replacement ||
      replacement.organizationId !== space.organizationId ||
      replacement.archivedAt ||
      replacement.id === space.id
    )
      return fail(c, 400, "Replacement must be another active Space in this Organization.");
  }
  await archiveSpace(
    c.env.DB,
    actor,
    space.organizationId,
    space.id,
    body.replacementDefaultSpaceId,
  );
  return c.body(null, 204);
});
spaces.post("/:space/restore", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const space = (await findSpaceBySlug(c.env.DB, c.req.param("space")))!;
  if (!space.archivedAt) return fail(c, 409, "Space is not archived.");
  await restoreSpace(c.env.DB, actor, space.organizationId, space.id);
  return c.body(null, 204);
});
spaces.get("/:space/grants", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const space = (await findSpaceBySlug(c.env.DB, c.req.param("space")))!;
  return c.json({ grants: await listSpaceGrants(c.env.DB, actor, space.organizationId, space.id) });
});
spaces.put("/:space/grants/:accountId", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const space = (await findSpaceBySlug(c.env.DB, c.req.param("space")))!;
  const body = await readJson<{
    role: "admin" | "member";
    repositoryRole: "none" | "read" | "write";
    packageRole: "none" | "read" | "write";
  }>(c);
  if (
    (body.role !== "admin" && body.role !== "member") ||
    !body.repositoryRole ||
    !["none", "read", "write"].includes(body.repositoryRole) ||
    !body.packageRole ||
    !["none", "read", "write"].includes(body.packageRole)
  )
    return fail(c, 400, "Provide role, repositoryRole and packageRole independently.");
  const accountId = c.req.param("accountId");
  const member = await c.env.DB.prepare(
    "SELECT 1 FROM organization_members WHERE organization_id = ? AND account_id = ?",
  )
    .bind(space.organizationId, accountId)
    .first();
  if (!member)
    return fail(c, 400, "Add this person to the Organization before granting Space access.");
  await setSpaceGrant(c.env.DB, actor, space.organizationId, space.id, {
    accountId,
    role: body.role,
    repositoryRole: body.repositoryRole,
    packageRole: body.packageRole,
  });
  return c.body(null, 204);
});
spaces.delete("/:space/grants/:accountId", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const space = (await findSpaceBySlug(c.env.DB, c.req.param("space")))!;
  const accountId = c.req.param("accountId");
  if (
    !(await listSpaceGrants(c.env.DB, actor, space.organizationId, space.id)).some(
      (grant) => grant.accountId === accountId,
    )
  )
    return fail(c, 404, "No such grant.");
  await revokeSpaceGrant(c.env.DB, actor, space.organizationId, space.id, accountId);
  return c.body(null, 204);
});
