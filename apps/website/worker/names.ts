// Space handles occupy the root URL namespace. Person and Organization names
// have their own explicit routes; all share the same conservative path rules.

/** Top-level paths a Space must never shadow: app routes and registry prefixes. */
export const RESERVED_SLUGS = new Set([
  // App routes (src/appRoutes.tsx) and the Worker's own prefixes.
  "agent-work",
  "accounts",
  "organizations",
  "spaces",
  "api",
  "assets",
  "ci",
  "cli-auth",
  "device",
  "highlights",
  "instance",
  "knowledge",
  "needs-you",
  "new",
  "packages",
  "release-notes",
  "settings",
  "signin",
  "signout",
  "timelines",
  "tracker",
  // Package protocols (registry/app.ts).
  "v2",
  "npm",
  "pypi",
  "maven",
  "cargo",
  "go",
  "helm",
  "apt",
  "rpm",
  "brew",
  "generic",
  "releases",
  // Names people would read as the site itself.
  "admin",
  "gitmatrix",
  "login",
  "logout",
  "root",
  "support",
]);

/** Lowercase letters, digits and single hyphens, 1–39 characters, like GitHub. */
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

/** Why a username can't be used, or null when it can (uniqueness is checked separately). */
export function slugProblem(slug: string): string | null {
  if (!SLUG.test(slug))
    return "Use 1 to 39 lowercase letters, digits or single hyphens, starting and ending with a letter or digit.";
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved. Pick another username.`;
  return null;
}
