import { expect, onTestFinished, test, vi } from "vite-plus/test";
import { CONTENT_CONTRACT_HEADER, CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";
import { serve, world } from "./browser-api.ts";

vi.mock("cloudflare:email", () => ({ EmailMessage: class {} }));

test("disposing a browser world lets an admitted request finish before closing its databases", async () => {
  const { world: id } = (await world("create", { persona: "marco" })) as { world: string };
  onTestFinished(async () => {
    await world("dispose", { world: id });
  });
  const request = serve({
    world: id,
    method: "GET",
    url: "/api/spaces/orbit",
    headers: [[CONTENT_CONTRACT_HEADER, String(CONTENT_CONTRACT_VERSION)]],
    body: null,
  });
  const [, response] = await Promise.all([world("dispose", { world: id }), request]);
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    space: { id: "acc_orbit", slug: "orbit" },
    capabilities: { canReadContent: true },
  });
});
