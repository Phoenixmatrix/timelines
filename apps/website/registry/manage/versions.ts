// Version housekeeping from the console and gm: delete, yank, deprecate and
// tag, the way each ecosystem means them. npm deprecates (it has no yank) and
// moves dist-tags; Cargo and PyPI yank; OCI tags are the versions, so deleting
// one untags it and tagging points a new tag at its manifest. Everything else
// in the catalog deletes versions and rebuilds the feed's indexes.

import type { BulkActionKind } from "../../shared/packages.ts";
import { audit } from "../core/audit.ts";
import {
  deleteVersion,
  getDistTags,
  getVersion,
  listFiles,
  deleteFile,
  setDistTag,
  updateVersion,
  type PackageRow,
} from "../core/catalog.ts";
import type { Services } from "../core/context.ts";
import { nowIso } from "../core/db.ts";
import { RegistryError } from "../core/errors.ts";
import { markPublishes } from "../core/provenance.ts";
import type { Repository } from "../core/repos.ts";
import { runMutation } from "../formats/npm/common.ts";
import * as oci from "../formats/oci/store.ts";
import { deleteRelease } from "../formats/releases/service.ts";
import type { FormatId } from "@gitmatrix/formats/info";

const YANKABLE = new Set<FormatId>(["cargo", "pypi"]);
const TAGGABLE = new Set<FormatId>(["npm", "oci"]);

/** What the console offers for a format. */
export function actionsFor(format: FormatId): BulkActionKind[] {
  const actions: BulkActionKind[] = ["delete"];
  if (YANKABLE.has(format)) actions.push("yank", "unyank");
  if (format === "npm") actions.push("deprecate", "unyank");
  if (TAGGABLE.has(format)) actions.push("tag");
  return actions;
}

interface Target {
  services: Services;
  feed: Repository;
  pkg: PackageRow;
}

/**
 * Applies `action` to `versions` of one package. Permission checks are the
 * caller's; this reports per version so one bad version doesn't sink a batch.
 */
export async function applyToVersions(
  target: Target,
  action: BulkActionKind,
  versions: string[],
  options: { tag?: string; reason?: string } = {},
): Promise<{ done: string[]; failed: { version: string; error: string }[] }> {
  const { services, feed, pkg } = target;
  if (!actionsFor(feed.format).includes(action)) {
    throw RegistryError.badRequest(`${feed.format} packages can't be ${verb(action)}.`);
  }
  if (action === "tag" && (!options.tag || versions.length !== 1)) {
    throw RegistryError.badRequest("Tag exactly one version, and name the tag.");
  }
  const done: string[] = [];
  const failed: { version: string; error: string }[] = [];

  if (feed.format === "npm") {
    // One mutation for the batch: the package document is rewritten once.
    try {
      await npmUpdate(target, action, versions, options);
      done.push(...versions);
    } catch (error) {
      for (const version of versions) failed.push({ version, error: message(error) });
    }
  } else {
    for (const version of versions) {
      try {
        await applyOne(target, action, version, options);
        done.push(version);
      } catch (error) {
        failed.push({ version, error: message(error) });
      }
    }
    if (done.length > 0 && rebuildsIndexes(feed.format)) {
      await services.repoObject(feed).requestRebuild(feed.id);
    }
  }

  if (done.length > 0) {
    await audit(services.db, await services.actor(), `${feed.format}.${action}`, {
      repoId: feed.id,
      target: pkg.name,
      detail: {
        versions: done.slice(0, 200),
        count: done.length,
        ...(options.tag ? { tag: options.tag } : {}),
        via: "console",
      },
    });
  }
  return { done, failed };
}

function rebuildsIndexes(format: FormatId): boolean {
  return format !== "oci" && format !== "generic" && format !== "releases";
}

async function applyOne(
  { services, feed, pkg }: Target,
  action: BulkActionKind,
  version: string,
  options: { tag?: string; reason?: string },
): Promise<void> {
  const db = services.db;
  switch (feed.format) {
    case "oci": {
      const reference = version;
      if (action === "tag") {
        const digest = reference.startsWith("sha256:")
          ? reference
          : await oci.tagDigest(db, feed.id, pkg.name, reference);
        if (!digest || !(await oci.getManifest(db, feed.id, pkg.name, digest))) {
          throw RegistryError.notFound(`${pkg.name}:${reference} is gone`);
        }
        await oci.setTag(db, feed.id, pkg.name, options.tag as string, digest);
        return;
      }
      if (reference.startsWith("sha256:")) {
        if (!(await oci.deleteManifest(db, feed.id, pkg.name, reference))) throw gone(pkg, version);
      } else {
        const digest = await oci.tagDigest(db, feed.id, pkg.name, reference);
        if (!digest || !(await oci.deleteTag(db, feed.id, pkg.name, reference))) {
          throw gone(pkg, version);
        }
        if (feed.config.retention?.deleteUntagged) {
          await oci.pruneUntagged(db, feed.id, pkg.name, digest);
        }
      }
      await markPublishes(db, pkg.id, version, "deleted");
      return;
    }
    case "generic": {
      let deleted = 0;
      for (const file of await listFiles(db, feed.id, { prefix: `${pkg.name}/${version}/` })) {
        if (await deleteFile(db, feed.id, file.path)) deleted++;
      }
      if (await deleteFile(db, feed.id, `${pkg.name}/${version}`)) deleted++;
      if (!deleted) throw gone(pkg, version);
      await markPublishes(db, pkg.id, version, "deleted");
      return;
    }
    case "releases":
      await deleteRelease(services, feed.key, pkg.name, version);
      return;
    default: {
      const row = await getVersion(db, pkg.id, version);
      if (!row) throw gone(pkg, version);
      if (action === "delete") {
        await deleteVersion(db, row.id);
      } else {
        await updateVersion(db, row.id, {
          status: action === "yank" ? "yanked" : "active",
          statusReason: action === "yank" ? (options.reason ?? null) : null,
        });
      }
      await db
        .updateTable("packages")
        .set({ updated_at: nowIso() })
        .where("id", "=", pkg.id)
        .execute();
    }
  }
}

/** npm keeps a package document; its mutation keeps files, tags and `latest` right. */
async function npmUpdate(
  { services, feed, pkg }: Target,
  action: BulkActionKind,
  versions: string[],
  options: { tag?: string; reason?: string },
): Promise<void> {
  const tags = await getDistTags(services.db, pkg.id);
  const deprecations: Record<string, string | null> = {};
  if (action === "deprecate") {
    for (const v of versions) deprecations[v] = options.reason?.trim() || "Deprecated";
  } else if (action === "unyank") {
    for (const v of versions) deprecations[v] = null;
  }
  if (action === "tag") {
    // The mutation drops tags it isn't sent, so send them all.
    tags[options.tag as string] = versions[0] as string;
  }
  await runMutation(services, feed, "update", {
    name: pkg.name,
    rev: null,
    remove: action === "delete" ? versions : [],
    allowRemove: action === "delete",
    deprecations,
    distTags: tags,
  });
  if (action === "tag") await setDistTag(services.db, pkg.id, options.tag as string, versions[0]!);
}

function gone(pkg: PackageRow, version: string): RegistryError {
  return RegistryError.notFound(`${pkg.name}@${version} doesn't exist`);
}

function verb(action: BulkActionKind): string {
  return {
    delete: "deleted",
    yank: "yanked",
    unyank: "restored",
    deprecate: "deprecated",
    tag: "tagged",
  }[action];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
