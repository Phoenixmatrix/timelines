import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_HOST_PLACEHOLDER, SITE_HOST_PLACEHOLDER, hosts, withAppUrl } from "./hosts.ts";

await test("builds without the production hosts use placeholders", () => {
  assert.deepEqual(hosts({}), { site: SITE_HOST_PLACEHOLDER, app: APP_HOST_PLACEHOLDER });
  assert.deepEqual(
    hosts({ GITMATRIX_SITE_HOST: "www.acme.dev", GITMATRIX_PRODUCTION_HOST: "app.acme.dev" }),
    { site: "www.acme.dev", app: "app.acme.dev" },
  );
});

await test("a production deploy refuses placeholders and malformed hosts", () => {
  assert.throws(
    () => hosts({ GITMATRIX_DEPLOY: "production", GITMATRIX_PRODUCTION_HOST: "app.acme.dev" }),
    /needs GITMATRIX_SITE_HOST\./,
  );
  assert.throws(() => hosts({ GITMATRIX_SITE_HOST: "https://www.acme.dev" }), /lowercase hostname/);
});

await test("only the docs' full app address is swapped", () => {
  assert.equal(
    withAppUrl(
      `<a href="https://${APP_HOST_PLACEHOLDER}/settings">x</a> such as ${APP_HOST_PLACEHOLDER}`,
      "app.acme.dev",
    ),
    `<a href="https://app.acme.dev/settings">x</a> such as ${APP_HOST_PLACEHOLDER}`,
  );
});
