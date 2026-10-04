// The Semantic Code Atlas against the real providers (CORE-179, the CORE-155
// PRD's gate 19, with gates 4, 11 and 15 for the degraded providers).
//
// Part of `vp run agent test-ai`, beside the Copper Finch scenario. Real
// repositories are pushed to the isolated server and built by the real
// Knowledge pipeline (Workers AI analysis, concepts, synthesis); the Atlas is
// projected from them with capability names and summaries written by the real
// model through the Atlas budget, then read through its API and its UI.
//
//   priya/lumen-ledger-*  two capabilities, each spanning two folders, built
//                         with the default model, prices and caps; it is the
//                         registry source of the npm package `lumen-ledger`
//   priya/lumen-shop-*    one capability importing `lumen-ledger`: with the
//                         ledger, a workspace whose dependency resolves
//   marco/…, jun/…, sam/… the ledger's source again, owned by accounts the
//                         environment configures (ATLAS_PROVIDER_CONFIG):
//                         Atlas paid synthesis disabled (no priced model), a
//                         model the provider refuses, and a one-call build cap
//
// Nothing is mocked: the degraded accounts reach the same build code through
// the environment's ATLAS_CONFIG (worker/knowledge/budget.ts), and their
// failures are the real budget's and the real provider's. Evidence lands in
// ai-e2e.json under `atlas`.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  expect as playwrightExpect,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import type { KnowledgeBuild, KnowledgeStatus } from "../../apps/website/shared/api.ts";
import type {
  AtlasCrossLink,
  AtlasDescription,
  AtlasDetail,
  AtlasEvidence,
  AtlasInference,
  AtlasOverview,
  AtlasPage,
  AtlasProvenance,
  AtlasWorkspaceComposition,
} from "../../apps/website/shared/atlas.ts";
import { command } from "./environment.ts";
import type { HarnessContext, Persona, SeedManifest } from "./types.ts";

/** A model id Workers AI does not serve: the provider refuses every call to it. */
export const ATLAS_REFUSED_MODEL = "@cf/gitmatrix/atlas-unserved-model";

/**
 * The environment's Atlas settings per owning account (GITMATRIX_ATLAS_CONFIG,
 * the ATLAS_CONFIG binding). priya keeps the built-in defaults.
 */
export const ATLAS_PROVIDER_CONFIG = {
  accounts: {
    // No price for any model: the budget disables paid synthesis.
    marco: { prices: {} },
    // Priced, so reservations succeed, and refused by the real provider.
    jun: {
      model: ATLAS_REFUSED_MODEL,
      prices: { [ATLAS_REFUSED_MODEL]: { input: 0.45, output: 3.2 } },
    },
    // One Atlas call per build: the rest of the build's capabilities wait.
    sam: { limits: { build: { calls: 1 } } },
  },
};

const PACKAGE = "lumen-ledger";

/** The ledger's two capabilities, each across two folders (by import evidence alone). */
const LEDGER_CAPABILITY = [
  "src/journal/entry.ts",
  "src/journal/post.ts",
  "src/journal/reverse.ts",
  "src/accounts/chart.ts",
  "src/accounts/balance.ts",
];
const CURRENCY_CAPABILITY = [
  "src/rates/table.ts",
  "src/rates/convert.ts",
  "src/format/money.ts",
  "src/format/round.ts",
];
const SHOP_CAPABILITY = [
  "src/checkout/cart.ts",
  "src/checkout/pay.ts",
  "src/receipts/receipt.ts",
  "src/receipts/print.ts",
];

/** A function each fixture file defines, to recognise its source on the blob page. */
const SYMBOL: Record<string, string> = {
  "entry.ts": "journalEntry",
  "post.ts": "postJournalEntry",
  "reverse.ts": "reverseJournalEntry",
  "chart.ts": "accountFor",
  "balance.ts": "trialBalance",
  "table.ts": "rateFor",
  "convert.ts": "convertAmount",
  "money.ts": "formatMoney",
  "round.ts": "roundHalfEven",
  "cart.ts": "cartTotal",
  "pay.ts": "payForCart",
  "receipt.ts": "receiptFor",
  "print.ts": "printReceipt",
};

const LEDGER: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: PACKAGE, version: "1.0.0", type: "module", main: "index.ts" }, null, 2)}\n`,
  "README.md":
    "# Lumen Ledger\n\nDouble-entry bookkeeping. Post balanced journal entries to a chart of accounts, reverse them, and read the trial balance. Foreign amounts are converted with an exchange-rate table and rounded half to even.\n",
  "index.ts": [
    'export { postJournalEntry, ledgerBalance, type Ledger } from "./src/journal/post";',
    'export { reverseJournalEntry } from "./src/journal/reverse";',
    'export { journalEntry, type JournalEntry, type JournalLine } from "./src/journal/entry";',
    'export { trialBalance } from "./src/accounts/balance";',
    "",
  ].join("\n"),
  "src/journal/entry.ts": `/** One line of a journal entry: an amount debited or credited to an account code. */
export interface JournalLine {
  account: string;
  debit: number;
  credit: number;
}

/** A balanced double-entry journal entry: its debits equal its credits. */
export interface JournalEntry {
  id: string;
  date: string;
  memo: string;
  lines: JournalLine[];
}

