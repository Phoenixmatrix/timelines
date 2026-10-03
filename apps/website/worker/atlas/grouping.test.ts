import { describe, expect, test } from "vite-plus/test";
import {
  groupCapabilities,
  GROUPING_VERSION,
  MAX_NEIGHBORS,
  type GroupingInput,
} from "./grouping.ts";

const f = (path: string) => `file:${path}`;

/** Billing spans three directories; deployment is its own capability; one file has no evidence. */
function fixture(): GroupingInput {
  const files = [
    "src/billing/charge.ts",
    "src/billing/invoice.ts",
    "web/checkout.ts",
    "web/cart.ts",
    "lib/refunds/ledger.ts",
    "lib/refunds/refund.ts",
    "ops/deploy.ts",
    "ops/rollback.ts",
    "scripts/release.ts",
    "scripts/canary.ts",
    "misc/notes.ts",
  ].map(f);
  const imports = [
    ["web/checkout.ts", "src/billing/charge.ts"],
    ["web/cart.ts", "web/checkout.ts"],
    ["src/billing/charge.ts", "lib/refunds/ledger.ts"],
    ["lib/refunds/refund.ts", "lib/refunds/ledger.ts"],
    ["src/billing/invoice.ts", "src/billing/charge.ts"],
    ["scripts/release.ts", "ops/deploy.ts"],
    ["scripts/canary.ts", "ops/rollback.ts"],
    ["ops/rollback.ts", "ops/deploy.ts"],
  ].map(([src, dst]) => ({ src: f(src!), dst: f(dst!) }));
  const mention = (path: string, ...concepts: string[]) =>
    concepts.map((concept) => ({ file: f(path), concept: `concept:${concept}` }));
  const mentions = [
    ...mention("src/billing/charge.ts", "payments", "ledger", "code"),
    ...mention("src/billing/invoice.ts", "payments", "invoices", "code"),
    ...mention("web/checkout.ts", "payments", "cart", "code"),
    ...mention("web/cart.ts", "cart", "code"),
    ...mention("lib/refunds/ledger.ts", "ledger", "payments", "code"),
    ...mention("lib/refunds/refund.ts", "ledger", "refunds", "code"),
    ...mention("ops/deploy.ts", "deployment", "code"),
    ...mention("ops/rollback.ts", "deployment", "rollback", "code"),
    ...mention("scripts/release.ts", "deployment", "releases", "code"),
    ...mention("scripts/canary.ts", "rollback", "releases", "code"),
    ...mention("misc/notes.ts", "code"),
  ];
  const conceptNames = new Map(
    [
      "payments",
      "ledger",
      "invoices",
      "cart",
      "refunds",
      "deployment",
      "rollback",
      "releases",
      "code",
    ].map((c) => [`concept:${c}`, c[0]!.toUpperCase() + c.slice(1)]),
  );
  return { files, imports, mentions, conceptNames };
}

const capabilityOf = (grouping: ReturnType<typeof groupCapabilities>, path: string) =>
  grouping.members.find((m) => m.file === f(path))?.capability;

