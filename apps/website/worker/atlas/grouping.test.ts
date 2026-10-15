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
    // 6,000 files in 120 clusters of 50: each imports 3 cluster-mates and
    // mentions 2 cluster concepts, plus one concept shared by a third of all files.
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const files: string[] = [];
    const imports: GroupingInput["imports"] = [];
    const mentions: GroupingInput["mentions"] = [];
    for (let c = 0; c < 120; c++)
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
    expect(grouping.stats.files).toBe(6_000);
    expect(grouping.stats.maxCandidates).toBeLessThanOrEqual(MAX_NEIGHBORS);
    // Linear-ish: far below the 1.8e7 pairs an all-pairs comparison would make.
    expect(grouping.stats.candidatePairs).toBeLessThan(6_000 * MAX_NEIGHBORS);
    expect(seconds).toBeLessThan(30);
    // Clusters are recovered: most cluster-mates share a capability.
    let same = 0;
    for (let c = 0; c < 120; c += 37) {
      const caps = files
        .slice(c * 50, c * 50 + 50)
        .map((file) => capabilityOf(grouping, file.slice(5)));
      const counts = new Map<string | null | undefined, number>();
      for (const cap of caps) counts.set(cap, (counts.get(cap) ?? 0) + 1);
      same += Math.max(...counts.values()) / 50;
    }
    expect(same / Math.ceil(120 / 37)).toBeGreaterThan(0.8);
  }, 60_000);

  test("a pair linked by one import is too little evidence for a capability", () => {
    const input = fixture();
    input.files.push(f("tools/a.ts"), f("tools/b.ts"));
    input.imports.push({ src: f("tools/a.ts"), dst: f("tools/b.ts") });
    const grouping = groupCapabilities(input);
    for (const path of ["tools/a.ts", "tools/b.ts"])
      expect(grouping.members.find((m) => m.file === f(path))).toMatchObject({
        capability: null,
        unclassified: "weak-evidence",
      });
    for (const c of grouping.capabilities) expect(c.files).toBeGreaterThanOrEqual(3);
    // Areas of dropped groups don't linger.
    const areaIds = new Set(grouping.areas.map((a) => a.id));
    for (const m of grouping.members) if (m.area) expect(areaIds.has(m.area)).toBe(true);
  });

  test("v3: lightly linked groups stay apart, their link a relation between them", () => {
    // Two tight cliques joined by a single import.
    const clique = (dir: string) => Array.from({ length: 5 }, (_, i) => f(`${dir}/f${i}.ts`));
    const a = clique("billing");
    const b = clique("deploy");
    const imports = [a, b].flatMap((ids) =>
      ids.flatMap((x) => ids.filter((y) => y !== x).map((y) => ({ src: x, dst: y }))),
    );
    imports.push({ src: a[0]!, dst: b[0]! });
    const g = groupCapabilities({
      files: [...a, ...b],
      imports,
      mentions: [],
      conceptNames: new Map(),
    });
    const capOf = (id: string) => g.members.find((m) => m.file === id)!.capability;
    expect(new Set(a.map(capOf)).size).toBe(1);
    expect(new Set(b.map(capOf)).size).toBe(1);
    expect(capOf(a[0]!)).not.toBe(capOf(b[0]!));
  });

  test("v3: small groups that link to each other combine before anything is unclassified", () => {
    // A path of four files: modularity splits it into two pairs, which together
    // are one small capability, not unclassified scraps.
    const files = ["a", "b", "c", "d"].map((x) => f(`path/${x}.ts`));
    const imports = [0, 1, 2].map((i) => ({ src: files[i + 1]!, dst: files[i]! }));
    const g = groupCapabilities({ files, imports, mentions: [], conceptNames: new Map() });
    expect(g.stats.unclassified).toBe(0);
    expect(new Set(g.members.map((m) => m.capability)).size).toBe(1);
  });

  test("v3: names never use a concept that carries no evidence", () => {
    const g = groupCapabilities(fixture());
    for (const c of g.capabilities) {
      expect(c.name).not.toMatch(/\bCode\b/);
      expect(c.concepts.map((x) => x.id)).not.toContain("concept:code");
    }
  });
});