/** Build a journal entry, rejecting one whose debits and credits don't balance. */
export function journalEntry(id: string, date: string, memo: string, lines: JournalLine[]): JournalEntry {
  const debits = lines.reduce((sum, line) => sum + line.debit, 0);
  const credits = lines.reduce((sum, line) => sum + line.credit, 0);
  if (Math.abs(debits - credits) > 1e-9) throw new Error(\`Journal entry \${id} is unbalanced\`);
  return { id, date, memo, lines };
}
`,
  "src/journal/post.ts": `import { journalEntry, type JournalEntry, type JournalLine } from "./entry";
import { accountFor } from "../accounts/chart";
import { trialBalance } from "../accounts/balance";

/** A ledger: the journal entries posted to it so far, in order. */
export interface Ledger {
  entries: JournalEntry[];
}

/** Post a balanced journal entry to the ledger after checking every account in the chart. */
export function postJournalEntry(
  ledger: Ledger,
  id: string,
  date: string,
  memo: string,
  lines: JournalLine[],
): Ledger {
  const entry = journalEntry(id, date, memo, lines);
  entry.lines.forEach(accountFor);
  return { entries: [...ledger.entries, entry] };
}

/** The ledger's trial balance: every account's balance after the posted entries. */
export function ledgerBalance(ledger: Ledger): Map<string, number> {
  return trialBalance(ledger.entries);
}
`,
  "src/journal/reverse.ts": `import type { JournalEntry } from "./entry";
import { postJournalEntry, type Ledger } from "./post";

/** Post the reversing entry of an earlier journal entry: each debit becomes a credit. */
export function reverseJournalEntry(ledger: Ledger, entry: JournalEntry, date: string): Ledger {
  const lines = entry.lines.map((line) => ({
    account: line.account,
    debit: line.credit,
    credit: line.debit,
  }));
  return postJournalEntry(ledger, \`\${entry.id}-reversal\`, date, \`Reversal of \${entry.id}\`, lines);
}
`,
  "src/accounts/chart.ts": `import type { JournalLine } from "../journal/entry";

/** The kinds of account in the chart of accounts. */
export type AccountKind = "asset" | "liability" | "equity" | "income" | "expense";

/** The chart of accounts: every account code a journal line may post to. */
export const chartOfAccounts: Record<string, { name: string; kind: AccountKind }> = {
  "1000": { name: "Cash", kind: "asset" },
  "1200": { name: "Receivables", kind: "asset" },
  "2000": { name: "Payables", kind: "liability" },
  "4000": { name: "Sales", kind: "income" },
  "5000": { name: "Fees", kind: "expense" },
};

/** The account a journal line posts to; an unknown account code is an error. */
export function accountFor(line: JournalLine) {
  const account = chartOfAccounts[line.account];
  if (!account) throw new Error(\`Unknown account \${line.account}\`);
  return account;
}
`,
  "src/accounts/balance.ts": `import type { JournalEntry } from "../journal/entry";
import { accountFor, chartOfAccounts } from "./chart";

/** Each account's balance, debits minus credits, over the posted journal entries. */
export function trialBalance(entries: JournalEntry[]): Map<string, number> {
  const balances = new Map(Object.keys(chartOfAccounts).map((code) => [code, 0]));
  for (const entry of entries)
    for (const line of entry.lines) {
      accountFor(line);
      balances.set(line.account, (balances.get(line.account) ?? 0) + line.debit - line.credit);
    }
  return balances;
}
`,
  "src/format/round.ts": `/** Round to a number of decimal places, half to even (banker's rounding). */
export function roundHalfEven(value: number, places = 2): number {
  const scale = 10 ** places;
  const scaled = value * scale;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return (floor % 2 === 0 ? floor : floor + 1) / scale;
  return Math.round(scaled) / scale;
}
`,
  "src/format/money.ts": `import { roundHalfEven } from "./round";

/** Minor-unit digits of each ISO 4217 currency code. */
export const currencyDigits: Record<string, number> = { USD: 2, EUR: 2, JPY: 0, KWD: 3 };

/** Format an amount of money in a currency, rounded to its minor units. */
export function formatMoney(amount: number, currency: string): string {
  const digits = currencyDigits[currency] ?? 2;
  return \`\${roundHalfEven(amount, digits).toFixed(digits)} \${currency}\`;
}
`,
  "src/rates/table.ts": `import { roundHalfEven } from "../format/round";

/** Exchange rates against one US dollar, by currency code. */
export const exchangeRates: Record<string, number> = { USD: 1, EUR: 0.92, JPY: 149.5, KWD: 0.31 };

/** The exchange rate from one currency to another, to six decimal places. */
export function rateFor(from: string, to: string): number {
  const source = exchangeRates[from];
  const target = exchangeRates[to];
  if (!source || !target) throw new Error(\`No exchange rate for \${from} to \${to}\`);
  return roundHalfEven(target / source, 6);
}
`,
  "src/rates/convert.ts": `import { rateFor } from "./table";
import { currencyDigits } from "../format/money";
import { roundHalfEven } from "../format/round";

/** Convert an amount between currencies at the table's exchange rate, rounded to the target's minor units. */
export function convertAmount(amount: number, from: string, to: string): number {
  return roundHalfEven(amount * rateFor(from, to), currencyDigits[to] ?? 2);
}
`,
};

const SHOP: Record<string, string> = {
  "package.json": `${JSON.stringify({ name: "lumen-shop", version: "1.0.0", type: "module", dependencies: { [PACKAGE]: "^1.0.0" } }, null, 2)}\n`,
  "README.md":
    "# Lumen Shop\n\nA checkout that takes payment for a cart, records each sale in the Lumen Ledger as a journal entry, and prints the customer's receipt.\n",
  "src/checkout/cart.ts": `/** A line in a shopping cart: a product, its unit price in cents and a quantity. */
export interface CartLine {
  sku: string;
  unitPrice: number;
  quantity: number;
}

/** A customer's shopping cart. */
export interface Cart {
  id: string;
  lines: CartLine[];
}

/** The cart's total in cents. */
export function cartTotal(cart: Cart): number {
  return cart.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
}
`,
  "src/checkout/pay.ts": `import { postJournalEntry, type Ledger } from "${PACKAGE}";
import { cartTotal, type Cart } from "./cart";
import { receiptFor, type Receipt } from "../receipts/receipt";

/** Take payment for a cart: post the sale to the ledger as a journal entry (debit cash, credit sales) and issue its receipt. */
export function payForCart(ledger: Ledger, cart: Cart, date: string): { ledger: Ledger; receipt: Receipt } {
  const total = cartTotal(cart) / 100;
  const id = \`sale-\${cart.id}\`;
  const posted = postJournalEntry(ledger, id, date, \`Sale of cart \${cart.id}\`, [
    { account: "1000", debit: total, credit: 0 },
    { account: "4000", debit: 0, credit: total },
  ]);
  return { ledger: posted, receipt: receiptFor(cart, { id }, date) };
}
`,
  "src/receipts/receipt.ts": `import type { JournalEntry } from "${PACKAGE}";
import { cartTotal, type Cart } from "../checkout/cart";

/** A customer's receipt for a paid cart, citing the journal entry that recorded the sale. */
export interface Receipt {
  cartId: string;
  total: number;
  journalEntryId: string;
  date: string;
}

/** The receipt for a cart paid by the given journal entry. */
export function receiptFor(cart: Cart, entry: Pick<JournalEntry, "id">, date: string): Receipt {
  return { cartId: cart.id, total: cartTotal(cart), journalEntryId: entry.id, date };
}
`,
  "src/receipts/print.ts": `import type { Receipt } from "./receipt";
import type { Cart } from "../checkout/cart";

/** Print a receipt: one line per cart line, then the total and the journal entry it was posted as. */
export function printReceipt(receipt: Receipt, cart: Cart): string {
  const lines = cart.lines.map((line) => \`\${line.sku} x\${line.quantity}  \${(line.unitPrice * line.quantity) / 100}\`);
  return [...lines, \`Total \${receipt.total / 100}\`, \`Journal entry \${receipt.journalEntryId}\`].join("\\n");
}
`,
};

type Mode = "enabled" | "disabled" | "refused" | "exhausted";

interface FixtureRepo {
  mode: Mode | "consumer";
  owner: Persona;
  name: string;
  id: string;
  head: string;
  dir: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const short = (commit: string) => commit.slice(0, 7);

export async function runAtlasProviderE2E(
  ctx: HarnessContext,
  fixtures: SeedManifest,
  evidence: Record<string, unknown>,
  /** Resolves when the Copper Finch search and assistant turns are done: they share the model rate limits. */
  after: Promise<void> = Promise.resolve(),
): Promise<void> {
  const timings: { stage: string; elapsedMs: number; outcome: string }[] = [];
  evidence.timings = timings;
  await after;
  evidence.config = ATLAS_PROVIDER_CONFIG;
  const root = await mkdtemp(join(ctx.work, "atlas-providers-"));
  const env: NodeJS.ProcessEnv = {
    ...ctx.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_DATE: "2026-02-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-02-01T00:00:00Z",
  };
  for (const key of Object.keys(env))
    if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key)) delete env[key];
  let stage = "setup";
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    stage = name;
    const started = Date.now();
    try {
      const result = await work();
      timings.push({ stage: name, elapsedMs: Date.now() - started, outcome: "passed" });
      return result;
    } catch (error) {
      timings.push({ stage: name, elapsedMs: Date.now() - started, outcome: "failed" });
      evidence.failedStage = name;
      evidence.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  const git = (dir: string, args: string[], token?: string) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: dir,
          timeout: 90_000,
          maxBuffer: 2 * 1024 * 1024,
          env: token
            ? {
                ...env,
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: `http.${ctx.origin}/.extraHeader`,
                GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
              }
            : env,
        },
        (error, stdout) => {
          // execFile errors embed arguments and stderr; never persist those.
          if (error)
            reject(new Error(`git ${args[0]} failed (${String(error.code ?? "unknown")})`));
          else resolve(stdout.trim());
        },
      );
    });
  const request = async (
    path: string,
    token: string,
    init: { method?: string; body?: string; expected?: number[] } = {},
  ) => {
    const response = await fetch(`${ctx.origin}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(120_000),
    });
    const expected = init.expected ?? [200];
    assert(
      expected.includes(response.status),
      `${stage}: ${init.method ?? "GET"} ${path} HTTP ${response.status}`,
    );
    return response.json() as Promise<unknown>;
  };
  const api = <T>(path: string, token: string = fixtures.tokens.priya) =>
    request(`/api${path}`, token) as Promise<T>;
  /** One read-only query of the environment's local D1 (as `agent inspect` does). */
  const sql = async (query: string): Promise<Record<string, unknown>[]> => {
    // The server writes the same SQLite file: a read can find it locked for a moment.
    let out = "";
    for (let attempt = 0; ; attempt++) {
      try {
        out = await read(query);
        break;
      } catch (error) {
        if (attempt >= 20 || !/SQLITE_BUSY|database is locked/.test(String(error))) throw error;
        await delay(1_000 + Math.random() * 2_000);
      }
    }
    const [first] = JSON.parse(out) as { results: { columns: string[]; rows: unknown[][] } }[];
    assert(first, "D1 returned no result");
    return first.results.rows.map((row) =>
      Object.fromEntries(first.results.columns.map((c, i) => [c, row[i]])),
    );
  };
  const read = (query: string) =>
    command(
      "cf",
      [
        "d1",
        "raw",
        "00000000000000000000000000000000",
        "--local",
        "--persist-to",
        join(ctx.dir, "state"),
        "--sql",
        query,
      ],
      { cwd: join(ctx.root, "apps", "website") },
    );

  const repos = new Map<Mode | "consumer", FixtureRepo>();
  const createRepo = async (mode: Mode | "consumer", owner: Persona, prefix: string) => {
    const name = `${prefix}-${randomBytes(4).toString("hex")}`;
    const token = fixtures.tokens[owner];
    await request("/api/repos", token, {
      method: "POST",
      body: JSON.stringify({ owner, name, visibility: "private", description: "Atlas fixture" }),
      expected: [201],
    });
    const { id } = (await api<{ id: string }>(`/repos/${owner}/${name}`, token)) as { id: string };
    const dir = join(root, `${owner}-${name}`);
    await mkdir(dir);
    const repo: FixtureRepo = { mode, owner, name, id, head: "", dir };
    repos.set(mode, repo);
    return repo;
  };
  const pushFiles = async (repo: FixtureRepo, files: Record<string, string>, message: string) => {
    if (!repo.head) {
      await git(repo.dir, ["init", "--initial-branch=main"]);
      await git(repo.dir, ["config", "user.name", "Agent Fixture"]);
      await git(repo.dir, ["config", "user.email", "agent-fixture@example.invalid"]);
      await git(repo.dir, [
        "remote",
        "add",
        "origin",
        `${ctx.origin}/${repo.owner}/${repo.name}.git`,
      ]);
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo.dir, path)), { recursive: true });
      await writeFile(join(repo.dir, path), text);
    }
    await git(repo.dir, ["add", "-A"]);
    await git(repo.dir, ["-c", "core.hooksPath=/dev/null", "commit", "-m", message]);
    await git(repo.dir, ["push", "origin", "main"], fixtures.tokens[repo.owner]);
    repo.head = await git(repo.dir, ["rev-parse", "HEAD"]);
  };
  /** The build of exactly `repo.head`, once the repository is up to date with it. */
  const built = async (repo: FixtureRepo): Promise<KnowledgeBuild> => {
    const token = fixtures.tokens[repo.owner];
    const deadline = Date.now() + 15 * 60_000;
    let observed: KnowledgeStatus | undefined;
    while (Date.now() < deadline) {
      observed = await api<KnowledgeStatus>(
        `/repos/${repo.owner}/${repo.name}/knowledge/status`,
        token,
      );
      if (observed.state === "failed")
        throw new Error(
          `${repo.owner}/${repo.name}: Knowledge build failed (${observed.current?.error ?? observed.recent[0]?.error ?? "no error recorded"})`,
        );
      const build = observed.recent.find(
        (b) => b.toCommit === repo.head && b.status === "succeeded",
      );
      if (observed.state === "up-to-date" && observed.indexedCommit === repo.head && build)
        return build;
      await delay(5_000);
    }
    throw new Error(
      `${repo.owner}/${repo.name}: no successful build of ${short(repo.head)} (state ${observed?.state}, phase ${observed?.current?.phase})`,
    );
  };
  const atlasOf = (repo: FixtureRepo) => `/repos/${repo.owner}/${repo.name}/atlas`;
  const tokenOf = (repo: FixtureRepo) => fixtures.tokens[repo.owner];
  /** Each fixture file's primary capability in the repository's current snapshot. */
  const capabilityOfFiles = async (repo: FixtureRepo, paths: string[]) => {
    const out = new Map<string, string | null>();
    for (const path of paths) {
      const detail = await api<AtlasDetail>(
        `${atlasOf(repo)}/detail?id=${encodeURIComponent(`file:${path}`)}`,
        tokenOf(repo),
      );
      assert.equal(detail.snapshot.vector[0]?.commit, repo.head, `${path} read at another commit`);
      const membership = detail.entity.data.membership as
        | { capability?: string | null }
        | undefined;
      out.set(path, membership?.capability ?? null);
    }
    return out;
  };
  /** The one capability every listed file is a primary member of. */
  const sharedCapability = async (repo: FixtureRepo, paths: string[]) => {
    const placed = await capabilityOfFiles(repo, paths);
    const ids = new Set(placed.values());
    assert.equal(
      ids.size,
      1,
      `${repo.name}: ${paths.join(", ")} should share one capability: ${JSON.stringify(Object.fromEntries(placed))}`,
    );
    const id = [...ids][0];
    assert(id, `${repo.name}: ${paths[0]} is unclassified`);
    const folders = new Set(paths.map((p) => p.split("/").slice(0, -1).join("/")));
    assert(folders.size >= 2, "The fixture capability must span folders");
    const detail = await api<AtlasDetail>(
      `${atlasOf(repo)}/detail?id=${encodeURIComponent(id)}`,
      tokenOf(repo),
    );
    assert.equal(detail.entity.kind, "capability");
    return detail;
  };
  const evidenceOf = async (repo: FixtureRepo, id: string) =>
    api<AtlasPage<AtlasEvidence>>(
      `${atlasOf(repo)}/evidence?id=${encodeURIComponent(id)}&limit=20`,
      tokenOf(repo),
    );
  const spendRows = (repoIds: string[]) =>
    sql(
      `SELECT repo_id, run_id, purpose, model, status, input_tokens, output_tokens, cost_micro_usd FROM atlas_spend WHERE repo_id IN (${repoIds.map((id) => `'${id.replace(/'/g, "")}'`).join(",")}) ORDER BY created_at`,
    );

  let browser: Browser | undefined;
  const browse = async <T>(persona: Persona, label: string, work: (page: Page) => Promise<T>) => {
    browser ??= await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: ctx.origin,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const seen: string[] = [];
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (url.pathname.startsWith("/api/")) seen.push(url.pathname);
    });
    try {
      await page.goto("/signin");
      await page.getByRole("button", { name: new RegExp(`Continue as ${persona}`, "i") }).click();
      await page.waitForURL((url) => url.pathname !== "/signin");
      const result = await work(page);
      // Browsing reads bounded Atlas pages: never the whole graph, never a search.
      const unbounded = seen.filter(
        (p) =>
          p.endsWith("/knowledge/graph/export") ||
          p.includes("/knowledge/search") ||
          p === "/api/search",
      );
      assert.deepEqual(unbounded, [], `${label}: browsing fetched ${unbounded.join(", ")}`);
      return result;
    } catch (error) {
      await page
        .screenshot({ path: join(ctx.artifacts, `atlas-${label}-failure.png`) })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  };
  const expect = playwrightExpect.configure({ timeout: 60_000 });
  const heading = (scope: Page | Locator, text: string) =>
    scope.getByRole("heading", { name: text, exact: true, level: 2 });
  /**
   * From a selected capability, open what's inside until a file, then its
   * source at `commit`; returns the clicked path and the blob URL.
   */
  const drillToSource = async (
    page: Page,
    scope: Locator,
    capability: string,
    repo: FixtureRepo,
  ) => {
    const path = [capability];
    const labelOf = async (button: Locator) =>
      ((await button.locator("span").first().textContent()) ?? "").trim();
    let parent = capability;
    let selectedFile = false;
    for (let depth = 0; depth < 4; depth++) {
      const buttons = scope.getByRole("list", { name: `Inside ${parent}` }).getByRole("button");
      await expect(buttons.first()).toBeVisible();
      const labels = await Promise.all((await buttons.all()).map(labelOf));
      // A source file if one is listed here, else the first area to open.
      let index = labels.findIndex((l) => l.endsWith(".ts"));
      if (index < 0) index = labels.findIndex((l) => !/\.[a-z]+$/i.test(l));
      assert(index >= 0, `Nothing to open inside ${parent}: ${labels.join(", ")}`);
      const label = labels[index]!;
      path.push(label);
      // AI-generated parent and child names can match. Wait for the old
      // inspector to leave before accepting the next heading with that name.
      const previousHeading = await heading(scope, parent).elementHandle();
      assert(previousHeading);
      await buttons.nth(index).click();
      await previousHeading.waitForElementState("hidden");
      await previousHeading.dispose();
      await expect(heading(scope, label)).toBeVisible();
      const selected = new URL(page.url()).searchParams.get("select") ?? "";
      selectedFile = selected.startsWith("file:") || selected.startsWith(`${repo.id}/file:`);
      if (selectedFile) break;
      parent = label;
    }
    const file = path.at(-1)!;
    assert(selectedFile, `Drilling ${capability} reached no file: ${path.join(" › ")}`);
    const link = scope
      .locator(`a[href^="/${repo.owner}/${repo.name}/blob/${repo.head}/"]`)
      .filter({ hasText: new RegExp(`(?:^|/)${escape(file)}(?::\\d+)?$`) })
      .first();
    await expect(link).toBeVisible();
    const href = (await link.getAttribute("href")) ?? "";
    const target = new URL(href, page.url());
    assert.equal(target.searchParams.get("source"), "canonical");
    assert(target.pathname.endsWith(`/${file}`));
    await link.click();
    await page.waitForURL((url) => url.href === target.href);
    const symbol = SYMBOL[file];
    if (symbol) await expect(page.getByText(symbol).first()).toBeVisible();
    return { path, source: href };
  };

  try {
    // ---- 1. Repositories, the published package, and the pushes ---------------------
    await step("atlas-setup", async () => {
      const ledger = await createRepo("enabled", "priya", "lumen-ledger");
      const shop = await createRepo("consumer", "priya", "lumen-shop");
      // The registry names the ledger the source of `lumen-ledger` before its
      // first build, which freezes what it publishes into the snapshot.
      const tarball = join(root, "package");
      await mkdir(join(tarball, "package"), { recursive: true });
      await writeFile(join(tarball, "package", "package.json"), LEDGER["package.json"]!);
      await writeFile(join(tarball, "package", "index.js"), "export {};\n");
      await command("tar", ["-czf", join(root, "package.tgz"), "-C", tarball, "package"]);
      const tgz = await readFile(join(root, "package.tgz"));
      const version = "1.0.0";
      await request(`/npm/priya/${PACKAGE}`, fixtures.tokens.priya, {
        method: "PUT",
        expected: [200, 201],
        body: JSON.stringify({
          _id: PACKAGE,
          name: PACKAGE,
          description: "Double-entry bookkeeping",
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              name: PACKAGE,
              version,
              description: "Double-entry bookkeeping",
              dist: {
                integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}`,
                shasum: createHash("sha1").update(tgz).digest("hex"),
                tarball: `${ctx.origin}/npm/priya/${PACKAGE}/-/${PACKAGE}-${version}.tgz`,
              },
            },
          },
          _attachments: {
            [`${PACKAGE}-${version}.tgz`]: {
              content_type: "application/octet-stream",
              data: tgz.toString("base64"),
              length: tgz.length,
            },
          },
        }),
      });
      const granted = (await request(
        `/api/packages/priya/npm/${encodeURIComponent(PACKAGE)}/sources`,
        fixtures.tokens.priya,
        { method: "POST", body: JSON.stringify({ repo: `priya/${ledger.name}` }) },
      )) as { sources: unknown[] };
      evidence.packageSources = granted.sources;
      await createRepo("disabled", "marco", "atlas-disabled");
      await createRepo("refused", "jun", "atlas-refused");
      await createRepo("exhausted", "sam", "atlas-exhausted");
      await Promise.all([
        pushFiles(ledger, LEDGER, "Lumen Ledger: journal, accounts, rates and money"),
        pushFiles(shop, SHOP, "Lumen Shop: checkout and receipts on the ledger"),
      ]);
    });

    // ---- 2. The real provider, enabled ------------------------------------------------
    const ledger = repos.get("enabled")!;
    const shop = repos.get("consumer")!;
    const enabled = await step("atlas-enabled-build", async () => {
      const build = await built(ledger);
      const stats = build.stats as {
        atlasSnapshot?: string;
        atlasSeq?: number;
        atlasError?: string;
        atlasTimings?: Record<string, unknown> & { modelCalls: number; projectMs: number };
        atlasDescribed?: {
          current: number;
          inferred: number;
          cached: number;
          unavailable: number;
          model?: string;
          settings?: string;
          capabilities: number;
        };
        atlasSpend?: {
          calls: number;
          inputTokens: number;
          outputTokens: number;
          usd: number;
          exhausted: unknown;
        };
        atlasCapabilities?: number;
      };
      evidence.enabledBuild = {
        id: build.id,
        commit: build.toCommit,
        atlasSnapshot: stats.atlasSnapshot,
        atlasSeq: stats.atlasSeq,
        atlasTimings: stats.atlasTimings,
        atlasDescribed: stats.atlasDescribed,
        atlasSpend: stats.atlasSpend,
        atlasError: stats.atlasError ?? null,
      };
      assert.equal(stats.atlasError, undefined, `Atlas projection failed: ${stats.atlasError}`);
      assert(stats.atlasSnapshot && stats.atlasDescribed && stats.atlasSpend && stats.atlasTimings);
      const described = stats.atlasDescribed;
      assert.equal(described.settings, "default", "priya runs with the built-in Atlas settings");
      assert.match(
        described.model ?? "",
        /^@cf\//,
        "The build must record the model it described with",
      );
      assert(described.capabilities >= 2, "The ledger has two capabilities to describe");
      assert.equal(described.current, described.capabilities, "Every capability has current prose");
      assert.equal(
        described.inferred,
        described.capabilities,
        "A new repository's prose is inferred, not cached",
      );
      // Each inference is one reserved, settled call: nothing retried, nothing free.
      assert.equal(stats.atlasSpend.calls, described.inferred);
      assert.equal(stats.atlasTimings.modelCalls, described.inferred);
      assert(stats.atlasSpend.inputTokens > 0 && stats.atlasSpend.outputTokens > 0);
      assert(stats.atlasSpend.usd > 0, "Real calls are priced");
      // (Stats keep no nulls: an absent cap is no exhaustion.)
      assert.equal(stats.atlasSpend.exhausted ?? null, null);

      const overview = await api<AtlasOverview>(`${atlasOf(ledger)}/overview`);
      assert.equal(overview.snapshot.id, stats.atlasSnapshot, "The build's snapshot is published");
      assert.deepEqual(overview.snapshot.vector, [
        { repoId: ledger.id, sourceId: "canonical", commit: ledger.head, buildId: build.id },
      ]);
      const model = described.model!;
      const capabilities: Record<string, unknown>[] = [];
      const read = async (paths: string[], domain: RegExp) => {
        const detail = await sharedCapability(ledger, paths);
        const entity = detail.entity;
        const description = entity.data.description as AtlasDescription;
        const provenance = entity.data.provenance as AtlasProvenance;
        const inferred = provenance.inferred;
        assert.deepEqual(entity.summaryState, { status: "current" });
        assert.equal(description.status, "current");
        assert.equal(entity.data.nameSource, "model", "A current capability is named by the model");
        assert(inferred, "Current prose carries its inference provenance");
        assert.equal(inferred.model, model);
        assert.deepEqual(inferred.basis, {
          repoId: ledger.id,
          sourceId: "canonical",
          commit: ledger.head,
          buildId: build.id,
        });
        assert(entity.name && entity.name === description.name);
        assert.match(
          `${entity.name} ${entity.summary}`,
          domain,
          `${entity.name}: ${entity.summary}`,
        );
        assert(inferred.sources.length > 0, "Prose rests on source files");
        const citationMembers = await capabilityOfFiles(
          ledger,
          inferred.sources.map((source) => source.path),
        );
        for (const source of inferred.sources) {
          assert.equal(source.commit, ledger.head, "Citations are at the snapshot's commit");
          assert.equal(source.repoId, ledger.id);
          assert.equal(source.sourceId, "canonical", "Canonical prose cannot cite timeline work");
          assert.equal(
            citationMembers.get(source.path),
            entity.id,
            `${source.path} isn't a primary member`,
          );
          assert.match(source.blob ?? "", /^[0-9a-f]{40}$/, "Citations name the immutable blob");
        }
        // Transitively, the prose was derived from the member files' own analysis cards.
        const cards = inferred.derivedFrom.filter((d) => d.kind === "file-card");
        assert(cards.length >= 2, "Prose derives from member file cards");
        const sources = await evidenceOf(ledger, entity.id);
        const cited = sources.items.filter((e) => paths.includes(e.path));
        const folders = new Set(cited.map((e) => e.path.split("/").slice(0, -1).join("/")));
        assert(folders.size >= 2, "Its sources span both folders");
        for (const e of sources.items) {
          assert.equal(e.commit, ledger.head);
          assert.equal(e.sourceId, "canonical", "Atlas evidence must identify its code source");
          assert.equal(e.analysis, "analyzed");
        }
        capabilities.push({
          id: entity.id,
          name: entity.name,
          summary: entity.summary,
          rationale: description.rationale,
          interimName: entity.data.interimName,
          members: paths,
          inferred: {
            model: inferred.model,
            basis: inferred.basis,
            inputsHash: inferred.inputsHash,
            inferredAt: inferred.inferredAt,
            sources: inferred.sources.map((s) => ({
              path: s.path,
              sourceId: s.sourceId,
              commit: s.commit,
              blob: s.blob,
              range: s.range,
            })),
            derivedFrom: inferred.derivedFrom.map((d) => d.kind),
          },
          citations: sources.items.map((e) => ({
            path: e.path,
            commit: e.commit,
            blob: e.blob,
            range: e.range,
            via: e.via,
          })),
        });
        return entity;
      };
      const ledgerCap = await read(LEDGER_CAPABILITY, /ledger|journal|account|balance|bookkeep/i);
      const currencyCap = await read(
        CURRENCY_CAPABILITY,
        /currenc|exchange|rate|money|convert|round/i,
      );
      assert.notEqual(ledgerCap.id, currencyCap.id, "Two capabilities, not one per repository");
      evidence.enabled = {
        snapshot: overview.snapshot,
        regions: overview.regions.map((r) => ({
          id: r.id,
          kind: r.kind,
          name: r.name,
          files: r.size.files,
          summaryState: r.summaryState ?? null,
        })),
        capabilities,
      };
      return { build, ledgerCap, currencyCap, model };
    });

    // The degraded accounts push the same source now: its file analyses are
    // reused, so they add no analysis load, and only their Atlas step differs.
    await step("atlas-degraded-push", async () => {
      await Promise.all(
        (["disabled", "refused", "exhausted"] as const).map((mode) =>
          pushFiles(repos.get(mode)!, LEDGER, "Lumen Ledger source"),
        ),
      );
      evidence.repos = Object.fromEntries(
        [...repos].map(([mode, r]) => [
          mode,
          { repo: `${r.owner}/${r.name}`, id: r.id, head: r.head },
        ]),
      );
    });

    // The Knowledge tab: capability → area/file → source at the snapshot's commit,
    // and browsing it makes no model call and starts no build.
    await step("atlas-enabled-ui", async () => {
      const before = await spendRows([ledger.id]);
      const buildsBefore = await sql(
        `SELECT COUNT(*) AS n FROM kg_builds WHERE repo_id = '${ledger.id}'`,
      );
      const drilled = await browse("priya", "enabled", async (page) => {
        await page.goto(`/priya/${ledger.name}/knowledge?view=outline`);
        const tree = page.getByRole("tree", { name: `Outline of priya/${ledger.name}` });
        const cap = enabled.ledgerCap;
        await tree
          .getByRole("treeitem", { name: new RegExp(`^${escape(cap.name)}\\s*Capability`) })
          .first()
          .click();
        await page.waitForURL((url) => url.searchParams.get("select") === cap.id);
        const selection = page.getByRole("complementary", { name: "Selection" });
        await expect(heading(selection, cap.name)).toBeVisible();
        await expect(selection.getByText(cap.summary.slice(0, 80))).toBeVisible();
        await expect(
          selection.getByText(`Summary written by ${enabled.model} from ${short(ledger.head)}`),
        ).toBeVisible();
        const result = await drillToSource(page, selection, cap.name, ledger);
        await page.screenshot({ path: join(ctx.artifacts, "atlas-enabled-source.png") });
        return result;
      });
      const after = await spendRows([ledger.id]);
      const buildsAfter = await sql(
        `SELECT COUNT(*) AS n FROM kg_builds WHERE repo_id = '${ledger.id}'`,
      );
      assert.deepEqual(after, before, "Browsing the Atlas made a model call");
      assert.deepEqual(buildsAfter, buildsBefore, "Browsing the Atlas started a build");
      evidence.enabledUi = { ...drilled, atlasCallsWhileBrowsing: after.length - before.length };
    });

    // ---- 3. The workspace: both repositories, a resolved dependency ---------------------
    await step("atlas-workspace", async () => {
      const shopBuild = await built(shop);
      const shopCap = await sharedCapability(shop, SHOP_CAPABILITY);
      assert.deepEqual(shopCap.entity.summaryState, { status: "current" });
      const names = `${ledger.name},${shop.name}`;
      const ws = `/accounts/priya/atlas`;
      const scoped = (id: string) => `${shop.id}/${id}`;
      const links = await api<AtlasPage<AtlasCrossLink>>(
        `${ws}/links?repos=${names}&id=${encodeURIComponent(scoped(shopCap.entity.id))}&state=resolved`,
      );
      const resolved = links.items.find((l) => l.package?.name === PACKAGE);
      assert(resolved?.evidence, "The shop's capability must resolve its lumen-ledger dependency");
      assert.equal(resolved.state, "resolved");
      assert.equal(
        resolved.evidence.publisher.repoId,
        ledger.id,
        "Resolved to the ledger repository",
      );
      assert.equal(resolved.evidence.publisher.registry.name, PACKAGE);
      for (const f of resolved.evidence.importers.files) {
        assert.equal(f.repoId, shop.id);
        assert.equal(f.commit, shop.head, "Importers are cited at the shop's own commit");
        assert.equal(
          f.sourceId,
          "canonical",
          "Registry resolution cannot import work-source evidence",
        );
        assert(SHOP_CAPABILITY.includes(f.path), f.path);
      }
      const composition = await api<AtlasWorkspaceComposition>(`${ws}/composition?repos=${names}`);
      const composite = composition.items.find(
        (c) => c.repos.includes(ledger.id) && c.repos.includes(shop.id),
      );
      const repoVectors = composition.snapshot.repos.map((r) => ({
        repo: `${r.owner}/${r.name}`,
        state: r.state,
        vector: r.snapshot?.vector ?? null,
      }));
      assert.deepEqual(
        repoVectors.map((r) => r.vector?.[0]?.commit ?? "").sort((a, b) => a.localeCompare(b)),
        [ledger.head, shop.head].sort((a, b) => a.localeCompare(b)),
        "Each repository at its own commit: no common head",
      );
      for (const repo of composition.snapshot.repos) {
        for (const vector of repo.snapshot?.vector ?? []) {
          assert.equal(
            vector.sourceId,
            "canonical",
            "Workspace Atlas must isolate canonical snapshots",
          );
        }
      }
      evidence.workspace = {
        repos: repoVectors,
        shopBuild: {
          id: shopBuild.id,
          atlasDescribed: shopBuild.stats.atlasDescribed,
          atlasSpend: shopBuild.stats.atlasSpend,
        },
        shopCapability: {
          id: shopCap.entity.id,
          name: shopCap.entity.name,
          summary: shopCap.entity.summary,
        },
        resolved: {
          package: resolved.package,
          publisher: resolved.evidence.publisher,
          importers: resolved.evidence.importers,
          manifest: resolved.evidence.manifest,
        },
        // Composites need a canonical concept both sides share (model-derived), so it's recorded, not required.
        composite: composite
          ? {
              id: composite.id,
              name: composite.name,
              members: composite.members.map((m) => m.name),
              concepts: composite.concepts,
              counts: composite.counts,
            }
          : null,
      };
      const citations = await browse("priya", "workspace", async (page) => {
        const base = `/priya/-/atlas?repos=${names}`;
        const out: Record<string, unknown> = {};
        await page.goto(`${base}&select=${encodeURIComponent(scoped(shopCap.entity.id))}`);
        const coverage = page.getByRole("region", { name: "Coverage" });
        await expect(coverage.getByText(short(ledger.head), { exact: true })).toBeVisible();
        await expect(coverage.getByText(short(shop.head), { exact: true })).toBeVisible();
        await expect(heading(page, shopCap.entity.name)).toBeVisible();
        const across = page.getByRole("region", { name: "Across repositories" });
        await expect(
          across
            .getByText(
              new RegExp(`Depends on ${escape(ledger.name)} through npm:${escape(PACKAGE)}`),
            )
            .first(),
        ).toBeVisible();
        out.shop = await drillToSource(page, page.locator("body"), shopCap.entity.name, shop);
        await page.goto(
          `${base}&select=${encodeURIComponent(`${ledger.id}/${enabled.ledgerCap.id}`)}`,
        );
        await expect(heading(page, enabled.ledgerCap.name)).toBeVisible();
        out.ledger = await drillToSource(
          page,
          page.locator("body"),
          enabled.ledgerCap.name,
          ledger,
        );
        return out;
      });
      (evidence.workspace as Record<string, unknown>).ui = citations;
    });

    // ---- 4. Unchanged inputs are never inferred again (gate 15) -------------------------
    await step("atlas-reuse", async () => {
      const previous = enabled.build;
      await pushFiles(
        ledger,
        { "README.md": `${LEDGER["README.md"]}\nSee index.ts for the public API.\n` },
        "Point the README at the public API",
      );
      const build = await built(ledger);
      const stats = build.stats as {
        atlasError?: string;
        atlasTimings?: { mode: string; projectMs: number; describeMs: number; modelCalls: number };
        atlasDescribed?: {
          capabilities: number;
          cached: number;
          inferred: number;
          current: number;
        };
        atlasSpend?: { calls: number };
      };
      assert.equal(stats.atlasError, undefined);
      assert(stats.atlasTimings && stats.atlasDescribed && stats.atlasSpend);
      const now: {
        id: string;
        name: string;
        sameInputs: boolean;
        reinferred: boolean;
        basis: AtlasInference["basis"];
      }[] = [];
      for (const cap of [enabled.ledgerCap, enabled.currencyCap]) {
        const detail = await api<AtlasDetail>(
          `${atlasOf(ledger)}/detail?id=${encodeURIComponent(cap.id)}`,
        );
        assert.equal(detail.snapshot.vector[0]?.commit, ledger.head);
        const before = (cap.data.provenance as AtlasProvenance).inferred!;
        const after = (detail.entity.data.provenance as AtlasProvenance).inferred!;
        assert.deepEqual(detail.entity.summaryState, { status: "current" });
        now.push({
          id: cap.id,
          name: detail.entity.name,
          sameInputs: before.inputsHash === after.inputsHash,
          reinferred: before.inferredAt !== after.inferredAt,
          basis: after.basis,
        });
      }
      const changed = now.filter((c) => !c.sameInputs).length;
      evidence.reuse = {
        build: build.id,
        previousBuild: previous.id,
        commit: ledger.head,
        atlasTimings: stats.atlasTimings,
        atlasDescribed: stats.atlasDescribed,
        atlasSpend: stats.atlasSpend,
        capabilities: now,
      };
      // Identity holds across the push, and identical inputs reuse their prose.
      for (const c of now) if (c.sameInputs) assert(!c.reinferred, `${c.name} was inferred again`);
      assert(
        now.some((c) => c.sameInputs),
        "A README edit changed every capability's inputs",
      );
      assert.equal(stats.atlasSpend.calls, stats.atlasDescribed.inferred);
      assert(stats.atlasDescribed.inferred <= changed, "Only changed inputs may be inferred");
      assert.equal(stats.atlasTimings.mode, "incremental");
      // Gate 19: publication within 30 s of the graph, the model's share reported apart.
      assert(
        stats.atlasTimings.projectMs - stats.atlasTimings.describeMs <= 30_000,
        `Projection took ${stats.atlasTimings.projectMs} ms (${stats.atlasTimings.describeMs} ms model)`,
      );
    });

    // ---- 5. The degraded providers: disabled, refused, exhausted -------------------------
    const degraded: {
      mode: Mode;
      reason: "disabled" | "provider_error" | "budget_exhausted";
      notice: RegExp;
      note: string;
    }[] = [
      {
        mode: "disabled",
        reason: "disabled",
        notice: /Summaries are off \(no priced model is configured\)/,
        note: "summaries are off",
      },
      {
        mode: "refused",
        reason: "provider_error",
        notice: /Some summaries couldn't be written this build and aren't retried automatically/,
        note: "the model call failed",
      },
      {
        mode: "exhausted",
        reason: "budget_exhausted",
        notice: /Some summaries are paused: the Atlas AI budget is used up/,
        note: "the Atlas AI budget was used up",
      },
    ];
    const degradedEvidence: Record<string, unknown> = {};
    evidence.degraded = degradedEvidence;
    for (const expected of degraded) {
      const repo = repos.get(expected.mode)!;
      await step(`atlas-${expected.mode}`, async () => {
        const build = await built(repo);
        const stats = build.stats as {
          atlasError?: string;
          atlasSnapshot?: string;
          atlasTimings?: Record<string, unknown>;
          atlasDescribed?: {
            capabilities: number;
            current: number;
            inferred: number;
            unavailable: number;
            stale: number;
            reasons: Record<string, number>;
            model?: string;
            settings?: string;
          };
          atlasSpend?: {
            calls: number;
            inputTokens: number;
            outputTokens: number;
            usd: number;
            exhausted: { cap: string; resetsAt: string | null } | null;
          };
        };
        const record: Record<string, unknown> = {
          repo: `${repo.owner}/${repo.name}`,
          build: build.id,
          commit: repo.head,
          atlasSnapshot: stats.atlasSnapshot,
          atlasTimings: stats.atlasTimings,
          atlasDescribed: stats.atlasDescribed,
          atlasSpend: stats.atlasSpend,
        };
        degradedEvidence[expected.mode] = record;
        // Structure is published whatever the provider did.
        assert.equal(stats.atlasError, undefined, `Projection failed: ${stats.atlasError}`);
        assert(stats.atlasSnapshot && stats.atlasDescribed && stats.atlasSpend);
        const described = stats.atlasDescribed;
        assert.equal(described.settings, "account", "The owning account's configuration applies");
        assert(described.capabilities >= 2);
        const overview = await api<AtlasOverview>(`${atlasOf(repo)}/overview`, tokenOf(repo));
        assert.equal(overview.snapshot.id, stats.atlasSnapshot);
        assert.deepEqual(overview.snapshot.vector, [
          { repoId: repo.id, sourceId: "canonical", commit: repo.head, buildId: build.id },
        ]);
        const caps = [
          await sharedCapability(repo, LEDGER_CAPABILITY),
          await sharedCapability(repo, CURRENCY_CAPABILITY),
        ];
        assert.notEqual(caps[0]!.entity.id, caps[1]!.entity.id);
        const states = caps.map((c) => ({
          id: c.entity.id,
          name: c.entity.name,
          summary: c.entity.summary,
          summaryState: c.entity.summaryState,
          description: c.entity.data.description as AtlasDescription,
          nameSource: c.entity.data.nameSource,
          inferred: (c.entity.data.provenance as AtlasProvenance).inferred,
        }));
        record.capabilities = states.map((s) => ({
          ...s,
          inferred: s.inferred ? { model: s.inferred.model, basis: s.inferred.basis } : null,
        }));
        const missing = states.filter((s) => s.summaryState?.status !== "current");
        for (const s of missing) {
          // Honest: no prose, no model name, the reason, and nothing borrowed.
          assert.deepEqual(s.summaryState, { status: "unavailable", reason: expected.reason });
          assert.equal(s.description.status, "unavailable");
          assert.equal(s.description.summary ?? null, null);
          assert.equal(s.summary, "");
          assert.equal(s.nameSource, "concepts");
          assert.equal(s.inferred ?? null, null);
        }
        const spent = await spendRows([repo.id]);
        record.spendRows = spent;
        if (expected.mode === "disabled") {
          assert.equal(described.model, enabled.model);
          assert.equal(
            missing.length,
            states.length,
            "Nothing is described without a priced model",
          );
          assert.equal(stats.atlasSpend.calls, 0);
          assert.equal(spent.length, 0, "A disabled provider is never called or charged");
        } else if (expected.mode === "refused") {
          assert.equal(described.model, "@cf/gitmatrix/atlas-unserved-model");
          assert.equal(missing.length, states.length);
          assert.equal(described.inferred, 0);
          // Each failed call stays charged at its reservation; none is retried.
          assert(stats.atlasSpend.calls >= 1 && stats.atlasSpend.calls <= described.capabilities);
          assert(spent.length === stats.atlasSpend.calls);
          assert(spent.every((r) => r.status === "failed" && r.model === ATLAS_REFUSED_MODEL));
        } else {
          assert.equal(described.model, enabled.model);
          // One call, then the cap: the rest wait, labelled.
          assert.equal(stats.atlasSpend.calls, 1, "The one-call cap allows exactly one call");
          assert.deepEqual(
            stats.atlasSpend.exhausted && {
              cap: stats.atlasSpend.exhausted.cap,
              resetsAt: stats.atlasSpend.exhausted.resetsAt ?? null,
            },
            { cap: "calls", resetsAt: null },
          );
          assert.equal(described.inferred, 1);
          assert.equal(described.unavailable, described.capabilities - 1);
          assert.equal(spent.length, 1);
          assert.equal(spent[0]!.status, "settled");
          const current = states.filter((s) => s.summaryState?.status === "current");
          for (const s of current) {
            assert.equal(s.inferred?.basis.commit, repo.head);
            assert.equal(s.inferred?.model, enabled.model);
          }
          for (const s of missing)
            assert.deepEqual(s.description.exhausted, { cap: "calls", resetsAt: null });
          assert(missing.length >= 1, "The cap must leave a capability undescribed");
        }
        // Sources stay complete and immutable.
        for (const s of missing) {
          const sources = await evidenceOf(repo, s.id);
          assert(sources.items.length >= 3, `${s.name} keeps its sources`);
          for (const e of sources.items) assert.equal(e.commit, repo.head);
        }
        const target = missing[0]!;
        record.ui = await browse(repo.owner, expected.mode, async (page) => {
          await page.goto(`/${repo.owner}/${repo.name}/knowledge?view=outline`);
          const notices = page.getByRole("list", { name: "Map state" });
          await expect(notices.getByText(expected.notice)).toBeVisible();
          const tree = page.getByRole("tree", { name: `Outline of ${repo.owner}/${repo.name}` });
          await tree
            .getByRole("treeitem", { name: new RegExp(`^${escape(target.name)}\\s*Capability`) })
            .first()
            .click();
          await page.waitForURL((url) => url.searchParams.get("select") === target.id);
          const selection = page.getByRole("complementary", { name: "Selection" });
          await expect(heading(selection, target.name)).toBeVisible();
          await expect(
            selection.getByText(
              `No summary for this build (${expected.note}). The structure and sources below are complete.`,
            ),
          ).toBeVisible();
          await expect(selection.getByText(/Summary written by/)).toHaveCount(0);
          const shown = await notices.getByRole("listitem").allInnerTexts();
          const drilled = await drillToSource(page, selection, target.name, repo);
          await page.screenshot({ path: join(ctx.artifacts, `atlas-${expected.mode}-source.png`) });
          return { notices: shown, ...drilled };
        });
      });
    }

    await step("atlas-usage", async () => {
      const rows = await spendRows([...repos.values()].map((r) => r.id));
      const byRepo = new Map([...repos.values()].map((r) => [r.id, `${r.owner}/${r.name}`]));
      evidence.providerUsage = {
        calls: rows.map((r) => ({ ...r, repo: byRepo.get(String(r.repo_id)) })),
        totals: {
          calls: rows.length,
          settled: rows.filter((r) => r.status === "settled").length,
          failed: rows.filter((r) => r.status === "failed").length,
          inputTokens: rows.reduce((n, r) => n + Number(r.input_tokens), 0),
          outputTokens: rows.reduce((n, r) => n + Number(r.output_tokens), 0),
          usd: rows.reduce((n, r) => n + Number(r.cost_micro_usd), 0) / 1_000_000,
        },
      };
    });
    evidence.outcome = "passed";
  } catch (error) {
    evidence.outcome = "failed";
    evidence.failedStage ??= stage;
    evidence.error ??= error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await browser?.close().catch(() => {});
  }
}
