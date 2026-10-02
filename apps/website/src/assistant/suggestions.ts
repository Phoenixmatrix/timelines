// Starting points that fit the page the person is on.

import type { PageContext } from "../../shared/assistant.ts";

export function suggestionsFor(page: PageContext): string[] {
  if (page.issue)
    return [
      `Summarize ${page.issue} and what's blocking it`,
      `Break ${page.issue} into sub-issues`,
      `What's left before ${page.issue} is done?`,
    ];
  if (page.run)
    return [
      `Why did run #${page.run} fail?`,
      `What changed in run #${page.run}'s commit?`,
      `Rerun #${page.run} if the failure looks flaky`,
    ];
  if (page.file)
    return [
      page.lines ? `Explain lines ${page.lines}` : `Explain ${page.file.split("/").pop()}`,
      `Where is ${page.file.split("/").pop()} used?`,
      "What changed in this file recently?",
    ];
  if (page.repo)
    return [
      "What does this repository do?",
      "What changed this week?",
      "How is the latest CI run doing?",
    ];
  if (page.tracker)
    return ["What's ready to work on?", "What's blocking the most work?", "What landed this week?"];
  return [
    "What needs my attention?",
    "Which CI runs failed today?",
    "What are my agents working on?",
  ];
}
