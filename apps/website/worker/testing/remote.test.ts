import { expect, test } from "vite-plus/test";
import { fakeRemotes } from "./remote.ts";

const first = "1".repeat(40);
const later = "2".repeat(40);

test("a native fork retains its own refs and commits after the parent changes or disappears", async () => {
  const git = fakeRemotes();
  const parent = git.add(
    "https://artifacts.test/parent",
    { "refs/heads/main": first },
    "refs/heads/main",
    "parent",
  );
  const ancestor = "0".repeat(39) + "1";
  parent.commits.add(ancestor);
  parent.parents.set(first, [ancestor]);
  const origin = await git.artifacts.get("parent");
  const created = await origin.fork("work", { readOnly: false });
  const fork = git.getByName("work");
  parent.refs.set("refs/heads/main", later);
  parent.commits.add(later);
  parent.parents.get(first)!.push(later);
  git.commits.add(later);
  expect(fork.refs.get("refs/heads/main")).toBe(first);
  const owned = await git.artifacts.get("work");
  expect(await owned.readCommit(first)).toEqual({
    hash: first,
    treeHash: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    parents: [ancestor],
  });
  expect(await owned.readCommit(later)).toBeNull();
  fork.refs.set("refs/heads/work", first);
  expect(parent.refs.has("refs/heads/work")).toBe(false);
  git.remotes.delete("https://artifacts.test/parent");
  expect((await owned.info()).remote).toBe(created.remote);
  expect((await owned.readCommit(first))?.hash).toBe(first);
  expect((await owned.readCommit(ancestor))?.parents).toEqual([]);
  await expect(git.artifacts.get("parent")).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("fork credentials can be enumerated and revoked without changing the parent's tokens", async () => {
  const git = fakeRemotes();
  git.add(
    "https://artifacts.test/parent",
    { "refs/heads/main": first },
    "refs/heads/main",
    "parent",
  );
  const origin = await git.artifacts.get("parent");
  const parentToken = await origin.createToken();
  await origin.fork("work", { readOnly: false });
  const owned = await git.artifacts.get("work");
  const initial = (await owned.listTokens()).tokens;
  expect(initial).toHaveLength(1);
  await owned.revokeToken(initial[0]!.id);
  expect((await owned.listTokens()).tokens).toEqual([]);
  expect((await origin.listTokens()).tokens).toEqual([parentToken]);
  await expect(origin.fork("work", { readOnly: false })).rejects.toMatchObject({
    code: "ALREADY_EXISTS",
  });
});
