// Where a retention category and its "Clean up now" live, for the usage
// report's drill-down (CORE-209). The data retention settings pages arrive with
// CORE-210, which fills in RETENTION_PAGES; until then the report names the
// category without a link, so it never links to a page that doesn't exist.

import type { UsageCategoryLink } from "../../shared/usage.ts";

export const RETENTION_PAGES: {
  /** An account category: its row on the account's Data retention page. */
  account: ((owner: string, category: string) => string) | null;
  /** A site category: its row on the site's Data retention page. */
  site: ((category: string) => string) | null;
} = { account: null, site: null };

export function retentionLink(category: UsageCategoryLink, owner: string | null): string | null {
  if (category.scope === "site") return RETENTION_PAGES.site?.(category.id) ?? null;
  return owner ? (RETENTION_PAGES.account?.(owner, category.id) ?? null) : null;
}
