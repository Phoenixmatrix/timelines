/**
 * Paths the Worker answers before static assets (cloudflare.config.ts,
 * `assets.runWorkerFirst`): the API and git smart-HTTP endpoints must never
 * fall through to index.html, nor must the package protocols, /v2 (OCI) and
 * /<format>/… (registry/app.ts). A timeline preview runs the Worker first for
 * everything, behind its access gate, and uses this to tell the two apart
 * (worker/preview.ts).
 */
export const WORKER_FIRST = [
  "/api/*",
  "/*.git/*",
  "/v2/*",
  "/npm/*",
  "/pypi/*",
  "/maven/*",
  "/cargo/*",
  "/go/*",
  "/helm/*",
  "/apt/*",
  "/rpm/*",
  "/brew/*",
  "/generic/*",
  "/releases/*",
];

const patterns = WORKER_FIRST.map(
  (glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`),
);

/** Whether the Worker (not the static assets) answers this path. */
export function workerFirst(path: string): boolean {
  return patterns.some((pattern) => pattern.test(path));
}
