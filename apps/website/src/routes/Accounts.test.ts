import { expect, test } from "vite-plus/test";
import { generatePassword } from "./Accounts.tsx";

test("generated passwords are long, unambiguous and different each time", () => {
  const passwords = new Set(Array.from({ length: 50 }, () => generatePassword()));
  expect(passwords.size).toBe(50);
  for (const password of passwords) expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{24}$/);
});