describe("capability grouping", () => {
  test("identical inputs give identical groups, whatever their order", () => {
    const input = fixture();
    const first = groupCapabilities(input);
    expect(groupCapabilities(input)).toEqual(first);
    const shuffled: GroupingInput = {
      ...input,
      files: [...input.files].reverse(),
      imports: [...input.imports].reverse(),
      mentions: [...input.mentions].reverse(),
    };
    expect(groupCapabilities(shuffled)).toEqual(first);
    expect(first.version).toBe(GROUPING_VERSION);
  });

  test("a capability spans directories when the evidence does, not by folder", () => {
    const grouping = groupCapabilities(fixture());
    const billing = capabilityOf(grouping, "src/billing/charge.ts");
    expect(billing).toBeTruthy();
    // Checkout (web/) and the ledger (lib/refunds/) belong with billing (src/billing/).
    expect(capabilityOf(grouping, "web/checkout.ts")).toBe(billing);
    expect(capabilityOf(grouping, "lib/refunds/ledger.ts")).toBe(billing);
    // Deployment spans ops/ and scripts/, apart from billing.
    const deploy = capabilityOf(grouping, "ops/deploy.ts");
    expect(deploy).toBeTruthy();
    expect(deploy).not.toBe(billing);
    expect(capabilityOf(grouping, "scripts/release.ts")).toBe(deploy);
    const cap = grouping.capabilities.find((c) => c.id === billing)!;
    expect(cap.concepts.map((c) => c.name)).toContain("Payments");
    expect(cap.name).toMatch(/Payments|Ledger|Cart/);
  });

  test("files without evidence are unclassified, never a capability", () => {
    const grouping = groupCapabilities(fixture());
    const notes = grouping.members.find((m) => m.file === f("misc/notes.ts"))!;
    // It only shares "code", which every file mentions: no evidence.
    expect(notes).toMatchObject({ capability: null, area: null, unclassified: "no-evidence" });
    expect(grouping.stats.unclassified).toBe(1);
  });

  test("every member's placement is explained by non-path evidence", () => {
    const grouping = groupCapabilities(fixture());
    for (const member of grouping.members.filter((m) => m.capability)) {
      expect(member.rationale.length).toBeGreaterThan(0);
      // Never the ubiquitous concept, never a directory.
      for (const e of member.rationale) expect(e.with).not.toBe("concept:code");
    }
    // Checkout's placement cites a concrete import link, not just shared words.
    const checkout = grouping.members.find((m) => m.file === f("web/checkout.ts"))!;
    expect(checkout.rationale.some((e) => e.kind === "imports" || e.kind === "imported-by")).toBe(
      true,
    );
  });

  test("each file has one primary placement and counts are deduplicated", () => {
    const input = fixture();
    // A bridge file tied to both capabilities.
    input.files.push(f("web/deploy-button.ts"));
    input.imports.push(
      { src: f("web/deploy-button.ts"), dst: f("ops/deploy.ts") },
      { src: f("web/deploy-button.ts"), dst: f("web/checkout.ts") },
    );
    input.mentions.push(
      { file: f("web/deploy-button.ts"), concept: "concept:deployment" },
      { file: f("web/deploy-button.ts"), concept: "concept:cart" },
    );
    const grouping = groupCapabilities(input);
    expect(new Set(grouping.members.map((m) => m.file)).size).toBe(input.files.length);
    const placed = grouping.members.filter((m) => m.capability).length;
    expect(grouping.capabilities.reduce((n, c) => n + c.files, 0)).toBe(placed);
    expect(placed + grouping.stats.unclassified).toBe(input.files.length);
    const bridge = grouping.members.find((m) => m.file === f("web/deploy-button.ts"))!;
    expect(bridge.capability).toBeTruthy();
    expect(bridge.crossCutting.length).toBe(1);
    expect(bridge.crossCutting[0]!.capability).not.toBe(bridge.capability);
  });

  test("stays bounded and sub-quadratic on a large synthetic graph", () => {
    // 30,000 files in 600 clusters of 50: each imports 3 cluster-mates and
    // mentions 2 cluster concepts, plus one concept shared by a third of all files.
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const files: string[] = [];
    const imports: GroupingInput["imports"] = [];
    const mentions: GroupingInput["mentions"] = [];
    for (let c = 0; c < 600; c++)
      for (let k = 0; k < 50; k++) files.push(f(`m${c % 37}/c${c}/f${k}.ts`));
    files.forEach((file, i) => {
      const cluster = Math.floor(i / 50);
      for (let t = 0; t < 3; t++)
        imports.push({ src: file, dst: files[cluster * 50 + Math.floor(random() * 50)]! });
      for (let t = 0; t < 2; t++)
        mentions.push({ file, concept: `concept:c${cluster}-${Math.floor(random() * 4)}` });
      if (i % 3 === 0) mentions.push({ file, concept: "concept:common" });
    });
    const started = performance.now();
    const grouping = groupCapabilities({ files, imports, mentions, conceptNames: new Map() });
    const seconds = (performance.now() - started) / 1000;
    expect(grouping.stats.files).toBe(30_000);
    expect(grouping.stats.maxCandidates).toBeLessThanOrEqual(MAX_NEIGHBORS);
    // Linear-ish: far below the 4.5e8 pairs an all-pairs comparison would make.
    expect(grouping.stats.candidatePairs).toBeLessThan(30_000 * MAX_NEIGHBORS);
    expect(seconds).toBeLessThan(30);
    // Clusters are recovered: most cluster-mates share a capability.
    let same = 0;
    for (let c = 0; c < 600; c += 37) {
      const caps = files
        .slice(c * 50, c * 50 + 50)
        .map((file) => capabilityOf(grouping, file.slice(5)));
      const counts = new Map<string | null | undefined, number>();
      for (const cap of caps) counts.set(cap, (counts.get(cap) ?? 0) + 1);
      same += Math.max(...counts.values()) / 50;
    }
    expect(same / Math.ceil(600 / 37)).toBeGreaterThan(0.8);
  }, 60_000);
});
