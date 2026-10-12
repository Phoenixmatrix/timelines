import assert from "node:assert/strict";
import { test } from "node:test";
import {
  absent,
  deleteArtifactsNamespace,
  ignoringAbsent,
  listArtifactsRepos,
  refusedNotEmpty,
  type CfRun,
} from "./cloudflare-delete.ts";

/** cf's rendering of an API error: title, `[code] message`, then the status line. */
function apiError(status: string, code: number, message: string): Error {
  return new Error(
    `cf artifacts namespaces failed (1):\nAPIError\n[${code}] ${message}\n${status}`,
  );
}

await test("absent accepts only cf's 404 status line and resource-qualified not-found", () => {
  for (const error of [
    apiError("404 Not Found · HTTP /accounts/a/d1/database/x", 7404, "Database not found"),
    apiError("404 Not Found", 10006, "The specified bucket does not exist."),
    "Error: namespace not found",
    "AI Search: Instance not found",
    "Vectorize: index not found",
    "AI Gateway: gateway not found",
    "resource not found",
    // cf colours the status line at chalk level 3 unless colour is off.
    apiError(
      "\x1b[38;2;127;127;127m404 Not Found\x1b[39m · HTTP /accounts/a/r2/buckets/b",
      10006,
      "gone",
    ),
    "APIError\n\x1b[31m\x1b[1m[10006]\x1b[22m\x1b[39m \x1b[1mgone\x1b[22m\n\x1b[2m404 Not Found\x1b[22m",
  ])
    assert.equal(absent(error), true, String(error));
  for (const error of [
    // Unqualified absence wording from the CLI or the OS, not from Cloudflare.
    "sh: 1: cf: command not found",
    'Profile "work" does not exist',
    "spawn cf ENOENT: no such file or directory",
    "config file not found",
    // Coloured, a 403 still isn't absence.
    apiError(
      "\x1b[38;2;127;127;127m403 Forbidden\x1b[39m · HTTP /x/fix-404",
      10000,
      "Authentication error",
    ),
    // A permission error whose request path happens to hold "404".
    apiError(
      "403 Forbidden · HTTP /accounts/a/r2/buckets/gitmatrix-preview-fix-404",
      10000,
      "Authentication error",
    ),
    "HTTP 500 after 404 retries",
    "fetch failed: connection reset",
    // Workers API codes are read from API bodies by their callers, never here.
    "[10007] something else",
    "[10025] something else",
  ])
    assert.equal(absent(error), false, String(error));
});

await test("refusedNotEmpty matches Cloudflare's not-empty refusal only", () => {
  assert.equal(refusedNotEmpty(apiError("409 Conflict", 10202, "Namespace is not empty")), true);
  assert.equal(refusedNotEmpty("namespace is not empty"), true);
  assert.equal(refusedNotEmpty("bucket not empty"), false);
  assert.equal(refusedNotEmpty(apiError("404 Not Found", 1, "namespace not found")), false);
});

await test("ignoringAbsent swallows absence and rethrows everything else", async () => {
  await ignoringAbsent(Promise.reject(apiError("404 Not Found", 1, "gone")));
  await assert.rejects(ignoringAbsent(Promise.reject(new Error("403 Forbidden"))), /403/);
  // A caller's own predicate replaces the default.
  await assert.rejects(
    ignoringAbsent(Promise.reject(new Error("namespace not found")), () => false),
    /namespace not found/,
  );
});

/** A fake Artifacts account whose list honours --limit, like the API. */
function account(namespaces: Record<string, string[]>, options: { stuck?: Set<string> } = {}) {
  const calls: string[] = [];
  const missing = (name: string) => apiError("404 Not Found", 1, `Namespace ${name} missing`);
  const run: CfRun = async (args) => {
    calls.push(args.join(" "));
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    if (args.slice(0, 4).join(" ") === "artifacts namespaces repos list") {
      const repos = namespaces[flag("--namespace")];
      if (!repos) throw missing(flag("--namespace"));
      return JSON.stringify(repos.slice(0, Number(flag("--limit"))).map((name) => ({ name })));
    }
    if (args.slice(0, 4).join(" ") === "artifacts namespaces repos delete") {
      const repos = namespaces[flag("--namespace")];
      if (!repos) throw missing(flag("--namespace"));
      const index = repos.indexOf(args[4]!);
      if (index < 0) throw apiError("404 Not Found", 1, "Repository not there");
      repos.splice(index, 1);
      return "";
    }
    if (args.slice(0, 3).join(" ") === "artifacts namespaces delete") {
      const repos = namespaces[args[3]!];
      if (!repos) throw missing(args[3]!);
      if (repos.length || options.stuck?.has(args[3]!))
        throw apiError("409 Conflict", 10202, "Namespace is not empty");
      delete namespaces[args[3]!];
      return "";
    }
    throw new Error(`unexpected cf ${args.join(" ")}`);
  };
  return { run, calls, namespaces };
}

