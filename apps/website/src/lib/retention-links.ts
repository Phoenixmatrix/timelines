// Usage drill-downs link only to retention policy in the report's exact scope.
import type { UsageCategoryLink, UsageReport } from "../../shared/usage.ts";

export function retentionLink(
  category: UsageCategoryLink,
  report: Pick<UsageReport, "scope" | "subject">,
): string | null {
  if (category.scope !== report.scope) return null;
  const cleanup = `cleanup=${encodeURIComponent(category.id)}#category-${encodeURIComponent(category.id)}`;
  if (report.scope === "instance") return `/settings/site-retention?${cleanup}`;
  if (!report.subject) return null;
  return `/settings/retention?${report.scope}=${encodeURIComponent(report.subject.slug)}&${cleanup}`;
}
