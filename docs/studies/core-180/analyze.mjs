// Computes CORE-180's gate (PRD gate 20) from the recording sheet, exactly as
// README.md "Analysis" defines it. Deterministic, no dependencies.
//
//   node analyze.mjs [recording-sheet.csv] [--ordering ordering.csv] [--json]
//
// Exit code: 0 the gate passes, 1 it fails, 2 the sheet is incomplete or invalid.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = argv.splice(i, 2);
  return value;
};
const orderingPath = flag("--ordering") ?? join(here, "ordering.csv");
const asJson = argv.includes("--json");
const sheetPath = argv.find((a) => !a.startsWith("--")) ?? join(here, "recording-sheet.csv");

export const CAP_S = 600;
const TASKS = ["T1", "T2", "T3", "T4"];
const LOCATION_TASKS = new Set(["T2", "T3"]);
const OUTCOMES = new Set(["completed", "incorrect", "gave_up", "timeout"]);
const PARTICIPANTS = 5;
const MIN_COMPLETED = 4;
const MIN_IMPROVEMENT = 0.25;

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim() !== ""));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const seconds = (clock) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clock);
  if (!m) return null;
  const [h, min, s] = m[3] === undefined ? [0, +m[1], +m[2]] : [+m[1], +m[2], +m[3]];
  return h * 3600 + min * 60 + s;
};

export function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Validate the sheet against the ordering; return [rows, errors]. */
export function validate(sheet, ordering) {
  const errors = [];
  const expected = new Map();
  for (const o of ordering)
    for (const [position, condition, variant] of [
      ["1", o.first_condition, o.first_variant],
      ["2", o.second_condition, o.second_variant],
    ])
      for (const task of TASKS)
        expected.set(`${o.participant}/${position}/${task}`, { condition, variant });
  if (ordering.length !== PARTICIPANTS)
    errors.push(`ordering has ${ordering.length} participants, the gate needs ${PARTICIPANTS}`);
  const seen = new Set();
  const rows = [];
  for (const [index, r] of sheet.entries()) {
    const at = `row ${index + 2} (${r.participant} ${r.condition} ${r.task})`;
    const key = `${r.participant}/${r.position}/${r.task}`;
    const plan = expected.get(key);
    if (!plan) {
      errors.push(`${at}: not in the ordering`);
      continue;
    }
    if (seen.has(key)) errors.push(`${at}: duplicate`);
    seen.add(key);
    if (plan.condition !== r.condition || plan.variant !== r.variant)
      errors.push(`${at}: the ordering says ${plan.condition}/${plan.variant}`);
    if (!OUTCOMES.has(r.outcome)) {
      errors.push(`${at}: outcome must be one of ${[...OUTCOMES].join(", ")}`);
      continue;
    }
    let duration = r.duration_s === "" ? null : Number(r.duration_s);
    if (duration === null && r.start && r.end) {
      const [s, e] = [seconds(r.start), seconds(r.end)];
      if (s !== null && e !== null) duration = e >= s ? e - s : e + 86400 - s;
    }
    if (duration === null || !Number.isFinite(duration) || duration < 0) {
      errors.push(`${at}: needs duration_s, or start and end as HH:MM:SS`);
      continue;
    }
    if (duration > CAP_S + 5 && r.outcome === "completed")
      errors.push(`${at}: completed after the ${CAP_S}s limit; record it as timeout`);
    let cited = null;
    let correct = null;
    if (LOCATION_TASKS.has(r.task)) {
      cited = Number(r.locations_cited || 0);
      correct = Number(r.locations_correct || 0);
      if (!Number.isInteger(cited) || !Number.isInteger(correct) || correct < 0 || correct > cited)
        errors.push(`${at}: locations_correct must be an integer between 0 and locations_cited`);
      if (r.outcome === "completed" && cited === 0)
        errors.push(`${at}: completed with no locations cited`);
    }
    rows.push({ ...r, duration, completed: r.outcome === "completed", cited, correct });
  }
  for (const key of expected.keys())
    if (!seen.has(key)) errors.push(`missing row ${key.replaceAll("/", " ")}`);
  return [rows, errors];
}

