import { describe, expect, it } from "vite-plus/test";

import { SYSTEM_ACTOR } from "../core/auth/system.ts";
import { getPackage, setDistTag, listVersions } from "../core/catalog.ts";
import { Services } from "../core/context.ts";
import { getRepoByKey } from "../core/repos.ts";
import { makeHarness } from "../testing/harness.ts";
import { publishBody } from "../formats/npm/testing.ts";
import { applyRetention } from "./retention.ts";

describe("retention", () => {
  it("keeps the newest N versions and anything tagged", async () => {
    const h = await makeHarness();
    await h.createRepo({
      key: "js",
      format: "npm",
      kind: "local",
      visibility: "private",
      config: { retention: { keepLatest: 2 } },
    });
    const services = new Services(
      h.env,
      new Request("https://x/"),
      () => undefined,
      "t",
      SYSTEM_ACTOR,
    );
    const repo = (await getRepoByKey(services.db, "npm", "js"))!;
    h.grant("publisher", "admin");
    const token = h.token("publisher");
    for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"]) {
      expect(
        (
          await h.request("/npm/js/left-pad", {
            method: "PUT",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: publishBody("left-pad", v),
          })
        ).status,
      ).toBe(201);
      await new Promise((r) => setTimeout(r, 2));
    }
    const pkg = (await getPackage(services.db, repo.id, "left-pad"))!;
    await setDistTag(services.db, pkg.id, "legacy", "1.0.0");
    await services.db
      .deleteFrom("dist_tags")
      .where("package_id", "=", pkg.id)
      .where("tag", "=", "latest")
      .execute();
    const result = await applyRetention(services);
    expect(result.pruned).toBe(2);
    expect((await listVersions(services.db, pkg.id)).map((v) => v.version)).toEqual([
      "1.0.0",
      "1.3.0",
      "1.4.0",
    ]);
  });
});
