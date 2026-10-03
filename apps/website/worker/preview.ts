// Timeline previews of Gitmatrix itself (CORE-80; apps/website/README.md, "Gitmatrix's own
// previews"). A Worker Preview gets its own Durable Objects but shares
// everything else with production: Workflows, queues and their consumers,
// and any binding the config names. cloudflare.config.ts builds a preview
// (`isPreview`) without those bindings and with PREVIEW_MODE set; this guard
// is the second line, checked before every side effect that would reach
// production or the outside world, so a preview fails safe even if a binding
// slipped back in.

/** Effects a preview must never cause. */
export type ProductionEffect =
  | "email" // sign-in codes (Email Service)
  | "mirror" // pushes to GitHub and other hosts
  | "queue" // gitmatrix-jobs and gitmatrix-registry-jobs, consumed by production
  | "workflow"; // CI runs and knowledge builds

/** Whether this Worker is a timeline preview (the PREVIEW_MODE text binding). */
export function isPreview(env: object): boolean {
  return Reflect.get(env, "PREVIEW_MODE") === "true";
}

/**
 * Whether `effect` may happen here: always, except in a preview, where it is
 * skipped and logged. Callers return early when it says no.
 */
export function productionOnly(env: object, effect: ProductionEffect, what: string): boolean {
  if (!isPreview(env)) return true;
  console.log(`[preview] ${effect} is off in previews: skipped ${what}`);
  return false;
}

/** Thrown where an effect can't be skipped quietly (a person asked for it). */
export class PreviewModeError extends Error {
  readonly effect: ProductionEffect;
  constructor(effect: ProductionEffect, message: string) {
    super(message);
    this.name = "PreviewModeError";
    this.effect = effect;
  }
}
