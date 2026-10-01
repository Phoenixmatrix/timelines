import {
  CheckCircleIcon,
  CircleDashedIcon,
  CircleNotchIcon,
  MinusCircleIcon,
  ProhibitIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { CiJobStatus, CiRunStatus, CiStepStatus } from "../../shared/api.ts";

type Status = CiRunStatus | CiJobStatus | CiStepStatus;

const LABEL: Record<Status, string> = {
  queued: "Queued",
  pending: "Waiting",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export function ciLabel(status: Status): string {
  return LABEL[status];
}

export function isActive(status: Status): boolean {
  return status === "queued" || status === "pending" || status === "running";
}

/** The icon for a run, job or step status, colored by outcome. */
export function CiStatusIcon({
  status,
  className = "size-4",
}: {
  status: Status;
  className?: string;
}) {
  const common = {
    weight: "fill" as const,
    className: `${className} shrink-0`,
    "aria-label": LABEL[status],
  };
  switch (status) {
    case "succeeded":
      return <CheckCircleIcon {...common} className={`${common.className} text-online`} />;
    case "failed":
      return <XCircleIcon {...common} className={`${common.className} text-danger-text`} />;
    case "running":
      return (
        <CircleNotchIcon
          {...common}
          weight="bold"
          className={`${common.className} animate-spin text-signal-line`}
        />
      );
    case "cancelled":
      return (
        <ProhibitIcon {...common} weight="bold" className={`${common.className} text-ink-faint`} />
      );
    case "skipped":
      return <MinusCircleIcon {...common} className={`${common.className} text-ink-faint`} />;
    default:
      return (
        <CircleDashedIcon
          {...common}
          weight="bold"
          className={`${common.className} text-ink-faint`}
        />
      );
  }
}

/** "1m 12s" between two timestamps (or until now). */
export function duration(from: string | null, to: string | null): string {
  if (!from) return "";
  const seconds = Math.max(
    0,
    Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
