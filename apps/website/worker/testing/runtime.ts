// Inert Workers runtime classes for Node-only fixtures. Production never aliases this module.
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint {}
export class WorkerEntrypoint {}
export class RpcTarget {}
export class EmailMessage {}
export const env = {};
