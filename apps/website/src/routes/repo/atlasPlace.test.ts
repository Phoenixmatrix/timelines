import { describe, expect, it } from "vite-plus/test";
import { landedUnder, type Shown } from "./atlasPlace.ts";

const shown = (patch: Partial<Shown> = {}): Shown => ({
  key: "k1",
  scope: "orbit/atlas",
  snapshot: "s1",
  ...patch,
});

describe("landedUnder", () => {
  it("is a new snapshot at the same address, with no navigation: a build landed", () => {
    expect(landedUnder(shown(), shown({ snapshot: "s2" }))).toBe(true);
  });

  it("isn't a navigation, a first view, the same snapshot or another repository", () => {
    expect(landedUnder(null, shown())).toBe(false);
    expect(landedUnder(shown(), shown())).toBe(false);
    expect(landedUnder(shown(), shown({ key: "k2", snapshot: "s2" }))).toBe(false);
    expect(landedUnder(shown(), shown({ scope: "orbit/other", snapshot: "s2" }))).toBe(false);
  });

  it("isn't the first map arriving or the map going away", () => {
    expect(landedUnder(shown({ snapshot: null }), shown())).toBe(false);
    expect(landedUnder(shown(), shown({ snapshot: null }))).toBe(false);
  });
});
