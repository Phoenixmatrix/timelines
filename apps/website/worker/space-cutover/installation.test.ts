import { describe, expect, test, vi } from "vite-plus/test";
import { d1, migratedDatabase, migratedRegistryDatabase } from "../testing/d1.ts";
import {
  installCutoverTestControl,
  cutoverTestManifest,
  CUTOVER_TEST_CHECKPOINT,
} from "../testing/space-cutover.ts";
import { SpaceCutover } from "./control.ts";
import { ensureInstallationAdmitted, initializeFreshSpaceInstallation } from "./installation.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import {
  cachedAdmission,
  forgetCachedAdmission,
  peekCachedAdmission,
} from "../durable/cutover-admission.ts";
import { Timing } from "../timing.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    public ctx: DurableObjectState;
    public env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));

function fixture() {
  const application = migratedDatabase();
  const registry = migratedRegistryDatabase();
  const env = { DB: d1(application), REGISTRY_DB: d1(registry) } as Env;
  const journal = installCutoverTestControl(env);
  return {
    application,
    registry,
    env,
    ...journal,
    close() {
      journal.close();
      application.close();
      registry.close();
    },
  };
}

describe("independent native v4 installation authority", () => {
  test("real migrations preserve static rows, establish exact authority, then permit atomic seed", async () => {
    const f = fixture();
    try {
      const prices = f.application.prepare("SELECT * FROM cloudflare_prices ORDER BY rowid").all();
      const limits = f.application.prepare("SELECT * FROM environment_limits ORDER BY rowid").all();
      const backfill = f.registry.prepare("SELECT * FROM artifact_backfill ORDER BY rowid").all();
      expect(prices.length).toBeGreaterThan(0);
      expect(limits.length).toBeGreaterThan(0);
      expect(backfill.length).toBeGreaterThan(0);
      expect(f.control.admission(4)).toEqual({ allowed: false, epoch: 0 });
      expect(() => f.control.acquire("http-git-registry", 4)).toThrow("fenced");
      await initializeFreshSpaceInstallation(f.env);
      expect(f.control.status()).toBeNull();
      expect(f.control.freshStatus()).toMatchObject({
        phase: "active",
        contractVersion: 4,
        epoch: 0,
      });
      expect(f.control.admission(4)).toEqual({ allowed: true, epoch: 0 });
      expect(f.control.admission(3).allowed).toBe(false);
      expect(f.control.admission(5).allowed).toBe(false);
      const ticket = f.control.acquire("http-git-registry", 4);
      f.control.assertTicket(ticket.ticket, 0, 4);
      expect(() => f.control.assertTicket(ticket.ticket, 0, 3)).toThrow("mismatch");
      await f.env.DB.batch([
        f.env.DB.prepare(
          "INSERT INTO accounts(id,kind,slug,display_name) VALUES('person','user','person','Person')",
        ),
        f.env.DB.prepare(
          "INSERT INTO organizations(id,slug,display_name,kind,personal_account_id,default_space_id) VALUES('org','org','Personal','personal','person','space')",
        ),
        f.env.DB.prepare(
          "INSERT INTO spaces(id,organization_id,slug,display_name) VALUES('space','org','space','General')",
        ),
      ]);
      expect(f.application.prepare("SELECT id FROM spaces").all()).toEqual([{ id: "space" }]);
      const repoColumns = f.application.prepare("PRAGMA table_info(repos)").all();
      expect(repoColumns.some((column) => column.name === "owner_id")).toBe(false);
      expect(repoColumns.find((column) => column.name === "space_id")?.notnull).toBe(1);
      expect(f.application.prepare("SELECT * FROM cloudflare_prices ORDER BY rowid").all()).toEqual(
        prices,
      );
      expect(
        f.application.prepare("SELECT * FROM environment_limits ORDER BY rowid").all(),
      ).toEqual(limits);
      expect(f.registry.prepare("SELECT * FROM artifact_backfill ORDER BY rowid").all()).toEqual(
        backfill,
      );
      for (const db of [f.application, f.registry])
        expect(
          db.prepare("SELECT fenced,bypass,migration_epoch FROM _space_cutover_fence").get(),
        ).toMatchObject({ fenced: 0, bypass: 0, migration_epoch: 0 });
      Reflect.set(f.env, "CI_VERSION", { id: "compatible-release", tag: "b".repeat(40) });
      Reflect.set(f.env, "CUTOVER_DEPLOYMENT_CHECKPOINT", "b".repeat(40));
      const cold = new SpaceCutover(f.state.ctx, f.env);
      expect(cold.admission(4).allowed).toBe(true);
      await initializeFreshSpaceInstallation(f.env);
      cold.assertTicket(ticket.ticket, 0, 4);
      cold.release(ticket.ticket);
      await expect(
        cold.prepare(cutoverTestManifest(), CUTOVER_TEST_CHECKPOINT, "human", "secret"),
      ).rejects.toThrow("Forward migration");
    } finally {
      f.close();
    }
  });

  test("nonempty legacy installation refuses without touching schema, rows, or leaving maintenance authority", async () => {
    const f = fixture();
    try {
      f.application.exec(
        "INSERT INTO accounts(id,kind,slug,display_name) VALUES('old','user','old','Old')",
      );
      const schema = f.application
        .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
        .all();
      const fence = f.application.prepare("SELECT * FROM _space_cutover_fence").get();
      await expect(initializeFreshSpaceInstallation(f.env)).rejects.toThrow(
        "fresh_install_nonempty:accounts",
      );
      expect(f.control.freshStatus()).toBeNull();
      expect(f.control.admission(3).allowed).toBe(true);
      expect(f.control.admission(4).allowed).toBe(false);
      expect(f.application.prepare("SELECT id FROM accounts").all()).toEqual([{ id: "old" }]);
      expect(
        f.application.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(),
      ).toEqual(schema);
      expect(f.application.prepare("SELECT * FROM _space_cutover_fence").get()).toEqual(fence);
    } finally {
      f.close();
    }
  });

  test("foreign storage authority and active legacy tickets cannot authorize native initialization", async () => {
    const f = fixture();
    try {
      const ticket = f.control.acquire("queue", 3);
      await expect(f.control.advanceFreshInstallation(null)).rejects.toThrow("active_tickets");
      f.control.release(ticket.ticket);
      f.registry.exec("UPDATE _space_cutover_fence SET run_id='foreign',authority_token='foreign'");
      await expect(initializeFreshSpaceInstallation(f.env)).rejects.toThrow(
        "foreign_storage_authority",
      );
      expect(f.control.freshStatus()).toBeNull();
      expect(f.control.admission(4).allowed).toBe(false);
    } finally {
      f.close();
    }
  });

  test("cold resumes every bounded advance and rejects concurrent/stale advances and a stale D1 nonce", async () => {
    const f = fixture();
    try {
      const first = f.control.advanceFreshInstallation(null);
      await expect(f.control.advanceFreshInstallation(null)).rejects.toThrow("busy");
      const previous = await first;
      expect(f.control.admission(3).allowed).toBe(false);
      await f.control.advanceFreshInstallation(previous);
      await expect(f.control.advanceFreshInstallation(previous)).rejects.toThrow("stale_advance");
      let testedNonce = false;
      for (let step = 0; step < 1000; step++) {
        const cold = new SpaceCutover(f.state.ctx, f.env);
        const status = cold.freshStatus()!;
        if (status.phase === "active") break;
        if (!testedNonce && status.phase === "initialize") {
          const nonce = f.application
            .prepare("SELECT authority_token FROM _space_cutover_fence")
            .get()!.authority_token;
          f.application.exec("UPDATE _space_cutover_fence SET authority_token='stale'");
          await expect(cold.advanceFreshInstallation(status)).rejects.toThrow();
          expect(cold.admission(4).allowed).toBe(false);
          f.application.prepare("UPDATE _space_cutover_fence SET authority_token=?").run(nonce!);
          testedNonce = true;
        }
        await cold.advanceFreshInstallation(cold.freshStatus());
      }
      expect(testedNonce).toBe(true);
      expect(f.control.freshStatus()?.phase).toBe("active");
      await f.control.verifyFreshInstallation();
      f.registry.exec("UPDATE _space_cutover_fence SET authority_token='foreign'");
      await expect(initializeFreshSpaceInstallation(f.env)).rejects.toThrow("authority_mismatch");
    } finally {
      f.close();
    }
  });
  test("a committed D1 mutation with a lost response replays safely from the independent cursor", async () => {
    const f = fixture();
    try {
      for (let call = 0; call < 1000 && f.control.freshStatus()?.phase !== "initialize"; call++)
        await f.control.advanceFreshInstallation(f.control.freshStatus());
      expect(f.control.freshStatus()?.phase).toBe("initialize");
      const batch = f.env.DB.batch.bind(f.env.DB);
      let committed = 0;
      const spy = vi.spyOn(f.env.DB, "batch").mockImplementation(async (statements) => {
        const result = await batch(statements);
        if (++committed === 3) throw new Error("lost D1 response after commit");
        return result;
      });
      await expect(f.control.advanceFreshInstallation(f.control.freshStatus())).rejects.toThrow(
        "lost D1 response",
      );
      spy.mockRestore();
      const cold = new SpaceCutover(f.state.ctx, f.env);
      expect(cold.admission(4).allowed).toBe(false);
      await initializeFreshSpaceInstallation(f.env);
      await cold.verifyFreshInstallation();
      expect(cold.admission(4)).toEqual({ allowed: true, epoch: 0 });
    } finally {
      f.close();
    }
  });

  test("registry legacy rows refuse before either store is changed", async () => {
    const f = fixture();
    try {
      f.registry.exec(
        "CREATE TABLE legacy_content(id TEXT PRIMARY KEY); INSERT INTO legacy_content VALUES('keep')",
      );
      const appSchema = f.application
        .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
        .all();
      const registrySchema = f.registry
        .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
        .all();
      await expect(initializeFreshSpaceInstallation(f.env)).rejects.toThrow(
        "fresh_install_nonempty:legacy_content",
      );
      expect(f.control.freshStatus()).toBeNull();
      expect(
        f.application.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(),
      ).toEqual(appSchema);
      expect(
        f.registry.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(),
      ).toEqual(registrySchema);
      expect(f.registry.prepare("SELECT id FROM legacy_content").all()).toEqual([{ id: "keep" }]);
    } finally {
      f.close();
    }
  });

  test("a writer racing preflight is caught under fences and refusal releases both stores", async () => {
    const f = fixture();
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    let inserted = false;
    const spy = vi.spyOn(f.env.DB, "prepare").mockImplementation((sql) => {
      if (
        !inserted &&
        sql.startsWith(
          "SELECT run_id,migration_epoch,manifest_digest,authority_token,fenced,bypass",
        )
      ) {
        inserted = true;
        f.application.exec(
          "INSERT INTO accounts(id,kind,slug,display_name) VALUES('late','user','late','Late writer')",
        );
      }
      return prepare(sql);
    });
    try {
      await expect(initializeFreshSpaceInstallation(f.env)).rejects.toThrow(
        "fresh_install_nonempty:accounts",
      );
      expect(inserted).toBe(true);
      expect(f.control.freshStatus()).toBeNull();
      expect(f.control.admission(3).allowed).toBe(true);
      expect(f.control.admission(4).allowed).toBe(false);
      expect(f.application.prepare("SELECT id FROM accounts").all()).toEqual([{ id: "late" }]);
      for (const db of [f.application, f.registry])
        expect(db.prepare("SELECT fenced,bypass FROM _space_cutover_fence").get()).toEqual({
          fenced: 0,
          bypass: 0,
        });
      await expect(initializeFreshSpaceInstallation(f.env)).rejects.toThrow(
        "fresh_install_nonempty:accounts",
      );
      expect(f.control.freshStatus()).toBeNull();
    } finally {
      spy.mockRestore();
      f.close();
    }
  });
});

