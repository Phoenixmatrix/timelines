import { describe, expect, test, vi } from "vite-plus/test";
import { mergedBranch } from "../../shared/landings.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { landedTimelines, ownerTimelines } from "./timelines.ts";

const merge = (hash: string, message: string, parents = ["main", `${hash}-tip`]) =>
  ({ hash, message, parents }) as unknown as ArtifactsCommitMetadata;

describe("landed timelines", () => {
  test("merge messages name the branch they merged", () => {
    expect(mergedBranch("Merge branch 'timeline/search'")).toBe("timeline/search");
    expect(mergedBranch("Merge branch 'feature' into main")).toBe("feature");
    expect(mergedBranch("Merge remote-tracking branch 'origin/fix-login'")).toBe("fix-login");
    expect(mergedBranch("Merge side")).toBe("side");
    expect(mergedBranch("Land origin/timeline/ranking.v2.\n\nCORE-12")).toBe("timeline/ranking.v2");
    expect(mergedBranch("Merge pull request #4 from someone/branch")).toBeNull();
    expect(mergedBranch("Fix the parser")).toBeNull();
  });

  test("the push log names the merged commit's timeline branch first", async () => {
    const sqlite = migratedDatabase();
    sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc', 'org', 'org', 'Org');
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('repo', 'acc', 'app', 'private', 'a', 'https://a');
      INSERT INTO ref_updates (repo_id, ref, old_oid, new_oid) VALUES
        ('repo', 'refs/heads/wip', NULL, 'A-tip'),
        ('repo', 'refs/heads/timeline/search', NULL, 'A-tip'),
        ('repo', 'refs/heads/main', 'main', 'B-tip'),
        ('repo', 'refs/heads/fix', NULL, 'C-tip');
    `);
    const found = await landedTimelines(d1(sqlite), "repo", "main", [
      merge("A", "Merge wip"),
      merge("B", "Land timeline/ranking"),
      merge("C", "Merge branch 'other'"),
      merge("D", "Merge commit 1234"),
    ]);
    expect(Object.fromEntries(found)).toEqual({
      A: { id: null, branch: "timeline/search", landing: "A" },
      // The default branch reaching the merged commit says nothing about it.
      B: { id: null, branch: "timeline/ranking", landing: "B" },
      C: { id: null, branch: "fix", landing: "C" },
      D: { id: null, branch: null, landing: "D" },
    });
    // With timeline records, a timeline branch names its record.
    const asked: string[][] = [];
    const named = await landedTimelines(
      d1(sqlite),
      "repo",
      "main",
      [merge("A", "Merge wip"), merge("B", "Land timeline/ranking"), merge("C", "Merge fix")],
      async (slugs) => {
        asked.push(slugs);
        return new Map([["search", "tl_search"]]);
      },
    );
    expect(asked).toEqual([["search", "ranking"]]);
    expect(Object.fromEntries(named)).toEqual({
      A: { id: "tl_search", branch: "timeline/search", landing: "A" },
      B: { id: null, branch: "timeline/ranking", landing: "B" },
      C: { id: null, branch: "fix", landing: "C" },
    });
  });

  test("timeline ids come from the tracker of the repository's owner", async () => {
    const getByName = vi.fn(() => ({
      listTimelines: async () => ({
        ok: true,
        value: [
          { id: "tl_search", slug: "search" },
          { id: "tl_other", slug: "other" },
        ],
      }),
    }));
    const env = { TRACKER: { getByName } } as unknown as Env;
    expect(await ownerTimelines(env, "acc")(["search", "missing"])).toEqual(
      new Map([["search", "tl_search"]]),
    );
    expect(getByName).toHaveBeenCalledWith("acc");
  });
});
