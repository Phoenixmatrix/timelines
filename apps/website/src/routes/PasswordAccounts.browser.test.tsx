// Password accounts (CORE-404) in a real browser, against the Worker's routes
// in memory: a site admin creates an account with a generated password and
// gives it a new one; nobody else reaches the page; and the person signs in
// on the sign-in page's password form with their username.

import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { renderApp } from "../testing/render.tsx";
import { TestServer } from "../testing/server.ts";

test("a site admin creates an account and sets a new password; others can't", async () => {
  const server = await TestServer.start({ world: true, persona: "priya" });
  const app = renderApp("/settings/accounts");
  await expect.element(page.getByRole("heading", { name: "Accounts" })).toBeVisible();

  await userEvent.fill(page.getByLabelText("Username"), "demo");
  await userEvent.fill(page.getByLabelText("Email"), "demo@example.com");
  await userEvent.fill(page.getByLabelText("Name"), "Demo Person");
  await userEvent.click(page.getByRole("button", { name: "Generate" }));
  const password = page.getByLabelText("Password", { exact: true });
  // Generated, it's shown so the admin can copy it.
  await expect.element(password).toHaveAttribute("type", "text");
  const generated = (password.element() as HTMLInputElement).value;
  expect(generated).toHaveLength(24);
  await userEvent.click(page.getByRole("button", { name: "Create account" }));
  await expect.element(page.getByText("Created @demo. They can sign in now.")).toBeVisible();
  await expect.element(page.getByLabelText("Username")).toHaveValue("");

  const row = page.getByRole("listitem").filter({ hasText: "@demo" });
  await expect.element(row.getByText("Unverified email")).toBeVisible();
  await expect.element(row.getByText("Password", { exact: true })).toBeVisible();

  await userEvent.click(row.getByText("Set a new password"));
  await userEvent.fill(row.getByLabelText("New password for @demo"), "short");
  // The browser holds back a password under 12 characters.
  await userEvent.click(row.getByRole("button", { name: "Save new password" }));
  await expect.element(page.getByText(/New password saved/)).not.toBeInTheDocument();
  await userEvent.fill(row.getByLabelText("New password for @demo"), "a brand new passphrase");
  await userEvent.click(row.getByRole("button", { name: "Save new password" }));
  await expect
    .element(
      page.getByText(
        "New password saved for @demo. Their browser sessions ended; their access tokens still work.",
      ),
    )
    .toBeVisible();
  app.unmount();

  // Not a site admin: the page sends them home (the API's refusal is
  // worker/api/admin-accounts.test.ts's).
  await server.as("marco");
  renderApp("/settings/accounts");
  await expect.element(page.getByRole("heading", { name: "Accounts" })).not.toBeInTheDocument();
});

test("the sign-in page takes a username and password", async () => {
  const server = await TestServer.start({ world: true, persona: "priya" });
  await server.call("POST", "/api/admin/accounts", {
    username: "demo",
    email: "demo@example.com",
    displayName: "Demo Person",
    password: "correct horse battery",
  });
  await server.as(null);
  const app = renderApp("/signin?next=%2Fsettings%2Fprofile");
  await userEvent.click(page.getByRole("link", { name: "Sign in with a password" }));
  await expect
    .element(page.getByText(/Use the username or email and the password your admin gave you/))
    .toBeVisible();
  // The way back keeps where to go next.
  await expect
    .element(page.getByRole("link", { name: "Email me a code instead" }))
    .toHaveAttribute("href", "/signin?next=%2Fsettings%2Fprofile");

  await userEvent.fill(page.getByLabelText("Username or email"), "demo");
  await userEvent.fill(page.getByLabelText("Password"), "not the password at all");
  await userEvent.click(page.getByRole("button", { name: "Sign in" }));
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent(/That username or password isn't right/);
  // The username stays; the password doesn't.
  await expect.element(page.getByLabelText("Username or email")).toHaveValue("demo");
  await expect.element(page.getByLabelText("Password")).toHaveValue("");
  await expect.element(page.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");

  await userEvent.fill(page.getByLabelText("Password"), "correct horse battery");
  await userEvent.click(page.getByRole("button", { name: "Sign in" }));
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  // In memory the world still acts as nobody, so the ledger names the username.
  await expect.element(page.getByText("as demo", { exact: true })).toBeVisible();
  app.unmount();
});
