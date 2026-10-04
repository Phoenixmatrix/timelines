// What a CI sandbox job's container provisions (CORE-210), so its wall time can
// be priced at Cloudflare's Containers rates (pages.ts "containers"): memory
// and disk are billed on the instance type's provisioned size while it runs,
// vCPU on active use only. Instance types as Cloudflare publishes them (the
// table on https://developers.cloudflare.com/containers/platform/pricing/ and
// /containers/platform/limits/, read 2026-10-04; catalog.test.ts checks this
// table against the saved pricing page).

import type { Instance } from "../ci/config.ts";

export interface InstanceSize {
  vcpu: number;
  memoryGib: number;
  diskGb: number;
}

export const INSTANCE_TYPES: Readonly<Record<string, InstanceSize>> = {
  lite: { vcpu: 1 / 16, memoryGib: 0.25, diskGb: 2 },
  basic: { vcpu: 1 / 4, memoryGib: 1, diskGb: 4 },
  "standard-1": { vcpu: 1 / 2, memoryGib: 4, diskGb: 8 },
  "standard-2": { vcpu: 1, memoryGib: 6, diskGb: 12 },
  "standard-3": { vcpu: 2, memoryGib: 8, diskGb: 16 },
  "standard-4": { vcpu: 4, memoryGib: 12, diskGb: 20 },
};

/** A job's instance when its spec names none (worker/ci/config.ts's default). */
export const DEFAULT_INSTANCE: Instance = "standard-1";

/** The provisioned size of an instance type; the default's for an unknown one. */
export function instanceSize(instance: string | null | undefined): InstanceSize {
  return INSTANCE_TYPES[instance ?? DEFAULT_INSTANCE] ?? INSTANCE_TYPES[DEFAULT_INSTANCE]!;
}
