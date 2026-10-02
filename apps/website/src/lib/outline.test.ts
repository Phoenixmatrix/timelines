import { describe, expect, it } from "vite-plus/test";
import { findDefinitions } from "./outline.ts";

const code = `import { thing } from "./thing.ts";
// uses Store before defining it
export interface Access {
  id: string;
}
export class Store {
  async apply(input: string) {
    return thing(input);
  }
}
const helper = () => Store;
export function* walk() {}
`.split("\n");

describe("findDefinitions", () => {
  it("finds declarations before earlier mentions", () => {
    expect(findDefinitions(code, ["Store", "Access", "helper", "walk"])).toEqual([
      { name: "Store", line: 6, kind: "class" },
      { name: "Access", line: 3, kind: "interface" },
      { name: "helper", line: 11, kind: "const" },
      { name: "walk", line: 12, kind: "function" },
    ]);
  });

  it("finds methods by their last name segment", () => {
    expect(findDefinitions(code, ["Store.apply"])).toEqual([
      { name: "Store.apply", line: 7, kind: "method" },
    ]);
  });

  it("falls back to a mention, then to nothing", () => {
    expect(findDefinitions(code, ["thing", "missing"])).toEqual([
      { name: "thing", line: 1, kind: "symbol" },
      { name: "missing", line: null, kind: "symbol" },
    ]);
  });
});