await test("deletes every repository a page at a time, then the namespace", async () => {
  const repos = Array.from({ length: 250 }, (_, i) => `repo-${i}`);
  const fake = account({ ns: [...repos] });
  assert.equal(await deleteArtifactsNamespace(fake.run, "ns"), "deleted");
  assert.equal(fake.namespaces.ns, undefined);
  const lists = fake.calls.filter((call) => call.includes("repos list"));
  // Three pages of up to 100, then the empty list that ends the loop.
  assert.equal(lists.length, 4);
  assert.equal(fake.calls.filter((call) => call.includes("repos delete")).length, 250);
  assert.deepEqual(fake.calls.slice(0, 2), [
    "artifacts namespaces repos list --namespace ns --limit 100",
    "artifacts namespaces repos delete repo-0 --namespace ns --force",
  ]);
  assert.equal(fake.calls.at(-1), "artifacts namespaces delete ns --force");
});

await test("a namespace that isn't there is absent, without a delete", async () => {
  const fake = account({});
  assert.equal(await deleteArtifactsNamespace(fake.run, "ns"), "absent");
  assert.deepEqual(fake.calls, ["artifacts namespaces repos list --namespace ns --limit 100"]);
});

await test("a namespace a concurrent delete removed is absent", async () => {
  const fake = account({ ns: [] });
  const run: CfRun = async (args) => {
    if (args.slice(0, 3).join(" ") === "artifacts namespaces delete") delete fake.namespaces.ns;
    return fake.run(args);
  };
  assert.equal(await deleteArtifactsNamespace(run, "ns"), "absent");
});

await test("a refused namespace that lists nothing is orphaned through onOrphan", async () => {
  const fake = account({ ns: ["a"] }, { stuck: new Set(["ns"]) });
  const orphaned: unknown[] = [];
  const outcome = await deleteArtifactsNamespace(fake.run, "ns", {
    onOrphan: async (error) => {
      await Promise.resolve();
      orphaned.push(error);
    },
  });
  assert.equal(outcome, "orphaned");
  assert.equal(orphaned.length, 1);
  assert.match(String(orphaned[0]), /Namespace is not empty/);
  assert.deepEqual(fake.namespaces.ns, []);
});

await test("without onOrphan, the refusal is thrown", async () => {
  const fake = account({ ns: [] }, { stuck: new Set(["ns"]) });
  await assert.rejects(deleteArtifactsNamespace(fake.run, "ns"), /Namespace is not empty/);
});

await test("a refusal while a fresh list shows a repository is thrown, never orphaned", async () => {
  const fake = account({ ns: [] });
  let refused = false;
  const run: CfRun = async (args) => {
    if (args.slice(0, 3).join(" ") === "artifacts namespaces delete") {
      refused = true;
      fake.namespaces.ns!.push("late");
    }
    return fake.run(args);
  };
  let orphaned = false;
  await assert.rejects(
    deleteArtifactsNamespace(run, "ns", { onOrphan: () => (orphaned = true) }),
    /Namespace is not empty/,
  );
  assert.ok(refused);
  assert.equal(orphaned, false);
});

await test("a repository still listed after its deletes throws instead of spinning", async () => {
  const fake = account({ ns: ["ghost", "real"] });
  // Its delete answers "absent", but every list keeps showing it.
  let ghostDeletes = 0;
  const run: CfRun = async (args) => {
    if (args.includes("ghost") && args.includes("delete")) {
      ghostDeletes++;
      throw apiError("404 Not Found", 1, "Repository not there");
    }
    return fake.run(args);
  };
  const waits: number[] = [];
  const wait = async (ms: number) => waits.push(ms);
  await assert.rejects(
    deleteArtifactsNamespace(run, "ns", { wait }),
    /ns still lists repository ghost after 3 deletes/,
  );
  assert.equal(ghostDeletes, 3);
  // Each repeat waits longer for the list to catch up.
  assert.deepEqual(waits, [2_000, 4_000]);
  // The other repository went; the namespace delete was never attempted.
  assert.deepEqual(fake.namespaces.ns, ["ghost"]);
  assert.ok(!fake.calls.some((call) => call.startsWith("artifacts namespaces delete")));
  await assert.rejects(
    deleteArtifactsNamespace(run, "ns", { attempts: 1, wait }),
    /after 1 deletes/,
  );
});

