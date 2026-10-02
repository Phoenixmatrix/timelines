import { describe, expect, test } from "vite-plus/test";
import { describeWrite, toolLabel } from "../../shared/assistant.ts";
import { allowedPath } from "./internal.ts";
import { planFrom, questions } from "./plan.ts";
import { sentenceCase } from "./titles.ts";
import { parseSkill, preloaded } from "./skills.ts";
import { clip, compact } from "./tools.ts";

describe("clef routing", () => {
  test("one call asks every question, within clef's limit", () => {
    const asked = Object.keys(questions());
    expect(asked.length).toBeLessThanOrEqual(64);
    expect(asked).toEqual(expect.arrayContaining(["intent", "difficulty", "aggregate", "status"]));
  });

  test("answers decide the model, tools, Code Mode and status", () => {
    const plan = planFrom({
      intent: { type: "choice", choice: "plan", probabilities: {}, confidence: 0.9 },
      needs_tracker: { type: "noul", noul: 0.92 },
      needs_code: { type: "noul", noul: 0.1 },
      needs_ci: { type: "noul", noul: 0.35 },
      difficulty: { type: "score", score: 4, probabilities: [], confidence: 0.8 },
      aggregate: { type: "noul", noul: 0.7 },
      about_page: { type: "noul", noul: 0.1 },
      status: { type: "choice", choice: "issues", probabilities: {}, confidence: 0.9 },
    });
    expect(plan).toMatchObject({
      intent: "plan",
      groups: ["tracker", "ci"],
      tier: "deep",
      reasoning: "high",
      codemode: true,
      aboutPage: false,
      status: "Checking the issues",
    });
    // Small talk needs no tools at all, whatever else clef thought.
    expect(
      planFrom({
        intent: { type: "choice", choice: "chat", probabilities: {}, confidence: 0.9 },
        needs_code: { type: "noul", noul: 0.9 },
      }),
    ).toMatchObject({ groups: [], codemode: false, tier: "fast" });
  });

  test("navigation needs an explicit ask to open something", () => {
    const navigate = {
      type: "choice" as const,
      choice: "navigate",
      probabilities: {},
      confidence: 0.6,
    };
    expect(planFrom({ intent: navigate, open_page: { type: "noul", noul: 0.2 } }).intent).toBe(
      "answer",
    );
    expect(planFrom({ intent: navigate, open_page: { type: "noul", noul: 0.9 } })).toMatchObject({
      intent: "navigate",
      status: "Finding the page",
    });
    // Planning always gets the tracker.
    expect(
      planFrom({ intent: { type: "choice", choice: "plan", probabilities: {}, confidence: 0.9 } })
        .groups,
    ).toContain("tracker");
  });

  test("without clef (a timeout or outage) the turn gets every tool", () => {
    expect(planFrom(null)).toMatchObject({
      groups: expect.arrayContaining(["code", "tracker", "ci"]),
    });
  });
});

describe("what the assistant may call", () => {
  test("the JSON API, but not credentials, identity or machinery", () => {
    expect(allowedPath("/repos/o/n/blob?path=a")).toBeNull();
    expect(allowedPath("/api/tracker/o/snapshot")).toBeNull();
    for (const path of [
      "/tokens",
      "/agents/x/tokens",
      "/ssh-keys",
      "/dev/seed",
      "/ci/runner/claim",
      "/assistant/chats",
    ])
      expect(allowedPath(path)).not.toBeNull();
    expect(allowedPath("/repos/../tokens")).not.toBeNull();
  });
});

describe("approvals say what the request does", () => {
  test("from the call's own fields, not the model's summary", () => {
    expect(
      describeWrite("create_issue", {
        owner: "orbit",
        team: "CORE",
        title: "Ship search",
        priority: 1,
        labels: ["search"],
        description: "Body",
      }),
    ).toEqual({
      title: "Create an issue in CORE (orbit)",
      fields: [
        ["Title", "Ship search"],
        ["Priority", "P1"],
        ["Labels", "search"],
      ],
      body: "Body",
    });
    const raw = describeWrite("api_write", {
      summary: "Make it private",
      method: "PATCH",
      path: "/api/repos/o/n",
      body: { visibility: "private" },
    });
    expect(raw.fields).toEqual([["Request", "PATCH /api/repos/o/n"]]);
    expect(raw.body).toContain('"visibility": "private"');
    expect(toolLabel("navigate", { path: "/tracker/o/issues/A-1", label: "A-1" })).toBe(
      "Opened A-1",
    );
  });
});

test("chat titles in sentence case, acronyms kept", () => {
  expect(sentenceCase("Urgent Tasks First")).toBe("Urgent tasks first");
  expect(sentenceCase("Why CI Run Failed")).toBe("Why CI run failed");
  expect(sentenceCase("Fixing the gm push flow")).toBe("Fixing the gm push flow");
});

describe("skills and results", () => {
  test("SKILL.md frontmatter, and which skills a turn preloads", () => {
    expect(
      parseSkill('---\nname: deploy\ndescription: "Ship it: carefully"\n---\n\n# Deploy\nSteps'),
    ).toEqual({
      name: "deploy",
      description: "Ship it: carefully",
      body: "# Deploy\nSteps",
    });
    expect(parseSkill("no frontmatter")).toBeNull();
    expect(preloaded([], false)).toEqual([]);
    expect(preloaded(["tracker"], false)).toEqual(["gitmatrix-api", "tracker"]);
    expect(preloaded([], true)).toEqual(["gitmatrix-api", "navigation"]);
  });

  test("tool output is trimmed with a count of what was cut", () => {
    expect(clip("abcdef", 3)).toBe("abc\n… (3 more characters)");
    expect(compact({ list: [1, 2, 3, 4], text: "x".repeat(10) }, { strings: 4, items: 2 })).toEqual(
      {
        list: [1, 2, "… 2 more"],
        text: "xxxx\n… (6 more characters)",
      },
    );
  });
});
