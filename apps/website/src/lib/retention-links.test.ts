import { expect, test } from "vite-plus/test";
import type { UsageCategoryLink, UsageReport } from "../../shared/usage.ts";
import { retentionLink } from "./retention-links.ts";

const category: UsageCategoryLink = {
  id: "assistant-chats",
  label: "Assistant chats",
  description: "Personal conversations",
  scope: "person",
};
const subject = { id: "same-legacy-id", slug: "alex", displayName: "Alex" };

test("personal retention links never become Space cleanup links for a matching identity", () => {
  expect(retentionLink(category, { scope: "person", subject })).toBe(
    "/settings/retention?person=alex&cleanup=assistant-chats#category-assistant-chats",
  );
  expect(retentionLink(category, { scope: "space", subject })).toBeNull();
  expect(retentionLink(category, { scope: "instance", subject: null })).toBeNull();
});

test("Space cleanup and Instance cleanup retain their explicit scope", () => {
  const spaceCategory = { ...category, id: "previews", scope: "space" as const };
  expect(retentionLink(spaceCategory, { scope: "space", subject })).toBe(
    "/settings/retention?space=alex&cleanup=previews#category-previews",
  );
  expect(retentionLink(spaceCategory, { scope: "person", subject })).toBeNull();
  expect(
    retentionLink({ ...category, scope: "instance" }, { scope: "instance", subject: null }),
  ).toBe("/settings/site-retention?cleanup=assistant-chats#category-assistant-chats");
});

test("missing report subjects cannot create an unscoped personal or Space link", () => {
  for (const scope of ["person", "space"] as const) {
    const report: Pick<UsageReport, "scope" | "subject"> = { scope, subject: null };
    expect(retentionLink({ ...category, scope }, report)).toBeNull();
  }
});