describe("absorbing native admission (CORE-439)", () => {
  const active = () => createFreshSpaceTestEnvironment();
  const entries = (timing: Timing) =>
    timing
      .header()
      .split(", ")
      .map((part) => part.split(";")[0] ?? "");

  test("an active installation refuses every transition out of active", async () => {
    const f = await active();
    try {
      const before = f.control.admission(4);
      expect(before).toEqual({ allowed: true, epoch: 0 });
      await expect(
        f.control.prepare(cutoverTestManifest(), CUTOVER_TEST_CHECKPOINT, "human", "secret"),
      ).rejects.toThrow("Forward migration");
      // Advancing an active installation is a no-op that reports it.
      const status = f.control.freshStatus();
      expect(await f.control.advanceFreshInstallation(status)).toEqual(status);
      const installation = Reflect.get(f.control, "fresh") as object;
      const save = Reflect.get(installation, "save") as (state: unknown) => void;
      const load = Reflect.get(installation, "load") as () => { phase: string };
      expect(() =>
        save.call(installation, { ...load.call(installation), phase: "opening" }),
      ).toThrow("space_cutover_admission_absorbing");
      const discard = Reflect.get(installation, "discard") as () => void;
      expect(() => discard.call(installation)).toThrow("space_cutover_admission_absorbing");
      expect(f.control.freshStatus()).toEqual(status);
      expect(f.control.admission(4)).toEqual(before);
    } finally {
      f.close();
    }
  });

  test("the fetch gate checks once, primes the isolate's admission, then skips the check", async () => {
    const f = await active();
    try {
      forgetCachedAdmission(f.env);
      const state = vi.spyOn(f.control, "installationState");
      const first = new Timing();
      await ensureInstallationAdmitted(f.env, first);
      expect(entries(first)).toEqual(
        expect.arrayContaining(["install-status", "install-fresh-verify", "admission-cache-miss"]),
      );
      const second = new Timing();
      await ensureInstallationAdmitted(f.env, second);
      expect(entries(second).filter((name) => name.startsWith("install-"))).toEqual([]);
      expect(entries(second)).toContain("admission-cache-hit");
      expect(state).toHaveBeenCalledTimes(1);
      expect(peekCachedAdmission(f.env)).toEqual({ allowed: true, epoch: 0 });
    } finally {
      f.close();
    }
  });

  test("a failed check is not remembered", async () => {
    const f = await active();
    try {
      forgetCachedAdmission(f.env);
      const verify = vi
        .spyOn(f.control, "verifyFreshInstallation")
        .mockRejectedValueOnce(new Error("fresh_install_authority_mismatch"));
      await expect(ensureInstallationAdmitted(f.env)).rejects.toThrow("authority_mismatch");
      expect(peekCachedAdmission(f.env)).toBeNull();
      await ensureInstallationAdmitted(f.env);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(peekCachedAdmission(f.env)).toEqual({ allowed: true, epoch: 0 });
    } finally {
      f.close();
    }
  });

  test("a plain admission read does not let a later gate skip verification", async () => {
    const f = await active();
    try {
      forgetCachedAdmission(f.env);
      expect(await cachedAdmission(f.env)).toEqual({ allowed: true, epoch: 0 });
      expect(peekCachedAdmission(f.env)).toBeNull();
      const verify = vi
        .spyOn(f.control, "verifyFreshInstallation")
        .mockRejectedValueOnce(new Error("fresh_install_authority_mismatch"));
      await expect(ensureInstallationAdmitted(f.env)).rejects.toThrow("authority_mismatch");
      expect(verify).toHaveBeenCalledTimes(1);
      expect(peekCachedAdmission(f.env)).toBeNull();
    } finally {
      f.close();
    }
  });

  test("a closed migration is never primed", async () => {
    const env = {} as Env;
    const journal = installCutoverTestControl(env);
    try {
      await journal.fence();
      await expect(ensureInstallationAdmitted(env)).rejects.toThrow(
        "space_cutover_requires_reviewed_migration",
      );
      expect(peekCachedAdmission(env)).toBeNull();
    } finally {
      journal.close();
    }
  });
});

