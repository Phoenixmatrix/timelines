import { readFile, writeFile, chmod } from "node:fs/promises";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { canonicalSpaceJson, spaceDigest } from "../apps/website/shared/space-cutover.ts";
import {
  confirmListing,
  listWorkflowInstances,
  type ListedInstance,
} from "../apps/website/shared/space-cutover-census.ts";

/** Application operator protocol, not a Cloudflare resource-management CLI.
 * No origin, production mapping, credentials or approval has a default.
 * Only `workflow-census` calls cf, read-only, to export the provider's own
 * Workflow instance lists and the Worker's deployment history; the application
 * decides and terminates.
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    origin: { type: "string" },
    state: { type: "string" },
    manifest: { type: "string" },
    checkpoint: { type: "string" },
    digest: { type: "string" },
    "cookie-file": { type: "string" },
    out: { type: "string" },
    steps: { type: "string" },
    fresh: { type: "boolean" },
    replay: { type: "string" },
    run: { type: "string" },
    account: { type: "string" },
    worker: { type: "string" },
    "version-id": { type: "string" },
    mode: { type: "string" },
    help: { type: "boolean" },
  },
});
const command = positionals[0];
if (values.help || !command) {
  console.log(
    "node tools/space-cutover.ts <inventory|prepare|approve|status|fence|reconcile-refs|workflow-census|drain|begin|advance|recover|operator-login|approve-release|open-admission> --origin URL --state PRIVATE_FILE [--cookie-file PRIVATE_FILE] [--manifest FILE --checkpoint SHA] [--digest EXACT_DIGEST] [--version-id PLATFORM_VERSION --mode space|legacy] [--steps 1..500] [--fresh] [--out PRIVATE_FILE] [--account ACCOUNT_ID --worker NAME (workflow-census)]\n" +
      "node tools/space-cutover.ts replay-refs --origin URL --cookie-file YOUR_SESSION --run RUN_ID --replay PASS:REPO_ID:SOURCE_ID  (a person with write access in the replay's Space)",
  );
} else {
  try {
    // A Space writer re-triggering a blocked replay holds no operator state.
    if (!values.origin || (!values.state && command !== "replay-refs"))
      throw new Error("Explicit --origin and private --state path are required");
    const origin = new URL(values.origin);
    if (
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password ||
      (origin.protocol !== "https:" &&
        !(
          origin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
        ))
    )
      throw new Error("Use an explicit HTTPS origin (HTTP only for loopback fixtures)");
    type OperatorState = {
      origin: string;
      runId: string | null;
      manifestDigest: string;
      checkpoint: string;
      recoveryToken: string;
    };
    let state: OperatorState | null = null;
    if (!["prepare", "inventory", "replay-refs"].includes(command)) {
      state = JSON.parse(await readFile(values.state!, "utf8")) as OperatorState;
      if (state.origin !== origin.origin)
        throw new Error("Operator state belongs to another installation");
      if (!state.runId && command !== "status")
        throw new Error(
          "Enrollment response was interrupted; run status to recover its exact run identity first",
        );
    }
    const cookie =
      values["cookie-file"] && command !== "operator-login"
        ? (await readFile(values["cookie-file"], "utf8")).trim()
        : null;
    async function request(
      path: string,
      body?: unknown,
      cookieOutput?: string,
    ): Promise<Record<string, unknown>> {
      const headers: Record<string, string> = { origin: origin.origin, accept: "application/json" };
      if (cookie) headers.cookie = cookie;
      if (state && !["approve", "prepare"].includes(command!))
        headers["x-space-cutover-recovery"] = state.recoveryToken;
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(`${origin.origin}/api/admin/space-cutover${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          `Operator request rejected (${response.status}); inspect status, approval and consumer drain. No automatic retry was attempted.`,
        );
      if (cookieOutput) {
        const name = `${origin.protocol === "https:" ? "__Secure-" : ""}gm.cutover_operator`;
        const session = response.headers
          .getSetCookie()
          .find((value) => value.startsWith(`${name}=`))
          ?.split(";")[0];
        if (!session || !/^[A-Za-z0-9_-]{43}$/.test(session.slice(name.length + 1)))
          throw new Error("Operator session response is missing its scoped cookie");
        await writeFile(cookieOutput, `${session}\n`, { mode: 0o600, flag: "wx" });
      }
      return (await response.json()) as Record<string, unknown>;
    }
    async function privateFile(path: string, content: unknown, exclusive = false) {
      await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, {
        mode: 0o600,
        flag: exclusive ? "wx" : "w",
      });
      await chmod(path, 0o600);
    }
    if (command === "inventory") {
      if (!cookie || !values.out)
        throw new Error(
          "Inventory requires --cookie-file and --out (no mapping or approval is inferred)",
        );
      await privateFile(values.out, await request("/inventory"), true);
      console.log(
        "Inventory written privately; author and review an explicit manifest before prepare.",
      );
    } else if (command === "prepare") {
      if (!cookie || !values.manifest || !values.checkpoint)
        throw new Error("Prepare requires --cookie-file, --manifest and exact --checkpoint");
      const manifest = JSON.parse(await readFile(values.manifest, "utf8")) as unknown;
      state = {
        origin: origin.origin,
        runId: null,
        manifestDigest: await spaceDigest(canonicalSpaceJson(manifest)),
        checkpoint: values.checkpoint,
        recoveryToken: randomBytes(32).toString("hex"),
      };
      // Persist the capability BEFORE server mutation: a lost HTTP response
      // must not strand an approved operator outside its recovery journal.
      await privateFile(values.state!, state, true);
      const result = await request("/prepare", {
        manifest,
        checkpoint: values.checkpoint,
        recoveryToken: state.recoveryToken,
      });
      if (result.manifestDigest !== state.manifestDigest || typeof result.runId !== "string")
        throw new Error("Enrollment response does not match the prepared manifest");
      state.runId = result.runId;
      await privateFile(values.state!, state);
      console.log(
        JSON.stringify({
          runId: result.runId,
          manifestDigest: result.manifestDigest,
          checkpoint: result.checkpoint,
          recovery: "Saved privately to --state; never commit or print it.",
        }),
      );
    } else if (command === "approve") {
      if (
        !cookie ||
        !values.digest ||
        !values.checkpoint ||
        values.digest !== state!.manifestDigest ||
        values.checkpoint !== state!.checkpoint
      )
        throw new Error(
          "Approval requires current human --cookie-file and exact reviewed --digest and --checkpoint",
        );
      await request("/approve", {
        runId: state!.runId,
        manifestDigest: values.digest,
        checkpoint: values.checkpoint,
      });
      console.log("Exact manifest/checkpoint human approval recorded; no migration was activated.");
    } else if (command === "status") {
      const result = await request("");
      if (!state!.runId) {
        const run = result.run as {
          runId: string;
          manifestDigest: string;
          checkpoint: string;
        } | null;
        if (
          !run ||
          run.manifestDigest !== state!.manifestDigest ||
          run.checkpoint !== state!.checkpoint
        )
          throw new Error("Interrupted enrollment does not match the independent journal");
        state!.runId = run.runId;
        await privateFile(values.state!, state);
      }
      if (values.out) await privateFile(values.out, result);
      else console.log(JSON.stringify(result, null, 2));
    } else if (command === "operator-login") {
      if (!values["cookie-file"] || !process.stdin.isTTY)
        throw new Error(
          "Operator login requires an interactive human and a new private --cookie-file",
        );
      const challenge = await request("/operator-auth/start", {});
      if (typeof challenge.challengeId !== "string")
        throw new Error("Operator authentication challenge was not issued");
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      let code: string;
      try {
        code = await prompt.question("Code sent to the enrolled operator's verified email: ");
      } finally {
        prompt.close();
      }
      await request(
        "/operator-auth/verify",
        { challengeId: challenge.challengeId, code: code.trim() },
        values["cookie-file"],
      );
      console.log(
        "A 15-minute operator session was saved privately. No release approval was recorded.",
      );
    } else if (command === "approve-release") {
      if (
        !cookie ||
        !values.digest ||
        values.digest !== state!.manifestDigest ||
        !values.checkpoint ||
        !values["version-id"] ||
        !["space", "legacy"].includes(values.mode ?? "")
      )
        throw new Error(
          "Release approval requires fresh human --cookie-file, exact --digest, reviewed --checkpoint, --version-id and --mode space|legacy",
        );
      await request("/approve-release", {
        runId: state!.runId,
        manifestDigest: values.digest,
        checkpoint: values.checkpoint,
        versionId: values["version-id"],
        mode: values.mode,
      });
      console.log(
        "Exact release decision recorded. Admission still requires actual compatible consumer acknowledgements.",
      );
    } else if (
      ["fence", "drain", "begin", "advance", "recover", "open-admission"].includes(command)
    ) {
      const steps = command === "advance" ? Number(values.steps ?? 1) : 1;
      if (!Number.isInteger(steps) || steps < 1 || steps > 500)
        throw new Error("--steps must be 1..500");
      for (let step = 0; step < steps; step++) {
        const status = await request("");
        const run = status.run as {
          phase: string;
          runId: string;
          manifestDigest: string;
          checkpoint: string;
        };
        if (
          !run ||
          run.runId !== state!.runId ||
          run.manifestDigest !== state!.manifestDigest ||
          run.checkpoint !== state!.checkpoint
        )
          throw new Error("Independent journal changed; refusing stale operator state");
        if (command === "advance" && ["reconciled", "restored"].includes(run.phase)) break;
        await request(`/${command}`, { runId: state!.runId });
      }
      console.log(JSON.stringify(await request(""), null, 2));
    } else if (command === "reconcile-refs") {
      // Fenced and pre-open passes repair under the run's own authority. After
      // admission opens, replayed push effects need --cookie-file: a current
      // human session of the enrolled operator initiates them.
      const steps = Number(values.steps ?? 500);
      if (!Number.isInteger(steps) || steps < 1 || steps > 500)
        throw new Error("--steps must be 1..500");
      type Stage = { latest: { complete: boolean; phase: string } | null; clean: boolean };
      type Reconciliation = {
        stages: Record<string, Stage>;
        pendingReplays: number;
        blockedReplays: number;
      };
      let result: Reconciliation | null = null;
      for (let step = 0; step < steps; step++) {
        const status = (await request("")).run as { phase: string; runId: string } | null;
        if (!status || status.runId !== state!.runId)
          throw new Error("Independent journal changed; refusing stale operator state");
        result = (await request("/reconcile-refs", {
          runId: state!.runId,
          fresh: step === 0 && values.fresh === true,
        })) as unknown as Reconciliation;
        const stage =
          status.phase === "fenced"
            ? "fenced"
            : ["active", "legacy-active"].includes(status.phase)
              ? "post-open"
              : "pre-open";
        const current = result.stages[stage];
        if (current?.clean && current.latest?.phase === status.phase) break;
      }
      console.log(JSON.stringify(result, null, 2));
      if (result?.blockedReplays)
        console.error(
          `${result.blockedReplays} replay(s) are blocked: each lists its reason. A person with write access in its Space re-triggers it with replay-refs.`,
        );
    } else if (command === "replay-refs") {
      // Run by a person with write access in the replay's Space, with their own
      // current session: no operator state or recovery capability is sent.
      const [pass, repoId, sourceId] = (values.replay ?? "").split(":");
      if (!cookie || !values.run || !pass || !/^\d+$/.test(pass) || !repoId || !sourceId)
        throw new Error(
          "replay-refs requires --cookie-file, --run and --replay PASS:REPO_ID:SOURCE_ID",
        );
      console.log(
        JSON.stringify(
          await request("/replay-refs", {
            runId: values.run,
            replay: { pass: Number(pass), repoId, sourceId },
          }),
          null,
          2,
        ),
      );
    } else if (command === "workflow-census") {
      // Workflows document no bound for work an older release started, and the
      // Worker holds no account credential to list them: the operator exports
      // the provider's own lists with cf (read-only), and the next `drain`
      // terminates what remains. Every instance of every status, every page,
      // listed twice to confirm no page was skipped, from an explicitly named
      // account, plus the Worker's deployment history.
      const account = values.account;
      const worker = values.worker;
      if (!account || !/^[0-9a-f]{32}$/.test(account) || !worker)
        throw new Error(
          "workflow-census requires the installation's --account ID and --worker name",
        );
      const cf = (args: string[]) =>
        execFileSync("cf", args, {
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
          stdio: ["ignore", "pipe", "inherit"],
        });
      // cf resolves the account from its own configuration: refuse another one.
      const planned = JSON.parse(
        cf(["workflows", "instances", "list", "--workflow-name", "ci-run", "--dry-run"]),
      ) as { url?: string };
      if (!planned.url?.includes(`/accounts/${account}/`))
        throw new Error("cf is configured for another account; refusing a census of the wrong one");
      const workflows: Record<string, { name: string; instances: ListedInstance[] }> = {};
      for (const workflow of ["ci-run", "knowledge-build", "repo-purge"]) {
        const list = () =>
          listWorkflowInstances(workflow, ({ cursor, page, perPage }) =>
            cf([
              "workflows",
              "instances",
              "list",
              "--workflow-name",
              workflow,
              "--per-page",
              String(perPage),
              ...(cursor ? ["--cursor", cursor] : page > 1 ? ["--page", String(page)] : []),
            ]),
          );
        const first = list();
        const second = list();
        confirmListing(workflow, first, second);
        workflows[workflow] = { name: workflow, instances: second };
      }
      const history = JSON.parse(
        cf(["workers", "deployments", "list", "--worker", worker, "--per-page", "100"]),
      ) as {
        deployments?: {
          id: string;
          created_on: string;
          versions: { version_id: string; percentage: number }[];
        }[];
      };
      if (!Array.isArray(history.deployments) || !history.deployments.length)
        throw new Error("The Worker's deployment history is empty; refusing the census");
      const deployments = history.deployments.map((deployment) => ({
        id: deployment.id,
        createdOn: deployment.created_on,
        versions: deployment.versions.map((version) => ({
          versionId: version.version_id,
          percentage: version.percentage,
        })),
      }));
      await request("/workflow-census", {
        runId: state!.runId,
        census: { account, worker, workflows, deployments },
      });
      console.log(
        JSON.stringify({
          account,
          worker,
          instances: Object.fromEntries(
            Object.entries(workflows).map(([name, entry]) => [name, entry.instances.length]),
          ),
          deployments: deployments.length,
        }),
      );
    } else throw new Error("Unknown command; use --help");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Operator command failed");
    process.exitCode = 1;
  }
}
