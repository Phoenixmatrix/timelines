import { DurableObject } from "cloudflare:workers";
import {
  withCutoverAdmission,
  withCutoverAlarmAdmission,
} from "../../worker/durable/cutover-admission.ts";
import { reportCutoverRuntime } from "../../worker/durable/cutover-runtime.ts";
import {
  clearStorage,
  pendingRetirement,
  resetSoon,
  scheduleRetirement,
  settleRetirement,
  storageReport,
  type Purgeable,
  type PurgeReport,
} from "../../worker/durable/contract.ts";

/**
 * One per pending CLI web login (npm login --auth-type=web). The browser side
 * completes it with a freshly minted token; the CLI polls until it can take
 * the token exactly once.
 */
export interface LoginState {
  status: "pending" | "done" | "taken";
  doneSecretHash: string;
  token?: string;
  createdAt: number;
  expiresAt: number;
  hostname?: string;
  repo: string;
}

export class LoginDO extends DurableObject<Env> implements Purgeable {
  cutoverRuntime(runId: string) {
    return reportCutoverRuntime(this.env, runId, "registry-login");
  }

  async start(state: LoginState): Promise<void> {
    return withCutoverAdmission(this.env, "registry-login", async () => {
      await this.ctx.storage.put("state", state);
      await this.ctx.storage.setAlarm(state.expiresAt);
    });
  }

  async peek(): Promise<LoginState | null> {
    return withCutoverAdmission(this.env, "registry-login", () => this.#peek());
  }

  async #peek(): Promise<LoginState | null> {
    const state = await this.ctx.storage.get<LoginState>("state");
    if (!state || state.expiresAt < Date.now()) return null;
    return state;
  }

  async complete(token: string): Promise<boolean> {
    return withCutoverAdmission(this.env, "registry-login", async () => {
      const state = await this.#peek();
      if (!state || state.status !== "pending") return false;
      await this.ctx.storage.put("state", { ...state, status: "done", token });
      return true;
    });
  }

  /** Returns the token once, then forgets it. */
  async take(
    doneSecretHash: string,
  ): Promise<{ status: LoginState["status"]; token?: string } | null> {
    return withCutoverAdmission(this.env, "registry-login", async () => {
      const state = await this.#peek();
      if (!state || state.doneSecretHash !== doneSecretHash) return null;
      if (state.status !== "done") return { status: state.status };
      await this.ctx.storage.put("state", { ...state, status: "taken", token: undefined });
      return { status: "done" as const, token: state.token };
    });
  }

  // The purge contract (worker/durable/contract.ts, CORE-197). A login
  // cleans itself up when it expires; purge and retire only do it sooner.
  async purge(reason: string): Promise<PurgeReport> {
    const report = await withCutoverAdmission(this.env, "registry-login", () =>
      clearStorage(this.ctx.storage, reason),
    );
    resetSoon(this.ctx);
    return report;
  }

  retire(reason: string, name: string, delayMs?: number): Promise<void> {
    return withCutoverAdmission(this.env, "registry-login", () =>
      scheduleRetirement(this.ctx.storage, reason, name, delayMs),
    );
  }

  storageReport() {
    return withCutoverAdmission(this.env, "registry-login", () => storageReport(this.ctx.storage));
  }

  override async alarm(): Promise<void> {
    return withCutoverAlarmAdmission(this.env, "registry-login", this.ctx.storage, async () => {
      const retirement = await pendingRetirement(this.ctx.storage);
      if (retirement) {
        await settleRetirement({
          storage: this.ctx.storage,
          env: this.env,
          className: "RegistryLogin",
          retirement,
          busy: false,
          purge: (reason) => clearStorage(this.ctx.storage, reason),
        });
        return;
      }
      await this.ctx.storage.deleteAll();
    });
  }
}
