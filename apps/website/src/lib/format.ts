const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 days ago", from an ISO string or Unix seconds. */
export function timeAgo(when: string | number): string {
  const ms = typeof when === "number" ? when * 1000 : Date.parse(when);
  const seconds = Math.round((ms - Date.now()) / 1000);
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function fullDate(when: string | number): string {
  const ms = typeof when === "number" ? when * 1000 : Date.parse(when);
  return new Date(ms).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * A time in the viewer's zone with the zone named ("Oct 12, 2026, 8:00 PM
 * GMT+2"), for stored UTC instants whose zone matters; UTC is its title.
 */
export function zonedDate(when: string, timeZone?: string): string {
  return new Date(Date.parse(when)).toLocaleString("en", {
    // dateStyle/timeStyle can't be combined with timeZoneName.
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
