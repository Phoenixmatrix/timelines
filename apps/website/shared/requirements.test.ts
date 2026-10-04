import { describe, expect, test } from "vite-plus/test";
import type { AgentCapabilities } from "./api.ts";
import {
  formatBytes,
  globMatch,
  hasRequirements,
  normalizeRequirements,
  parseBytes,
  parseRequirements,
  requirementsText,
  RequirementError,
  unmetRequirements,
  unmetText,
  withoutTerm,
} from "./requirements.ts";

const GiB = 2 ** 30;
function agent(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return {
    version: 1,
    harness: "claude-code",
    model: "claude-opus-4-5",
    environment: {
      os: "linux",
      arch: "x86_64",
      runtime: "host",
      cpuCount: 8,
      memoryBytes: 32 * GiB,
    },
    tags: ["UX", "data"],
    skills: [{ name: "playwright", description: "", source: "detected" }],
    ...overrides,
  };
}

describe("requirement text", () => {
  test("parses every term, normalizes and writes back the same", () => {
    const requires = parseRequirements(
      "tag:UX tags:data,ux skill:Playwright model:claude-opus-*,gpt-5* harness:claude-code os:linux arch:x86_64 runtime:host memory>=16GiB cpus>=4",
    );
    expect(requires).toEqual({
      tags: ["ux", "data"],
      skills: ["playwright"],
      models: ["claude-opus-*", "gpt-5*"],
      harnesses: ["claude-code"],
      os: ["linux"],
      arch: ["x86_64"],
      runtime: ["host"],
      minMemory: 16 * GiB,
      minCpus: 4,
    });
    const text = requirementsText(requires);
    expect(text).toBe(
      "tag:ux tag:data skill:playwright model:claude-opus-* model:gpt-5* harness:claude-code os:linux arch:x86_64 runtime:host memory>=16GiB cpus>=4",
    );
    expect(parseRequirements(text)).toEqual(requires);
    expect(withoutTerm(requires, "model:gpt-5*")?.models).toEqual(["claude-opus-*"]);
    expect(withoutTerm(parseRequirements("tag:ux"), "tag:ux")).toBeNull();
  });

  test("empty means any agent", () => {
    expect(parseRequirements("  ")).toBeNull();
    expect(normalizeRequirements({ tags: [], models: [] })).toBeNull();
    expect(normalizeRequirements(null)).toBeNull();
    expect(hasRequirements(undefined)).toBe(false);
    expect(hasRequirements({ minCpus: 1 })).toBe(true);
  });

  test("sizes take binary and decimal units", () => {
    expect(parseBytes("16GiB")).toBe(16 * GiB);
    expect(parseBytes("16G")).toBe(16 * GiB);
    expect(parseBytes("16gb")).toBe(16e9);
    expect(parseBytes("1.5GiB")).toBe(1.5 * GiB);
    expect(parseBytes("512MiB")).toBe(512 * 2 ** 20);
    expect(parseBytes("2048")).toBe(2048);
    expect(parseBytes("lots")).toBeNull();
    expect(parseBytes("0")).toBeNull();
    expect(formatBytes(1.5 * GiB)).toBe("1536MiB");
    expect(formatBytes(16e9)).toBe("16GB");
    expect(formatBytes(1000)).toBe("1KB");
    expect(formatBytes(1001)).toBe("1001B");
    expect(parseRequirements("memory>=16GB")?.minMemory).toBe(16e9);
    expect(parseRequirements("mem>=8G cpu>=2")).toEqual({ minMemory: 8 * GiB, minCpus: 2 });
  });

  test("says what's wrong", () => {
    for (const [text, message] of [
      ["gpu", /Unknown requirement "gpu"/],
      ["tag:", /needs a value/],
      ["memory>=lots", /Invalid memory/],
      ["cpus>=1.5", /Invalid CPU count/],
      ["runtime:docker", /Unknown runtime "docker"/],
      ["tag:a&b", /Invalid tag/],
    ] as const)
      expect(() => parseRequirements(text), text).toThrow(message);
    expect(() => normalizeRequirements({ gpu: true })).toThrow(/Unknown requirement: gpu/);
    expect(() => normalizeRequirements({ minMemory: -1 })).toThrow(RequirementError);
    expect(() =>
      normalizeRequirements({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
    ).toThrow(/at most 20/);
    expect(() => normalizeRequirements("tag:ux")).toThrow(/must be an object/);
  });
});

describe("matching", () => {
  test("globs match whole values, ignoring case", () => {
    expect(globMatch("claude-opus-*", "Claude-Opus-4-5")).toBe(true);
    expect(globMatch("claude-*", "gpt-claude-1")).toBe(false);
    expect(globMatch("*", "anything")).toBe(true);
    expect(globMatch("gpt-5.1", "gpt-5x1")).toBe(false);
    expect(globMatch("*-mini", "o4-mini")).toBe(true);
  });

  test("an agent that meets everything is eligible", () => {
    const requires = parseRequirements(
      "tag:ux tag:DATA skill:play* model:claude-opus-*,gpt-5* harness:claude-code os:linux,macos arch:x86_64 runtime:host memory>=16GiB cpus>=8",
    );
    expect(unmetRequirements(requires, agent())).toEqual([]);
    expect(unmetRequirements(null, null)).toEqual([]);
  });

  test("tags and skills need every value; the rest need any one", () => {
    const unmet = unmetRequirements(
      parseRequirements("tag:ux tag:gpu tag:infra skill:playwright skill:k8s model:gpt-5*,o4-*"),
      agent(),
    );
    expect(unmet.map((u) => u.wanted)).toEqual([
      "tag:gpu",
      "tag:infra",
      "skill:k8s",
      "model:gpt-5*,o4-*",
    ]);
    expect(unmet[0]!.message).toBe("needs tag gpu (it reports tags: UX, data)");
    expect(unmet[3]).toMatchObject({
      requirement: "models",
      reported: "claude-opus-4-5",
      message: "needs one of model gpt-5*, o4-* (it reports claude-opus-4-5)",
    });
  });

  test("units: memory and CPUs are minimums, and unreported ones are unmet", () => {
    const requires = parseRequirements("memory>=64GiB cpus>=16");
    const unmet = unmetRequirements(requires, agent());
    expect(unmet.map((u) => u.message)).toEqual([
      "needs at least 64GiB of memory (it reports 32GiB)",
      "needs at least 16 CPUs (it reports 8)",
    ]);
    const blank = agent({
      model: null,
      harness: null,
      environment: { ...agent().environment, memoryBytes: 15.6 * GiB, cpuCount: null },
    });
    expect(unmetRequirements(parseRequirements("memory>=16GiB"), blank)[0]!.message).toBe(
      "needs at least 16GiB of memory (it reports 15.6GiB)",
    );
    expect(
      unmetRequirements(parseRequirements("cpus>=2 model:* harness:codex"), blank).map(
        (u) => u.message,
      ),
    ).toEqual([
      "needs model * (it reports no model)",
      "needs harness codex (it reports no harness)",
      "needs at least 2 CPUs (it reports none)",
    ]);
    expect(unmetRequirements(parseRequirements("memory>=16GB"), agent())).toEqual([]);
  });

  test("an agent without reported capabilities is told to run gm agent setup", () => {
    const unmet = unmetRequirements(parseRequirements("tag:ux"), null);
    expect(unmet).toEqual([
      {
        requirement: "capabilities",
        wanted: "tag:ux",
        reported: null,
        message: expect.stringContaining("gm agent setup"),
      },
    ]);
    expect(unmetText("builder", "CORE-1", unmet)).toMatch(
      /^builder doesn't meet CORE-1's requirements: it hasn't reported its capabilities: run `gm agent setup`/,
    );
  });
});
