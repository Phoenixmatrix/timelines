import { expect, test } from "vite-plus/test";
import type { Timeline, TimelineEvent, TimelineRepo } from "../../../shared/timelines.ts";
import { landedMerge, workHead } from "./Changes.tsx";

const repo = {
  id: "r1",
  owner: "orbit",
  name: "app",
  bookmark: "timeline/mine",
  source: { kind: "timeline-work", sourceId: "work-mine", ref: "refs/heads/work" },
} as unknown as TimelineRepo;
const timeline = { id: "mine", repos: [repo] } as unknown as Timeline;
const abandon = (timelineId: string, seq: number, commit: string): TimelineEvent =>
  ({
    id: `e${seq}`,
    seq,
    timelineId,
    kind: "abandon",
    lastCommits: { r1: commit },
  }) as unknown as TimelineEvent;

test("a head is the timeline's own abandonment, not another timeline's on the same repository (CORE-382)", () => {
  const events = [abandon("mine", 1, "a".repeat(40)), abandon("other", 2, "b".repeat(40))];
  expect(workHead(timeline, events, repo)).toBe("a".repeat(40));
  // Without its own abandonment the work ref stands, however the others ended.
  expect(workHead(timeline, [abandon("other", 2, "b".repeat(40))], repo)).toBe("work");
});

test("a canonical bookmark's landing selects the tip main merged, and the merge commit names what landed (CORE-382)", () => {
  const legacy = { ...repo, source: { kind: "canonical-historical", sourceId: "canonical" } };
  const merge = {
    id: "m",
    seq: 3,
    timelineId: "mine",
    kind: "merge",
    fromId: "mine",
    intoId: null,
    repoId: "r1",
    commit: "c".repeat(40),
    parent: "d".repeat(40),
  } as unknown as TimelineEvent;
  expect(workHead(timeline, [merge], legacy as unknown as TimelineRepo)).toBe("d".repeat(40));
  expect(landedMerge(timeline, [merge], legacy as unknown as TimelineRepo)).toBe("c".repeat(40));
  // An owned work source keeps its own head and has no landing to show.
  expect(workHead(timeline, [merge], repo)).toBe("work");
  expect(landedMerge(timeline, [merge], repo)).toBeNull();
});
