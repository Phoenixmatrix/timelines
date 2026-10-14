import { Hono } from "hono";
import type { OrganizationPage } from "../../shared/spaces.ts";
import type { AppEnv } from "../auth.ts";
import { findUserById } from "../db.ts";
import {
  findSpaceById,
  findSpaceBySlug,
  listOrganizationSpaces,
  listSpaceAccess,
} from "../spaces/access.ts";
import {
  createOrganization,
  listOrganizations,
  listOrganizationMembers,
  listSpaceDirectory,
  organizationRole,
  removeOrganizationMember,
  setDefaultSpace,
  setOrganizationMember,
  updateOrganization,
} from "../spaces/store.ts";
import { slugProblem } from "../names.ts";
import { requestAdmission } from "./content-contract.ts";
import { fail, readJson, requireActor } from "./http.ts";
import { spacePage, spacePageFrom } from "./spaces.ts";

export const organizations = new Hono<AppEnv>();
organizations.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  return c.json({ organizations: await listOrganizations(c.env.DB, actor) });
});
organizations.post("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<{
    slug: string;
    displayName: string;
    spaceSlug: string;
    spaceDisplayName: string;
  }>(c);
  if (
    typeof body.slug !== "string" ||
    typeof body.spaceSlug !== "string" ||
    typeof body.displayName !== "string" ||
    typeof body.spaceDisplayName !== "string" ||
    !body.displayName.trim() ||
    !body.spaceDisplayName.trim() ||
    body.displayName.length > 80 ||
    body.spaceDisplayName.length > 80
  )
    return fail(
      c,
      400,
      "Provide Organization and default Space handles and display names (up to 80 characters).",
    );
  const slug = body.slug.trim().toLowerCase();
  const spaceSlug = body.spaceSlug.trim().toLowerCase();
  const problem = slugProblem(slug) ?? slugProblem(spaceSlug);
  if (problem) return fail(c, 400, problem);
  if (
    (await c.env.DB.prepare("SELECT id FROM organizations WHERE slug = ? COLLATE NOCASE")
      .bind(slug)
      .first()) ||
    (await findSpaceBySlug(c.env.DB, spaceSlug))
  )
    return fail(c, 409, "Organization or Space handle is taken.");
  const result = await createOrganization(c.env.DB, actor, {
    slug,
    spaceSlug,
    displayName: body.displayName.trim(),
    spaceDisplayName: body.spaceDisplayName.trim(),
    kind: "company",
  });
  const organization = (await listOrganizations(c.env.DB, actor)).find(
    (entry) => entry.id === result.organizationId,
  )!;
  const space = (await findSpaceById(c.env.DB, result.spaceId))!;
  const page: OrganizationPage = {
    organization,
    viewerRole: "owner",
    activeSpaceCount: 1,
    spaces: [(await spacePage(c, actor, space))!],
  };
  return c.json(page, 201);
});
organizations.use("/:organization/*", async (c, next) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const organization = (await listOrganizations(c.env.DB, actor)).find(
    (entry) => entry.slug.toLowerCase() === c.req.param("organization")?.toLowerCase(),
  );
  if (!organization) return fail(c, 404, "No such Organization.");
  if (
    c.req.method !== "GET" &&
    (await organizationRole(c.env.DB, actor, organization.id)) !== "owner"
  )
    return fail(c, 403, "Organization owner access required.");
  return next();
});
organizations.get("/:organization", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const organization = (await listOrganizations(c.env.DB, actor)).find(
    (entry) => entry.slug.toLowerCase() === c.req.param("organization").toLowerCase(),
  );
  if (!organization) return fail(c, 404, "No such Organization.");
  // Switching Organization lands here: read role, directory, grants and Spaces
  // together rather than a lookup, grant and role query per Space in turn.
  const [viewerRole, directory, granted, spaces, admission] = await Promise.all([
    organizationRole(c.env.DB, actor, organization.id),
    listSpaceDirectory(c.env.DB, actor, organization.id),
    listSpaceAccess(c.env.DB, actor, organization.id),
    listOrganizationSpaces(c.env.DB, organization.id),
    requestAdmission(c),
  ]);
  if (!viewerRole) return fail(c, 404, "No such Organization.");
  const accessById = new Map(granted.map((access) => [access.spaceId, access]));
  const spaceById = new Map(spaces.map((space) => [space.id, space]));
  const pages: OrganizationPage["spaces"] = [];
  for (const entry of directory) {
    const space = spaceById.get(entry.id);
    const page = space
      ? spacePageFrom(space, accessById.get(entry.id) ?? null, viewerRole, admission)
      : null;
    if (page) pages.push(page);
  }
  const page: OrganizationPage = {
    organization,
    viewerRole,
    spaces: pages,
    activeSpaceCount: spaces.filter((space) => !space.archivedAt).length,
  };
  return c.json(page);
});
organizations.patch("/:organization", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const organization = (await listOrganizations(c.env.DB, actor)).find(
    (entry) => entry.slug.toLowerCase() === c.req.param("organization").toLowerCase(),
  );
  if (!organization) return fail(c, 404, "No such Organization.");
  if ((await organizationRole(c.env.DB, actor, organization.id)) !== "owner")
    return fail(c, 403, "Organization owner access required.");
  const body = await readJson<{ displayName: string }>(c);
  if (
    typeof body.displayName !== "string" ||
    !body.displayName.trim() ||
    body.displayName.length > 80
  )
    return fail(c, 400, "Give a display name of up to 80 characters.");
  await updateOrganization(c.env.DB, actor, organization.id, body.displayName.trim());
  return c.body(null, 204);
});
organizations.put("/:organization/default-space", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const organization = (await listOrganizations(c.env.DB, actor)).find(
    (entry) => entry.slug.toLowerCase() === c.req.param("organization").toLowerCase(),
  );
  if (!organization) return fail(c, 404, "No such Organization.");
  const body = await readJson<{ spaceId: string }>(c);
  const space =
    typeof body.spaceId === "string" ? await findSpaceById(c.env.DB, body.spaceId) : null;
  if (!space || space.organizationId !== organization.id || space.archivedAt)
    return fail(c, 400, "Default must be an active Space in this Organization.");
  await setDefaultSpace(c.env.DB, actor, organization.id, space.id);
  return c.body(null, 204);
});
organizations.get("/:organization/members", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const organization = (await listOrganizations(c.env.DB, actor)).find(
    (entry) => entry.slug.toLowerCase() === c.req.param("organization").toLowerCase(),
  );
  if (!organization) return fail(c, 404, "No such Organization.");
  return c.json({ members: await listOrganizationMembers(c.env.DB, actor, organization.id) });
});
organizations.put("/:organization/members/:accountId", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const organization = (await listOrganizations(c.env.DB, actor)).find(
    (entry) => entry.slug.toLowerCase() === c.req.param("organization").toLowerCase(),
  );
  if (!organization) return fail(c, 404, "No such Organization.");
  const body = await readJson<{ role: "owner" | "member" }>(c);
  if (body.role !== "owner" && body.role !== "member")
    return fail(c, 400, "Role must be owner or member.");
  const accountId = c.req.param("accountId");
  if (!(await findUserById(c.env.DB, accountId))) return fail(c, 404, "No such person.");
  const members = await listOrganizationMembers(c.env.DB, actor, organization.id);
  if (
    body.role !== "owner" &&
    members.find((member) => member.id === accountId)?.role === "owner" &&
    members.filter((member) => member.role === "owner").length === 1
  )
    return fail(c, 409, "Keep at least one Organization owner.");
  await setOrganizationMember(c.env.DB, actor, organization.id, accountId, body.role);
  return c.body(null, 204);
});
organizations.delete("/:organization/members/:accountId", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const organization = (await listOrganizations(c.env.DB, actor)).find(
    (entry) => entry.slug.toLowerCase() === c.req.param("organization").toLowerCase(),
  );
  if (!organization) return fail(c, 404, "No such Organization.");
  const accountId = c.req.param("accountId");
  const members = await listOrganizationMembers(c.env.DB, actor, organization.id);
  const member = members.find((entry) => entry.id === accountId);
  if (!member) return fail(c, 404, "No such member.");
  if (member.role === "owner" && members.filter((entry) => entry.role === "owner").length === 1)
    return fail(c, 409, "Keep at least one Organization owner.");
  await removeOrganizationMember(c.env.DB, actor, organization.id, accountId);
  return c.body(null, 204);
});