await test("a list that lags a delete gets a pause, then the deletion finishes", async () => {
  const fake = account({ ns: ["slow"] });
  let stale = 1;
  const run: CfRun = async (args) => {
    // One list still shows the repository its delete just removed.
    if (args.includes("list") && stale && !fake.namespaces.ns!.length) {
      stale--;
      return JSON.stringify([{ name: "slow" }]);
    }
    return fake.run(args);
  };
  const waits: number[] = [];
  const outcome = await deleteArtifactsNamespace(run, "ns", {
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(outcome, "deleted");
  assert.deepEqual(waits, [2_000]);
});

await test("a refused namespace that a fresh list no longer finds is absent", async () => {
  const fake = account({ ns: [] }, { stuck: new Set(["ns"]) });
  const run: CfRun = async (args) => {
    // The refusal, then a concurrent delete wins before the fresh list.
    if (args.slice(0, 3).join(" ") === "artifacts namespaces delete")
      return fake.run(args).finally(() => delete fake.namespaces.ns);
    return fake.run(args);
  };
  let orphaned = false;
  const outcome = await deleteArtifactsNamespace(run, "ns", { onOrphan: () => (orphaned = true) });
  assert.equal(outcome, "absent");
  assert.equal(orphaned, false);
});

await test("other failures propagate from list, repository delete and namespace delete", async () => {
  for (const failing of ["repos list", "repos delete", "namespaces delete"]) {
    const fake = account({ ns: ["a"] });
    const run: CfRun = async (args) => {
      if (args.join(" ").includes(failing))
        throw apiError("403 Forbidden", 10000, "Authentication error");
      return fake.run(args);
    };
    await assert.rejects(deleteArtifactsNamespace(run, "ns"), /Authentication error/, failing);
  }
});

await test("a caller's absence predicate decides list, delete and namespace absence", async () => {
  const strict = (error: unknown) =>
    /\bAPIError\b/.test(String(error)) && /404 Not Found/.test(String(error));
  const loose = new Error("namespace not found");
  // The default predicate would call this absent; the strict caller's doesn't.
  const run: CfRun = async () => {
    throw loose;
  };
  assert.equal(await deleteArtifactsNamespace(run, "ns"), "absent");
  await assert.rejects(
    deleteArtifactsNamespace(run, "ns", { absent: strict }),
    /namespace not found/,
  );
  assert.equal(await listArtifactsRepos(run, "ns"), null);
  await assert.rejects(listArtifactsRepos(run, "ns", strict), /namespace not found/);
});

await test("a deadline stops a deletion between calls, and is optional", async () => {
  const repos = Array.from({ length: 250 }, (_, i) => `repo-${i}`);
  const fake = account({ ns: [...repos] });
  let now = 0;
  // Each call to the clock is a second later; the deadline is 50 seconds in.
  const clock = () => (now += 1_000);
  await assert.rejects(
    deleteArtifactsNamespace(fake.run, "ns", { deadline: 50_000, clock }),
    /Deleting Artifacts namespace ns ran out of time/,
  );
  const deleted = fake.calls.filter((call) => call.includes("repos delete")).length;
  assert.ok(deleted > 0 && deleted < 50, String(deleted));
  assert.ok(!fake.calls.some((call) => call.startsWith("artifacts namespaces delete")));
  // A deadline already past starts nothing.
  const untouched = account({ ns: ["a"] });
  await assert.rejects(
    deleteArtifactsNamespace(untouched.run, "ns", { deadline: 0, clock: () => 1 }),
    /ran out of time/,
  );
  assert.deepEqual(untouched.calls, []);
  // Without one, the same namespace goes all the way.
  assert.equal(await deleteArtifactsNamespace(fake.run, "ns"), "deleted");
});
