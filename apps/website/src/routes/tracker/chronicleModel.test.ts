import { describe, expect, test } from "vite-plus/test";
import type { ChronicleIssue } from "../../../shared/chronicle.ts";
import {
  DAY,
  groupRows,
  hitInRow,
  HOUR,
  MIN_WINDOW,
  presetWindow,
  readAddress,
  rowAt,
  rowOffsets,
  stateAsOf,
  ticks,
  writeAddress,
  zoom,
} from "./chronicleModel.ts";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const at = (iso: string) => Date.parse(iso);

function issue(over: Partial<ChronicleIssue> & Pick<ChronicleIssue, "id" | "key">): ChronicleIssue {
  return {
    title: over.key,
    type: "task",
    priority: 2,
    teamId: "team",
    parentId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    start: { status: "todo", waiting: false },
    segments: [],
    spans: [],
    markers: [],
    blockers: [],
    historyFrom: null,
    ...over,
  };
}

describe("the Chronicle's address", () => {
  test("round-trips the window, playhead, range, grouping, span and layout, keeping the query", () => {
    const params = new URLSearchParams({ q: "team:core", view: "chronicle" });
    const address = {
      from: at("2026-10-01T00:00:00.000Z"),
      to: at("2026-10-02T00:00:00.000Z"),
      at: at("2026-10-01T10:30:00.000Z"),
      range: { from: at("2026-10-01T09:00:00.000Z"), to: at("2026-10-01T11:00:00.000Z") },
      group: "team" as const,
      span: "a:12",
      list: true,
    };
    const written = writeAddress(params, address);
    expect(written.get("q")).toBe("team:core");
    expect(written.get("view")).toBe("chronicle");
    expect(readAddress(written, NOW)).toEqual(address);
  });

  test("a missing or broken window reads as the last 7 days, as of now", () => {
    const address = readAddress(new URLSearchParams({ from: "nonsense" }), NOW);
    expect(address.to - address.from).toBe(7 * DAY);
    expect(address.at).toBe(NOW);
    expect(address.range).toBeNull();
    expect(address.group).toBe("status");
  });
});

describe("zoom, presets and the ruler", () => {
  test("zoom keeps the pivot in place and stays within limits", () => {
    const window = { from: 0, to: 1000 * HOUR };
    const zoomed = zoom(window, 0.5, 250 * HOUR);
    expect(zoomed.to - zoomed.from).toBe(500 * HOUR);
    expect((250 * HOUR - zoomed.from) / (zoomed.to - zoomed.from)).toBeCloseTo(0.25);
    expect(zoom(window, 1e-9, 0).to - zoom(window, 1e-9, 0).from).toBe(MIN_WINDOW);
  });

  test("presets end just after now; All starts at the earliest event", () => {
    expect(presetWindow("24h", NOW, null).to - presetWindow("24h", NOW, null).from).toBe(DAY);
    const all = presetWindow("all", NOW, NOW - 40 * DAY);
    expect(all.from).toBeLessThan(NOW - 40 * DAY);
  });

  test("ticks align to the clock and grow coarser as the window widens", () => {
    const day = ticks(at("2026-10-01T00:00:00Z"), at("2026-10-02T00:00:00Z"), 1200);
    expect(day.length).toBeGreaterThan(6);
    for (const tick of day) expect(new Date(tick.t).getMinutes()).toBe(0);
    const month = ticks(at("2026-09-01T00:00:00Z"), at("2026-10-01T00:00:00Z"), 1200);
    expect(month.length).toBeLessThan(day.length * 2);
    for (const tick of month) expect(new Date(tick.t).getHours()).toBe(0);
  });
});

describe("rows as of the playhead", () => {
  const a = issue({
    id: "a",
    key: "ENG-2",
    segments: [
      { at: "2026-10-01T10:00:00.000Z", cursor: 5, status: "in_progress", waiting: false },
    ],
    spans: [
      {
        id: "a:5",
        issueId: "a",
        holder: "agt",
        accountableId: "ann",
        session: "s",
        start: "2026-10-01T10:00:00.000Z",
        end: "2026-10-01T12:00:00.000Z",
        endedBy: "release",
        endedById: null,
        expiresAt: "2026-10-01T12:15:00.000Z",
        renewals: [],
        parked: [{ from: "2026-10-01T11:00:00.000Z", to: "2026-10-01T11:30:00.000Z" }],
        retained: null,
        delegatedFrom: null,
        timelineId: null,
      },
    ],
    markers: [
      { id: "e:9", at: "2026-10-01T10:30:00.000Z", kind: "checkpoint", actorId: "agt", text: "x" },
    ],
  });
  const b = issue({ id: "b", key: "ENG-10" });
  const c = issue({ id: "c", key: "ENG-1", start: { status: null, waiting: false } });

  test("state marks: claimed while worked, its status while parked, nothing before it existed", () => {
    expect(stateAsOf(a, at("2026-10-01T09:00:00.000Z"), NOW)).toBe("todo");
    expect(stateAsOf(a, at("2026-10-01T10:15:00.000Z"), NOW)).toBe("claimed");
    expect(stateAsOf(a, at("2026-10-01T11:10:00.000Z"), NOW)).toBe("in_progress");
    expect(stateAsOf(c, at("2026-10-01T11:10:00.000Z"), NOW)).toBeNull();
  });

  test("groups follow working order as of the playhead, keys in natural order", () => {
    const rows = groupRows([b, a, c], "status", at("2026-10-01T10:15:00.000Z"), {});
    expect(rows.map((r) => (r.kind === "group" ? r.label : r.issue.key))).toEqual([
      "In progress",
      "ENG-2",
      "To do",
      "ENG-10",
      "Not created yet",
      "ENG-1",
    ]);
    const { tops } = rowOffsets(rows);
    expect(rowAt(tops, rows, tops[1]! + 3)).toBe(1);
    const team = groupRows([b, a], "team", 0, { team: "ENG" });
    expect(team[0]).toMatchObject({ kind: "group", label: "ENG", count: 2 });
  });

  test("a marker under the pointer wins over the span it sits on", () => {
    const x = (t: number) => (t - at("2026-10-01T00:00:00.000Z")) / 60_000;
    const marker = hitInRow(a, x, x(at("2026-10-01T10:30:00.000Z")) + 2, NOW);
    expect(marker && "marker" in marker && marker.marker.kind).toBe("checkpoint");
    const span = hitInRow(a, x, x(at("2026-10-01T11:45:00.000Z")), NOW);
    expect(span && "span" in span && span.span.id).toBe("a:5");
    expect(hitInRow(a, x, x(at("2026-10-01T15:00:00.000Z")), NOW)).toBeNull();
  });
});
