import { DurableObject } from "cloudflare:workers";

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

export class LoginDO extends DurableObject<Env> {
  async start(state: LoginState): Promise<void> {
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(state.expiresAt);
  }

  async peek(): Promise<LoginState | null> {
    const state = await this.ctx.storage.get<LoginState>("state");
    if (!state || state.expiresAt < Date.now()) return null;
    return state;
  }

  async complete(token: string): Promise<boolean> {
    const state = await this.peek();
    if (!state || state.status !== "pending") return false;
    await this.ctx.storage.put("state", { ...state, status: "done", token });
    return true;
  }

  /** Returns the token once, then forgets it. */
  async take(
    doneSecretHash: string,
  ): Promise<{ status: LoginState["status"]; token?: string } | null> {
    const state = await this.peek();
    if (!state || state.doneSecretHash !== doneSecretHash) return null;
    if (state.status !== "done") return { status: state.status };
    await this.ctx.storage.put("state", { ...state, status: "taken", token: undefined });
    return { status: "done", token: state.token };
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
