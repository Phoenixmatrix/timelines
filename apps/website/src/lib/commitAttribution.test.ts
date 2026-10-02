import { describe, expect, test } from "vite-plus/test";
import { coAuthors } from "./commitAttribution.ts";

describe("commit co-authors", () => {
  test("shows recorded people and agents without guessing their identities", () => {
    expect(
      coAuthors(
        "Fix\n\nCo-authored-by: Claude Opus <bot@example.test>\nCo-authored-by: Léa <lea@example.test>\nSigned-off-by: Dev <dev@example.test>",
      ),
    ).toEqual([
      { name: "Claude Opus", email: "bot@example.test" },
      { name: "Léa", email: "lea@example.test" },
    ]);
  });
  test("ignores body examples and malformed trailers, normalizes case and deduplicates", () => {
    expect(coAuthors("Example\n\nCo-authored-by: Example <a@b.test>\n\nActual message")).toEqual(
      [],
    );
    expect(
      coAuthors(
        "Fix\r\n\r\nco-AUTHORED-by: Bot <BOT@example.test>\r\nCo-authored-by: Bot <bot@example.test>\r\nCo-authored-by: missing email",
      ),
    ).toEqual([{ name: "Bot", email: "bot@example.test" }]);
  });
});
