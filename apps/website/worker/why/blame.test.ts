import { describe, expect, test } from "vite-plus/test";
import { fakeHistory } from "../testing/history.ts";
import { BlameError, blameLines, unchangedFrom } from "./blame.ts";

const file = (...lines: string[]) => ({ "src/app.ts": `${lines.join("\n")}\n` });

describe("unchangedFrom", () => {
  test("maps the lines an edit left alone to where they were", () => {
    expect([...unchangedFrom(["a", "b", "c"], ["a", "x", "b", "c"])!]).toEqual([0, -1, 1, 2]);
    expect([...unchangedFrom(["a", "b", "c"], ["a", "c"])!]).toEqual([0, 2]);
  });
});

describe("blameLines", () => {
  test("names the commit that last changed each line, across inserts that shift them", async () => {
    const git = fakeHistory();
    const root = git.commit({ files: file("one", "two", "three") });
    const edit = git.commit({ parents: [root], files: file("one", "TWO", "three") });
    const insert = git.commit({ parents: [edit], files: file("zero", "one", "TWO", "three") });
    // A commit that leaves the file alone is passed through without a diff.
    const other = git.commit({
      parents: [insert],
      files: { ...file("zero", "one", "TWO", "three"), "README.md": "hi\n" },
    });

    const result = await blameLines(git.reader, other, "src/app.ts", 1, 4);
    expect(result.truncated).toBe(false);
    expect(result.lines).toEqual([
      { line: 1, commit: insert, originalLine: 1 },
      { line: 2, commit: root, originalLine: 1 },
      { line: 3, commit: edit, originalLine: 2 },
      { line: 4, commit: root, originalLine: 3 },
    ]);
  });

  test("a landing merge passes a line to the timeline commit that wrote it", async () => {
    const git = fakeHistory();
    const base = git.commit({ files: file("a", "b", "c") });
    const work = git.commit({ parents: [base], files: file("a", "B", "c") });
    const main = git.commit({ parents: [base], files: file("a", "b", "C") });
    const merge = git.commit({ parents: [main, work], files: file("a", "B", "C") });

    const result = await blameLines(git.reader, merge, "src/app.ts", 1, 3);
    expect(result.lines.map((l) => l.commit)).toEqual([base, work, main]);
  });

  test("a merge's own resolution is the merge's", async () => {
    const git = fakeHistory();
    const base = git.commit({ files: file("a") });
    const left = git.commit({ parents: [base], files: file("left") });
    const right = git.commit({ parents: [base], files: file("right") });
    const merge = git.commit({ parents: [left, right], files: file("both") });
    const result = await blameLines(git.reader, merge, "src/app.ts", 1, 1);
    expect(result.lines).toEqual([{ line: 1, commit: merge, originalLine: 1 }]);
  });

  test("stops at its limits and says so", async () => {
    const git = fakeHistory();
    let head = git.commit({ files: file("x", "0") });
    for (let n = 1; n <= 5; n++) head = git.commit({ parents: [head], files: file("x", `${n}`) });
    const result = await blameLines(git.reader, head, "src/app.ts", 1, 1, {
      commits: 3,
      diffs: 100,
      bytes: 1000,
    });
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(1);
  });

  test("refuses lines past the end and files that aren't there", async () => {
    const git = fakeHistory();
    const head = git.commit({ files: file("only") });
    await expect(blameLines(git.reader, head, "src/app.ts", 2, 2)).rejects.toBeInstanceOf(
      BlameError,
    );
    await expect(blameLines(git.reader, head, "src/missing.ts", 1, 1)).rejects.toThrow(
      /No file at src\/missing.ts/,
    );
    // A range running past the end is cut to the file.
    const cut = await blameLines(git.reader, head, "src/app.ts", 1, 9);
    expect(cut.lines).toEqual([{ line: 1, commit: head, originalLine: 1 }]);
  });
});
