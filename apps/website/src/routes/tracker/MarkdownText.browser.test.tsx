import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { renderApp } from "../../testing/render.tsx";
import { TestServer } from "../../testing/server.ts";

test("absolute issue links in descriptions and comments navigate without replacing the document", async () => {
  const server = await TestServer.start({ world: true });
  const destination = "/tracker/orbit/issues/ENG-2?from=markdown#details";
  const absolute = `${location.origin}${destination}`;
  await server.call("POST", "/api/tracker/orbit/mutate", {
    ...(await server.trackerContract("orbit")),
    operationId: crypto.randomUUID(),
    mutations: [
      {
        kind: "team.create",
        id: "team",
        data: { key: "ENG", name: "Eng", memberIds: ["acc_marco"] },
      },
      {
        kind: "issue.create",
        id: "source",
        data: {
          teamId: "team",
          title: "Source issue",
          description: `[Description issue](${absolute} "Linked issue")\n\n[External issue](https://example.com/issues/ENG-2)\n\n[Local section](#details)`,
        },
      },
      {
        kind: "issue.create",
        id: "destination",
        data: { teamId: "team", title: "Destination issue" },
      },
      {
        kind: "comment.add",
        id: "comment",
        data: { issueId: "source", body: `[Comment issue](${absolute})` },
      },
    ],
  });

  const app = renderApp("/tracker/orbit/issues/ENG-1");
  const originalDocument = document;
  const originalRoot = app.container;
  await expect.element(page.getByRole("link", { name: "Description issue" })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Description issue" }))
    .toHaveAttribute("title", "Linked issue");
  await expect
    .element(page.getByRole("link", { name: "Local section" }))
    .toHaveAttribute("href", "#details");

  // Observe whether the router claimed a click, then cancel native navigation
  // at the document boundary so external/new-tab gestures do not leave the test.
  const nativeClick = (anchor: Element, options: MouseEventInit = {}) => {
    let intercepted: boolean | undefined;
    const observe = (event: MouseEvent) => {
      intercepted = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", observe, { once: true });
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options }),
    );
    expect(intercepted).toBe(false);
  };
  nativeClick(page.getByRole("link", { name: "External issue" }).element());
  nativeClick(page.getByRole("link", { name: "Local section" }).element());
  for (const options of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    nativeClick(page.getByRole("link", { name: "Description issue" }).element(), options);
  }
  expect(app.url().pathname).toBe("/tracker/orbit/issues/ENG-1");

  for (const name of ["Description issue", "Comment issue"]) {
    await userEvent.click(page.getByRole("link", { name }));
    await app.waitForUrl((url) => `${url.pathname}${url.search}${url.hash}` === destination);
    await expect
      .element(page.getByText("Destination issue", { exact: true }).first())
      .toBeVisible();
    expect(document).toBe(originalDocument);
    expect(document.getElementById("root")).toBe(originalRoot);
    await app.back();
    await expect.element(page.getByRole("link", { name: "Description issue" })).toBeVisible();
  }
});
