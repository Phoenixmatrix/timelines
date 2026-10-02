import { describe, expect, it } from "vite-plus/test";
import { outline, slug } from "./Markdown.tsx";

describe("outline", () => {
  it("lists h2 and h3 headings with the ids the renderer gives them", () => {
    const text = [
      "# Title",
      "## Problems it solves",
      "Some text.",
      "### The `gm` CLI",
      "```md",
      "## Not a heading",
      "```",
      "## See [the map](wiki:map)",
      "## Problems it solves",
    ].join("\n");
    expect(outline(text)).toEqual([
      { depth: 2, text: "Problems it solves", id: "problems-it-solves" },
      { depth: 3, text: "The gm CLI", id: "the-gm-cli" },
      { depth: 2, text: "See the map", id: "see-the-map" },
    ]);
  });

  it("slugs punctuation away", () => {
    expect(slug("CI/CD & the `vp_check` step")).toBe("cicd-the-vpcheck-step");
  });
});
