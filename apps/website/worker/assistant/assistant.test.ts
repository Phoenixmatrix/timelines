import { describe, expect, test } from "vite-plus/test";
import { describeWrite, toolLabel } from "../../shared/assistant.ts";
import { allowedPath } from "./internal.ts";
import { planFrom, questions } from "./plan.ts";
import { cleanStatus, progressPrompt, stepFromMessage } from "./progress.ts";
import { sentenceCase } from "./titles.ts";
import { parseSkill } from "./skills.ts";
import { buildTools, clip, compact } from "./tools.ts";

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

describe("status lines between steps", () => {
  test("the small model reads the request and what the last step did, briefly", () => {
    const prompt = progressPrompt("Why did run #44 fail?", {
      text: "Let me check the run.",
      toolCalls: [{ toolName: "ci_run", toolCallId: "a", input: { number: 44 } }],
      toolResults: [{ toolCallId: "a", output: { status: "failed", log: "x".repeat(5000) } }],
    });
    expect(prompt).toContain("Request: Why did run #44 fail?");
    expect(prompt).toContain("- Read CI run #44\n  Result: {");
    expect(prompt).toContain("Just said: Let me check the run.");
    expect(prompt.length).toBeLessThan(1200);
  });

  test("a continued reply's last step comes from its message", () => {
    const step = stepFromMessage({
      parts: [
        { type: "step-start" },
        { type: "tool-show_issue", toolCallId: "old", input: { key: "A-1" }, output: {} },
        { type: "step-start" },
        { type: "text", text: "Opening it." },
        {
          type: "tool-navigate",
          toolCallId: "nav",
          input: { path: "/tracker/o/issues/A-2", label: "A-2" },
          output: { opened: "/tracker/o/issues/A-2" },
        },
      ],
    });
    expect(step).toEqual({
      text: "Opening it.",
      toolCalls: [
        {
          toolName: "navigate",
          toolCallId: "nav",
          input: { path: "/tracker/o/issues/A-2", label: "A-2" },
        },
      ],
      toolResults: [{ toolCallId: "nav", output: { opened: "/tracker/o/issues/A-2" } }],
    });
    // An approved write that hasn't run, or a reply without tools: nothing to say yet.
    expect(
      stepFromMessage({
        parts: [{ type: "tool-create_issue", toolCallId: "w", input: {} }],
      }),
    ).toBeNull();
    expect(stepFromMessage({ parts: [{ type: "text", text: "Hi" }] })).toBeNull();
    expect(stepFromMessage(undefined)).toBeNull();
  });

  test("replies become a short line, or nothing", () => {
    expect(cleanStatus("“Comparing the failing jobs.”")).toBe("Comparing the failing jobs");
    expect(cleanStatus("Status: checking who owns CORE-12…\nmore")).toBe(
      "Checking who owns CORE-12",
    );
    expect(cleanStatus("")).toBeNull();
    expect(
      cleanStatus("I am now going to read every one of the issues and summarize them for you"),
    ).toBeNull();
  });
});

test("chat titles in sentence case, acronyms kept", () => {
  expect(sentenceCase("Urgent Tasks First")).toBe("Urgent tasks first");
  expect(sentenceCase("Why CI Run Failed")).toBe("Why CI run failed");
  expect(sentenceCase("Fixing the gm push flow")).toBe("Fixing the gm push flow");
});

describe("skills and results", () => {
  test("parses SKILL.md frontmatter and body", () => {
    expect(
      parseSkill('---\nname: deploy\ndescription: "Ship it: carefully"\n---\n\n# Deploy\nSteps'),
    ).toEqual({
      name: "deploy",
      description: "Ship it: carefully",
      body: "# Deploy\nSteps",
    });
    expect(parseSkill("no frontmatter")).toBeNull();
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

describe("issue requirements in the assistant's tools (CORE-32)", () => {
  test("create and update take the text form; bad terms come back as errors", async () => {
    const sent: unknown[] = [];
    const issue = {
      id: "i1",
      key: "CORE-1",
      version: 3,
      teamId: "t",
      title: "x",
      labels: [],
      requires: { tags: ["ux"] },
    };
    const api = async (method: string, _path: string, body?: unknown) => {
      if (method === "GET")
        return {
          status: 200,
          ok: true,
          body: { teams: [{ id: "t", key: "CORE" }], issues: [issue] },
        };
      sent.push(body);
      return {
        status: 200,
        ok: true,
        body: {
          events: [
            {
              entity: {
                id: (body as { mutations: { id: string }[] }).mutations[0]!.id,
                key: "CORE-2",
              },
            },
          ],
        },
      };
    };
    const { writes } = buildTools({
      api: api as never,
      writes: true,
      approve: false,
      navigate: false,
    });
    const run = (name: string, input: unknown) =>
      (writes[name]!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, {
        toolCallId: "t",
        messages: [],
      });
    await run("create_issue", {
      owner: "o",
      team: "CORE",
      title: "Design",
      requires: "tag:UX memory>=16GiB",
    });
    await run("update_issue", { owner: "o", key: "CORE-1", changes: { requires: "" } });
    await run("update_issue", { owner: "o", key: "CORE-1", changes: { title: "y" } });
    expect(
      sent.map((b) => (b as { mutations: { data: Record<string, unknown> }[] }).mutations[0]!.data),
    ).toEqual([
      expect.objectContaining({ requires: { tags: ["ux"], minMemory: 16 * 2 ** 30 } }),
      { requires: null },
      { title: "y" },
    ]);
    expect(
      await run("update_issue", { owner: "o", key: "CORE-1", changes: { requires: "gpu" } }),
    ).toEqual({ error: expect.stringContaining('Unknown requirement "gpu"') });
  });
});