describe("a control object still on the previous release (Durable Object code update)", () => {
  /** What workerd throws when a Durable Object's running class lacks a method. */
  const missingMethod = (name: string) =>
    new TypeError(`The RPC receiver does not implement the method "${name}".`);
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  test("the gate admits through status/freshStatus/verify, and primes nothing", async () => {
    const f = await createFreshSpaceTestEnvironment();
    try {
      forgetCachedAdmission(f.env);
      const warn = quiet();
      const state = vi
        .spyOn(f.control, "installationState")
        .mockRejectedValue(missingMethod("installationState"));
      const verify = vi.spyOn(f.control, "verifyFreshInstallation");
      const timing = new Timing();
      await ensureInstallationAdmitted(f.env, timing);
      // The previous release's round trips, in its order (the object calls
      // status() itself too, so count them from the Worker's side).
      expect(
        timing
          .header()
          .split(", ")
          .map((part) => part.split(";")[0]),
      ).toEqual([
        "install-status",
        "install-run",
        "install-fresh-status",
        "install-fresh-verify",
        "admission-cache-miss",
        "install-rpc-skew",
        "total",
      ]);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("installationState"));
      expect(peekCachedAdmission(f.env)).toBeNull();
      // Unprimed: the next request checks again.
      await ensureInstallationAdmitted(f.env);
      expect(state).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      f.close();
    }
  });

  test("the previous release's loop still installs a fresh instance", async () => {
    const f = fixture();
    try {
      quiet();
      vi.spyOn(f.control, "installationState").mockRejectedValue(
        missingMethod("installationState"),
      );
      await initializeFreshSpaceInstallation(f.env);
      expect(f.control.freshStatus()?.phase).toBe("active");
      expect(f.control.admission(4)).toEqual({ allowed: true, epoch: 0 });
    } finally {
      f.close();
    }
  });

  test("a run's admission decides, still fail-closed, and is never primed", async () => {
    const env = {} as Env;
    const journal = installCutoverTestControl(env);
    try {
      quiet();
      await journal.fence();
      vi.spyOn(journal.control, "installationState").mockRejectedValue(
        missingMethod("installationState"),
      );
      const admission = vi.spyOn(journal.control, "admission");
      await expect(ensureInstallationAdmitted(env)).rejects.toThrow(
        "space_cutover_requires_reviewed_migration",
      );
      expect(admission).toHaveBeenCalledTimes(1);
      admission.mockReturnValueOnce({ allowed: true, epoch: 1 });
      await ensureInstallationAdmitted(env);
      expect(peekCachedAdmission(env)).toBeNull();
    } finally {
      journal.close();
    }
  });

  test("any other failure of installationState still refuses", async () => {
    const f = await createFreshSpaceTestEnvironment();
    try {
      forgetCachedAdmission(f.env);
      const state = vi
        .spyOn(f.control, "installationState")
        .mockRejectedValueOnce(new Error("control unavailable"))
        .mockRejectedValueOnce(missingMethod("somethingElse"))
        .mockRejectedValueOnce(new Error('does not implement the method "installationState"'));
      const status = vi.spyOn(f.control, "status");
      const fresh = vi.spyOn(f.control, "freshStatus");
      await expect(ensureInstallationAdmitted(f.env)).rejects.toThrow("control unavailable");
      await expect(ensureInstallationAdmitted(f.env)).rejects.toThrow("somethingElse");
      await expect(ensureInstallationAdmitted(f.env)).rejects.toThrow("does not implement");
      expect(state).toHaveBeenCalledTimes(3);
      expect(status).not.toHaveBeenCalled();
      expect(fresh).not.toHaveBeenCalled();
      expect(peekCachedAdmission(f.env)).toBeNull();
    } finally {
      f.close();
    }
  });
});