export function analyze(rows) {
  const penalised = (r) => (r.completed ? Math.min(r.duration, CAP_S) : CAP_S);
  const conditions = ["baseline", "new"];
  const participants = [...new Set(rows.map((r) => r.participant))].sort((a, b) =>
    a.localeCompare(b),
  );
  const totals = {};
  for (const c of conditions)
    totals[c] = Object.fromEntries(
      participants.map((p) => [
        p,
        rows
          .filter((r) => r.participant === p && r.condition === c)
          .reduce((s, r) => s + penalised(r), 0),
      ]),
    );
  const medians = Object.fromEntries(conditions.map((c) => [c, median(Object.values(totals[c]))]));
  const improvement = (medians.baseline - medians.new) / medians.baseline;
  const completion = Object.fromEntries(
    conditions.map((c) => [
      c,
      Object.fromEntries(
        TASKS.map((t) => [
          t,
          rows.filter((r) => r.condition === c && r.task === t && r.completed).length,
        ]),
      ),
    ]),
  );
  const accuracy = Object.fromEntries(
    conditions.map((c) => {
      const located = rows.filter((r) => r.condition === c && r.cited !== null);
      const cited = located.reduce((s, r) => s + r.cited, 0);
      const correct = located.reduce((s, r) => s + r.correct, 0);
      return [c, { cited, correct, rate: cited ? correct / cited : null }];
    }),
  );
  const accuracyHolds =
    accuracy.new.rate !== null &&
    (accuracy.baseline.rate === null || accuracy.new.rate >= accuracy.baseline.rate);
  const checks = {
    completion: TASKS.every((t) => completion.new[t] >= MIN_COMPLETED),
    time: improvement >= MIN_IMPROVEMENT,
    accuracy: accuracyHolds,
  };
  // Informational: the same medians split by variant and by position, to expose
  // variant difficulty and learning effects.
  const by = (key) =>
    Object.fromEntries(
      conditions.map((c) => {
        const groups = {};
        for (const p of participants) {
          const own = rows.filter((r) => r.participant === p && r.condition === c);
          const g = own[0]?.[key];
          if (g !== undefined) (groups[g] ??= []).push(own.reduce((s, r) => s + penalised(r), 0));
        }
        return [
          c,
          Object.fromEntries(
            Object.entries(groups).map(([g, v]) => [g, { n: v.length, median: median(v) }]),
          ),
        ];
      }),
    );
  const taskMedians = Object.fromEntries(
    conditions.map((c) => [
      c,
      Object.fromEntries(
        TASKS.map((t) => [
          t,
          median(rows.filter((r) => r.condition === c && r.task === t).map(penalised)),
        ]),
      ),
    ]),
  );
  return {
    pass: checks.completion && checks.time && checks.accuracy,
    checks,
    completion,
    totals,
    medians,
    improvement,
    accuracy,
    taskMedians,
    byVariant: by("variant"),
    byPosition: by("position"),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [rows, errors] = validate(
    parseCsv(readFileSync(sheetPath, "utf8")),
    parseCsv(readFileSync(orderingPath, "utf8")),
  );
  if (errors.length) {
    if (asJson) console.log(JSON.stringify({ valid: false, errors }, null, 2));
    else
      console.error(
        `The sheet is incomplete or invalid (${errors.length}):\n- ${errors.join("\n- ")}`,
      );
    process.exit(2);
  }
  const result = analyze(rows);
  if (asJson) console.log(JSON.stringify({ valid: true, ...result }, null, 2));
  else {
    const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
    const yes = (b) => (b ? "PASS" : "FAIL");
    console.log(`CORE-180 / PRD gate 20: ${result.pass ? "PASS" : "FAIL"}\n`);
    console.log(
      `Completion, new experience (need >= ${MIN_COMPLETED}/${PARTICIPANTS} per task): ${yes(result.checks.completion)}`,
    );
    for (const t of TASKS)
      console.log(
        `  ${t}: new ${result.completion.new[t]}/${PARTICIPANTS}, baseline ${result.completion.baseline[t]}/${PARTICIPANTS}`,
      );
    console.log(
      `\nOrientation-plus-change-understanding time (T1-T4, unfinished tasks at ${CAP_S}s): ${yes(result.checks.time)}`,
    );
    for (const c of ["baseline", "new"])
      console.log(
        `  ${c}: median ${result.medians[c]}s  (${Object.entries(result.totals[c])
          .map(([p, s]) => `${p} ${s}s`)
          .join(", ")})`,
      );
    console.log(`  improvement: ${pct(result.improvement)} (need >= ${pct(MIN_IMPROVEMENT)})`);
    console.log(
      `\nSource-location accuracy (T2 and T3 locations, new >= baseline): ${yes(result.checks.accuracy)}`,
    );
    for (const c of ["baseline", "new"]) {
      const a = result.accuracy[c];
      console.log(`  ${c}: ${a.correct}/${a.cited} = ${pct(a.rate)}`);
    }
    console.log("\nInformational (not part of the gate):");
    for (const c of ["baseline", "new"]) {
      console.log(
        `  ${c} per-task medians: ${TASKS.map((t) => `${t} ${result.taskMedians[c][t]}s`).join(", ")}`,
      );
      console.log(
        `  ${c} by variant: ${Object.entries(result.byVariant[c])
          .map(([g, v]) => `${g} median ${v.median}s (n=${v.n})`)
          .join(", ")}`,
      );
      console.log(
        `  ${c} by position: ${Object.entries(result.byPosition[c])
          .map(([g, v]) => `${g === "1" ? "first" : "second"} median ${v.median}s (n=${v.n})`)
          .join(", ")}`,
      );
    }
  }
  process.exit(result.pass ? 0 : 1);
}
