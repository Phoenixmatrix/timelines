import assert from "node:assert/strict";
import { test } from "node:test";
import { agentIdentity, identityLine, resolveIdentity } from "../hooks/identity.ts";

const shown = {
  agent: {
    id: "agt_1",
    name: "careful-fox",
    accountable: { id: "acc_1", displayName: "Owner" },
    token: "do-not-display",
  },
};

test("identity projection serializes only the agent and accountable owner", () => {
  const identity = agentIdentity(JSON.parse(JSON.stringify(shown)));
  assert.deepEqual(identity, { id: "agt_1", name: "careful-fox", accountable: "Owner" });
  assert.equal(identityLine(identity!), "Agent: careful-fox · accountable: Owner");
  assert.equal(JSON.stringify(identity).includes("do-not-display"), false);
  assert.equal(agentIdentity({ agent: { id: "agt_1", name: "fox" } })?.accountable, null);
  assert.equal(
    agentIdentity({ agent: { id: "agt_1", name: "fox", accountable: { id: "acc_1" } } })
      ?.accountable,
    "acc_1",
  );
});

test("missing, malformed, person, revoked and terminal-control identities fail closed", () => {
  for (const value of [
    null,
    [],
    {},
    { user: shown.agent },
    { agent: [] },
    { agent: { id: "agt_1" } },
    { agent: { name: "fox" } },
    { agent: { ...shown.agent, kind: "person" } },
    { agent: { ...shown.agent, revokedAt: "2026-01-01" } },
    { agent: { ...shown.agent, name: "fox\u001b[2J" } },
  ]) {
    assert.equal(agentIdentity(value), null);
  }
});

test("resolution uses each checkout afresh and never falls back to a prior identity", async () => {
  const calls: { argv: string[]; cwd: string }[] = [];
  const run = async (argv: string[], cwd: string) => {
    calls.push({ argv, cwd });
    if (argv[0] === "git") return { exitCode: cwd === "/outside" ? 128 : 0, stdout: cwd };
    return { exitCode: 0, stdout: JSON.stringify({ agent: { id: cwd, name: cwd.slice(1) } }) };
  };
  assert.equal((await resolveIdentity(run, "/first"))?.name, "first");
  assert.equal((await resolveIdentity(run, "/second"))?.name, "second");
  assert.equal(await resolveIdentity(run, "/outside"), null);
  assert.deepEqual(
    calls.filter(({ argv }) => argv[0] === "gm"),
    [
      { argv: ["gm", "agent", "show", "-o", "json"], cwd: "/first" },
      { argv: ["gm", "agent", "show", "-o", "json"], cwd: "/second" },
    ],
  );
  for (const stdout of ["credential secret", "null", "{}", '{"agent":{"name":"fox"}}']) {
    assert.equal(await resolveIdentity(async () => ({ exitCode: 0, stdout }), "/first"), null);
  }
  assert.equal(
    await resolveIdentity(async () => {
      throw new Error("credential secret");
    }, "/first"),
    null,
  );
  assert.equal(
    await resolveIdentity(async () => ({ exitCode: 1, stdout: JSON.stringify(shown) }), "/first"),
    null,
  );
});
