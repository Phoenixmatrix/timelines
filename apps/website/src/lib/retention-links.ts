// Where a retention category and its "Clean up now" live (CORE-210's Data
// retention pages), for the usage report's drill-down (CORE-209): the
// category's row, with "Clean up now" preselecting it.

import type { UsageCategoryLink } from "../../shared/usage.ts";

export const RETENTION_PAGES: {
  /** An account category: its row on the account's Data retention page. */
  account: ((owner: string, category: string) => string) | null;
  /** A site category: its row on the site's Data retention page. */
  site: ((category: string) => string) | null;
} = {
  account: (owner, category) =>
    `/settings/retention?owner=${encodeURIComponent(owner)}&cleanup=${encodeURIComponent(category)}#category-${category}`,
  site: (category) =>
    `/settings/site-retention?cleanup=${encodeURIComponent(category)}#category-${category}`,
};

export function retentionLink(category: UsageCategoryLink, owner: string | null): string | null {
  if (category.scope === "site") return RETENTION_PAGES.site?.(category.id) ?? null;
  return owner ? (RETENTION_PAGES.account?.(owner, category.id) ?? null) : null;
}
