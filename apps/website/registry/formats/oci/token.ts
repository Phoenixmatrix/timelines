import { parseScope, type Scope } from "@gitmatrix/formats/oci";

import { AccessControl } from "../../core/acl.ts";
import type { AccessGrant, Actor } from "../../core/auth/actor.ts";
import { authenticate } from "../../core/auth/authenticate.ts";
import { issueRegistryToken } from "../../core/auth/registry-token.ts";
import { services, type AppContext, type Services } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import { resolveFeed } from "../../core/repos.ts";
import { deployTarget, members } from "../../core/virtual.ts";
import { splitName } from "./names.ts";

/**
 * The Docker token service (`/v2/token`). Clients authenticate here once
 * (Basic user:PAT, or the OAuth2 password/refresh_token form containerd
 * POSTs) and get a short-lived registry token that carries exactly the
 * per-image actions the caller may perform. Anonymous callers get pull on
 * public repositories.
 *
 * For a virtual repository the grants also name its members (pull) and its
 * deploy target (push), because requests are authorized against those.
 */

const FORM_LIMIT = 64 * 1024;

async function grantsFor(
  svc: Services,
  access: AccessControl,
  scope: Scope,
): Promise<AccessGrant[]> {
  if (scope.type === "registry") {
    const admin =
      scope.name === "catalog" &&
      access.actor.scopes.has("packages:admin") &&
      (await access.isAdmin()) &&
      (access.actor.via !== "registry" ||
        (access.actor.access ?? []).some(
          (grant) =>
            grant.type === "registry" && grant.name === "catalog" && grant.actions.includes("*"),
        ));
    return admin ? [{ type: "registry", name: "catalog", actions: ["*"] }] : [];
  }
  if (scope.type !== "repository") return [];
  const name = splitName(scope.name);
  if (!name) return [];
  const repo = await resolveFeed(svc, "oci", name.repoKey);
  if (!repo || repo.format !== "oci") return [];

  const wants = new Set(scope.actions);
  const all = wants.has("*");
  const granted = new Set<string>();
  const extra: AccessGrant[] = [];

  if (
    (all || wants.has("pull") || wants.has("push")) &&
    (await access.can(repo, "read", scope.name))
  ) {
    granted.add("pull");
  }
  const target =
    repo.kind === "local" ? repo : repo.kind === "virtual" ? await deployTarget(svc, repo) : null;
  if (target) {
    const targetName = `${target.key}/${name.image}`;
    for (const [action, needs] of [
      ["push", "write"],
      ["delete", "delete"],
    ] as const) {
      if (!(all || wants.has(action)) || !(await access.can(target, needs, targetName))) continue;
      granted.add(action);
      if (target !== repo) {
        extra.push({ type: "repository", name: targetName, actions: ["pull", action] });
      }
    }
    if (all && target === repo && (await access.can(repo, "admin", scope.name))) granted.add("*");
  }
  if (repo.kind === "virtual" && granted.has("pull")) {
    for (const member of await members(svc, repo)) {
      if (await access.can(member.repo, "read", `${member.repo.key}/${name.image}`)) {
        extra.push({
          type: "repository",
          name: `${member.repo.key}/${name.image}`,
          actions: ["pull"],
        });
      }
    }
  }
  return [
    ...(granted.size > 0
      ? [{ type: "repository", name: scope.name, actions: [...granted] } satisfies AccessGrant]
      : []),
    ...extra,
  ];
}

function mergeGrants(grants: AccessGrant[]): AccessGrant[] {
  const merged = new Map<string, AccessGrant>();
  for (const grant of grants) {
    const key = `${grant.type} ${grant.name}`;
    const existing = merged.get(key);
    if (existing) existing.actions = [...new Set([...existing.actions, ...grant.actions])];
    else merged.set(key, { ...grant, actions: [...grant.actions] });
  }
  return [...merged.values()];
}

async function readForm(c: AppContext): Promise<URLSearchParams> {
  const body = c.req.raw.body;
  if (!body) return new URLSearchParams();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > FORM_LIMIT) {
      await reader.cancel();
      throw RegistryError.badRequest("Token request is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

export async function tokenEndpoint(c: AppContext): Promise<Response> {
  const svc = services(c);
  const url = new URL(c.req.url);
  let params = url.searchParams;
  let actor: Actor;
  if (c.req.method === "POST") {
    params = await readForm(c);
    const grant = params.get("grant_type");
    const headers = new Headers();
    if (grant === "password") {
      const user = params.get("username") ?? "";
      const password = params.get("password") ?? "";
      if (!password) throw RegistryError.unauthorized("A password is required");
      headers.set("authorization", `Basic ${btoa(`${user}:${password}`)}`);
    } else if (grant === "refresh_token") {
      const refresh = params.get("refresh_token");
      if (!refresh) throw RegistryError.unauthorized("A refresh_token is required");
      headers.set("authorization", `Bearer ${refresh}`);
    } else {
      throw RegistryError.badRequest("Unsupported grant_type");
    }
    actor = await authenticate(svc.env, headers);
  } else {
    actor = await svc.actor();
  }

  const access = new AccessControl(svc.db, svc.env.DB, actor);
  const grants: AccessGrant[] = [];
  for (const raw of params.getAll("scope").flatMap((s) => s.split(" ").filter(Boolean))) {
    const scope = parseScope(raw);
    if (scope) grants.push(...(await grantsFor(svc, access, scope)));
  }
  const service = params.get("service") || new URL(svc.baseUrl).host;
  // Exchanges cannot widen a per-image JWT cap, including virtual feed aliases.
  const granted = mergeGrants(grants).flatMap((grant) => {
    if (actor.via !== "registry") return [grant];
    const caps = (actor.access ?? []).filter(
      (cap) => cap.type === grant.type && cap.name === grant.name,
    );
    const actions = grant.actions.filter((action) =>
      caps.some((cap) => cap.actions.includes("*") || cap.actions.includes(action)),
    );
    return actions.length ? [{ ...grant, actions }] : [];
  });
  const issued = await issueRegistryToken(svc.env, actor, granted, service);
  return c.json(
    {
      token: issued.token,
      access_token: issued.token,
      expires_in: issued.expiresIn,
      issued_at: issued.issuedAt,
    },
    200,
    { "cache-control": "no-store" },
  );
}
