// Every turn starts with one clef-flash call: up to a few dozen typed
// questions about the message, answered with probabilities in well under a
// second. The answers decide what the turn costs before any tokens stream:
// which skills to preload (no activate_skill round trip), which tool groups
// the model sees (fewer tools, smaller prompts, better calls), which model and
// how much reasoning, whether Code Mode is worth it, and the status line shown
// while the first token is on its way.

import type { ClefAnswer, ClefQuestion } from "../knowledge/models.ts";

/** Tool groups, each with the built-in skill that teaches it. */
export const GROUPS = {
  code: "Reading code: files, folders, commits, history and syntax-level changes in a repository",
  tracker: "Issues, projects, teams, the dependency graph, claims and requests to people",
  ci: "CI runs, jobs, their logs, and rerunning or cancelling them",
  packages: "Packages and versions published to the registry",
  knowledge:
    "What code means: the knowledge graph, semantic search over code and the generated wiki",
  repository: "Repository settings, collaborators, mirrors, creating repositories",
} as const;
export type Group = keyof typeof GROUPS;

const STATUS = {
  reading: "Reading the code",
  issues: "Checking the issues",
  ci: "Looking at CI",
  packages: "Looking at packages",
  knowledge: "Searching the knowledge graph",
  navigating: "Finding the page",
  planning: "Thinking it through",
  changing: "Preparing the change",
  answering: "Thinking",
} as const;

export const INTENTS = {
  answer: "Wants information or an explanation",
  act: "Wants something changed (create, edit, comment, rerun, delete…)",
  navigate: "Wants to be taken to a page or shown something in the app",
  plan: "Wants work planned, broken down or written up (a PRD, sub-issues, a release summary)",
  chat: "Greeting, thanks or small talk; needs no tools",
} as const;
export type Intent = keyof typeof INTENTS;

export interface TurnInput {
  message: string;
  /** Where the person is in the app, if anywhere. */
  page?: { path: string; title?: string } | null;
  /** The end of the assistant's previous reply, for follow-ups like "do it". */
  previous?: string;
}

export interface TurnPlan {
  intent: Intent;
  /** Tool groups (and their skills) this turn needs. */
  groups: Group[];
  /** "deep" switches to the larger model for hard or long work. */
  tier: "fast" | "deep";
  reasoning: "low" | "medium" | "high";
  /** Read many things and combine them: worth writing a Code Mode script. */
  codemode: boolean;
  /** The message refers to what's on screen ("this issue", "this file"). */
  aboutPage: boolean;
  status: string;
}

export function questions(): Record<string, ClefQuestion> {
  const groups = Object.fromEntries(
    Object.entries(GROUPS).map(([group, description]) => [
      `needs_${group}`,
      {
        type: "noul",
        instructions: `To handle the message well, will the assistant need this area of Gitmatrix? ${description}.`,
      } satisfies ClefQuestion,
    ]),
  );
  return {
    intent: {
      type: "choice",
      instructions: "What does the person want from this message?",
      criteria: INTENTS,
    },
    ...groups,
    difficulty: {
      type: "score",
      instructions:
        "How hard is this to do well? 1: a quick lookup or reply. 2: a few lookups. 3: several steps or careful judgment. 4: long, multi-part work such as planning a project or a deep investigation.",
      criteria: ["quick", "a few steps", "several steps", "long multi-part work"],
    },
    aggregate: {
      type: "noul",
      instructions:
        "Does answering mean reading many items (for example every open issue, all recent CI runs, many files) and combining or counting them?",
    },
    about_page: {
      type: "noul",
      instructions:
        "Does the message refer to what the person is looking at right now (this issue, this file, this run, here, it) rather than naming it?",
    },
    status: {
      type: "choice",
      instructions: "Which short status best describes what the assistant will do first?",
      criteria: STATUS,
    },
  };
}

const p = (answer: ClefAnswer | undefined) => (answer?.type === "noul" ? answer.noul : 0);

/** The turn's plan from clef's answers. Defaults to a capable, general turn. */
export function planFrom(answers: Record<string, ClefAnswer> | null): TurnPlan {
  if (!answers)
    return {
      intent: "answer",
      groups: Object.keys(GROUPS) as Group[],
      tier: "fast",
      reasoning: "medium",
      codemode: false,
      aboutPage: true,
      status: STATUS.answering,
    };
  const intent = (answers.intent?.type === "choice" ? answers.intent.choice : "answer") as Intent;
  // Generous threshold: a missing tool costs a failed turn, an extra one a few tokens.
  const groups = (Object.keys(GROUPS) as Group[]).filter((g) => p(answers[`needs_${g}`]) >= 0.3);
  const difficulty = answers.difficulty?.type === "score" ? answers.difficulty.score : 2;
  const deep = intent === "plan" || difficulty >= 3;
  const status =
    answers.status?.type === "choice" && answers.status.choice in STATUS
      ? STATUS[answers.status.choice as keyof typeof STATUS]
      : STATUS.answering;
  return {
    intent,
    groups: intent === "chat" ? [] : groups,
    tier: deep ? "deep" : "fast",
    reasoning: difficulty >= 4 ? "high" : difficulty >= 2 ? "medium" : "low",
    codemode: intent !== "chat" && p(answers.aggregate) >= 0.5,
    aboutPage: p(answers.about_page) >= 0.4,
    status: intent === "navigate" ? STATUS.navigating : status,
  };
}

/** What clef reads: the message and just enough around it. */
export function clefState(input: TurnInput): unknown {
  return {
    message: input.message.slice(0, 4000),
    ...(input.page ? { page: input.page } : {}),
    ...(input.previous ? { previous_reply: input.previous.slice(-600) } : {}),
  };
}
