import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, onTestFinished, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { attribution, type AuditActor } from "../../../shared/tracker.ts";
import { Actor } from "./Actor.tsx";
import "../../styles/app.css";

test("recorded agents lead with their own name and expose accountability without impersonating a human", async () => {
  const ann = { id: "ann", slug: "ann", displayName: "Ann Lee" };
  const snapshot = { members: [ann], agents: [] };
  const agent: AuditActor = {
    id: "deleted-agent",
    kind: "agent",
    name: "builder",
    accountable: ann,
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  onTestFinished(() => {
    root.unmount();
    container.remove();
  });
  root.render(
    <MemoryRouter>
      <Actor who={attribution(snapshot, agent.id, agent)} link />
      <Actor who={attribution(snapshot, "ann")} link />
      <Actor who={attribution(snapshot, "missing")} link />
    </MemoryRouter>,
  );
  const identity = page.getByTitle("builder · Agent · Accountable: Ann Lee");
  await expect.element(identity).toBeVisible();
  await expect.element(identity.getByText("builder", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Ann Lee" }))
    .toHaveAttribute("href", "/accounts/ann");
  await expect.element(page.getByTitle("missing · Unknown identity")).toBeVisible();
  expect(container.querySelectorAll("a")).toHaveLength(1);
});
