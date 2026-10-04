// The Chronicle (CORE-251) in a real session: a month of tracker history made
// of real mutations (POST /api/dev/chronicle), its showcase issue linked to a
// real commit with a real CI run in orbit/engine and a release-note entry.
// One journey per device class reads the page against the API's own answer:
// scrub to a past moment and read the statuses, select a range and read the
// summary, open a work span and follow its commit, CI run and release note,
// Back/Forward and a copied link, keyboard only, light and dark, reduced
// motion, and how long a frame takes with thousands of events on screen.

import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, expect as playwrightExpect, type Page } from "@playwright/test";
import type { CiRunList } from "../../apps/website/shared/api.ts";
import {
  stateAt,
  summarize,
  type Chronicle,
  type ChronicleIssue,
  type LinkedWork,
} from "../../apps/website/shared/chronicle.ts";
import type { HarnessContext } from "./types.ts";

export interface ChronicleE2E {
  ctx: HarnessContext;
  /** The orbit owner's token (marco). */
  token: string;
  secret: string;
  json<T>(
    path: string,
    token: string | null,
    method?: string,
    body?: unknown,
    statuses?: number[],
  ): Promise<T>;
  record(value: unknown): void;
  /** The fixture's new team key. */
  team?: string;
}

interface Seeded {
  team: string;
  applied: number;
  showcase: { id: string; key: string; holder: string; claimedAt: string; completedAt: string };
  linked: { repo: string; commit: string; release: string } | null;
}

const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

/** The status words a row's mark may show for an API status (claims and waits refine it). */
const MARKS: Record<string, string[]> = {
  todo: ["todo", "waiting", "claimed"],
  in_progress: ["in_progress", "claimed", "waiting"],
  backlog: ["backlog"],
  done: ["done"],
  canceled: ["canceled"],
  done_in_timeline: ["done_in_timeline"],
  none: ["none"],
};

export async function chronicleScenario(t: ChronicleE2E): Promise<void> {
  const owner = "orbit";
  const repo = "orbit/engine";
  // A real commit with a real CI run, from the CI scenarios before this one.
  const runs = await t.json<CiRunList>(`/api/repos/${repo}/ci`, t.token);
  const run =
    runs.runs.find((r) => r.trigger === "push" && /^[0-9a-f]{40}$/.test(r.commit)) ??
    runs.runs.find((r) => /^[0-9a-f]{40}$/.test(r.commit));
  assert(run, "orbit/engine has a CI run of a pushed commit");
  const seeded = await t.json<Seeded>(
    "/api/dev/chronicle",
    t.secret,
    "POST",
    {
      account: owner,
      team: t.team ?? "CHRON",
      issues: 300,
      days: 30,
      seed: 11,
      link: { repo, commit: run.commit },
    },
    [201],
  );
  const show = seeded.showcase;
  assert(seeded.applied > 3000, `The history has thousands of events (${seeded.applied})`);
  t.record({ seeded: { applied: seeded.applied, showcase: show.key, run: run.number } });

  // The API's answer for a day around the showcase span: what the page must show.
  const claimed = Date.parse(show.claimedAt);
  const completed = Date.parse(show.completedAt);
  const from = claimed - 10 * HOUR;
  const to = claimed + 14 * HOUR;
  const query = `team:${(t.team ?? "CHRON").toLowerCase()}`;
  const issues: ChronicleIssue[] = [];
  let cursor: string | null = null;
  let truth: Chronicle | null = null;
  do {
    const params = new URLSearchParams({
      from: iso(from),
      to: iso(to),
      q: query,
      limit: "200",
      quiet: "1",
    });
    if (cursor) params.set("cursor", cursor);
    const page: Chronicle = await t.json<Chronicle>(
      `/api/tracker/${owner}/chronicle?${params}`,
      t.token,
    );
    truth ??= page;
    issues.push(...page.issues);
    cursor = page.next;
  } while (cursor);
  const showRow = issues.find((i) => i.key === show.key);
  assert(showRow?.spans[0], "The showcase issue has its span");
  const work = await t.json<LinkedWork>(
    `/api/tracker/${owner}/issues/${encodeURIComponent(show.key)}/work`,
    t.token,
  );
  assert(
    work.commits.some((c) => c.oid === run.commit),
    "Linked work names the commit",
  );
  assert(
    work.runs.some((r) => r.number === run.number),
    "Linked work names its CI run",
  );
  assert.equal(work.releaseNotes.length, 1, "Linked work names the release-note entry");

  const expect = playwrightExpect.configure({ timeout: 15_000 });
  const browser = await chromium.launch({ headless: true });
  const shots = (name: string) => join(t.ctx.artifacts, `chronicle-${name}.png`);
  const signIn = async (viewport: { width: number; height: number }, dark: boolean) => {
    const context = await browser.newContext({
      baseURL: t.ctx.origin,
      viewport,
      timezoneId: "UTC",
      reducedMotion: "reduce",
      colorScheme: dark ? "dark" : "light",
      hasTouch: viewport.width < 768,
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto("/signin");
    await page.getByRole("button", { name: /Continue as marco/i }).click();
    await page.waitForURL((url) => url.pathname !== "/signin");
    return { context, page };
  };
  const setTheme = (page: Page, theme: "light" | "dark") =>
    page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
  const base = `/tracker/${owner}`;
  const address = (at: number, extra: Record<string, string> = {}) =>
    `?${new URLSearchParams({ view: "chronicle", q: query, from: iso(from), to: iso(to), at: iso(at), ...extra })}`;
  const playhead = async (page: Page) =>
    Date.parse(
      (await page.locator("[data-chronicle-playhead]").getAttribute("data-chronicle-playhead"))!,
    );
  const noSideways = async (page: Page, label: string) => {
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert(width <= page.viewportSize()!.width, `${label}: no horizontal scrolling (${width})`);
  };

  try {
    // ── Desktop, keyboard first ───────────────────────────────────────────
    {
      const { context, page } = await signIn({ width: 1440, height: 900 }, true);
      try {
        const chronicleRequests: string[] = [];
        page.on("request", (request) => {
          if (request.url().includes(`/api/tracker/${owner}/chronicle`))
            chronicleRequests.push(request.url());
          assert(
            !request.url().includes(`/api/tracker/${owner}/changes`),
            "The Chronicle never downloads the event log",
          );
        });
        await page.goto(`${base}${address(from + HOUR)}`);
        const lanes = page.locator("[data-chronicle-lanes]");
        await expect(lanes).toBeVisible();
        await expect(page.locator(`[data-chronicle-row="${show.key}"]`)).toBeVisible();

        // Scrub with the keyboard: pick the showcase row, then jump to its changes.
        await lanes.focus();
        const announce = page.locator("[data-chronicle-announce]");
        await page.keyboard.press("ArrowUp");
        for (let i = 0; i < 400; i++) {
          if ((await announce.innerText()).includes(`: ${show.key} `)) break;
          await page.keyboard.press("ArrowDown");
        }
        await expect(announce).toContainText(show.key);
        // "." steps to the row's next change until the playhead reaches the claim.
        for (let i = 0; i < 20 && (await playhead(page)) < claimed; i++) {
          await page.keyboard.press(".");
          await page.waitForTimeout(120);
        }
        assert.equal(await playhead(page), claimed, "The playhead stops on the claim");
        await expect(announce).toContainText("As of");
        // Its next change is the checkpoint an hour on: every row's mark says
        // what the API says, as of then.
        await page.keyboard.press(".");
        await page.waitForTimeout(150);
        const at = await playhead(page);
        assert.equal(at, claimed + HOUR, "The playhead stops on the checkpoint");
        const rows = page.locator("[data-chronicle-row]");
        await expect(rows.first()).toBeVisible();
        const marks = await rows.evaluateAll((els) =>
          els.map((el) => [el.getAttribute("data-chronicle-row"), el.getAttribute("data-state")]),
        );
        assert(marks.length >= 10, `Enough rows on screen to compare (${marks.length})`);
        for (const [key, state] of marks) {
          const issue = issues.find((i) => i.key === key);
          assert(issue, `${key} is in the API's answer`);
          const status = stateAt(issue, at).status ?? "none";
          assert(
            MARKS[status]!.includes(state!),
            `${key} as of ${iso(at)}: the page says ${state}, the history says ${status}`,
          );
        }
        await expect(page.locator(`[data-chronicle-row="${show.key}"]`)).toHaveAttribute(
          "data-state",
          "claimed",
        );
        // "]" selects the row's span; Enter opens the issue.
        await page.keyboard.press("]");
        await page.waitForURL((url) => url.searchParams.get("span") === showRow.spans[0]!.id);
        await expect(page.locator("[data-chronicle-span-facts]")).toBeVisible();
        t.record({ keyboard: { scrubbedTo: iso(at), rowsCompared: marks.length } });

        // Follow the span's linked work: the CI run, the commit, the release note.
        const linked = page.locator("[data-chronicle-linked-work]");
        await expect(linked).toContainText("Linked work during this span");
        const spanUrl = page.url();
        await linked
          .getByRole("link", { name: new RegExp(`Run #${run.number}\\b`) })
          .first()
          .click();
        await page.waitForURL((url) => url.pathname === `/${repo}/ci/${run.number}`);
        await expect(page.getByText(run.title || "(no message)").first()).toBeVisible();
        await page.goBack();
        await page.waitForURL(spanUrl);
        await expect(page.locator("[data-chronicle-span-facts]")).toBeVisible();
        await linked
          .locator('[data-linked-work="Commits"] a')
          .filter({ hasText: run.commit.slice(0, 7) })
          .first()
          .click();
        await page.waitForURL((url) => url.pathname.startsWith(`/${repo}/commits/${run.commit}`));
        await page.goBack();
        await page.waitForURL(spanUrl);
        await linked.locator('[data-linked-work="Release notes"] a').first().click();
        await page.waitForURL((url) => url.pathname.startsWith(`/${repo}/releases/`));
        await expect(page.getByText(`${show.key} shipped`)).toBeVisible();
        await page.goBack();
        await page.waitForURL(spanUrl);

        // Select a range on the ruler: the summary reads as the history says.
        const ruler = page.locator("[data-chronicle-ruler]");
        const box = (await ruler.boundingBox())!;
        const x = (time: number) => box.x + ((time - from) / (to - from)) * box.width;
        await page.mouse.move(x(claimed - HOUR), box.y + 20);
        await page.mouse.down();
        await page.mouse.move(x(completed + HOUR), box.y + 20, { steps: 8 });
        await page.mouse.up();
        await page.waitForURL((url) => url.searchParams.has("rs"));
        const url = new URL(page.url());
        const range = {
          from: Date.parse(url.searchParams.get("rs")!),
          to: Date.parse(url.searchParams.get("re")!),
        };
        await page.getByRole("link", { name: "Close the inspector" }).click();
        const summary = summarize(issues, range.from, range.to, Date.parse(truth!.serverTime));
        const counts = page.locator("[data-chronicle-counts]");
        await expect(counts).toBeVisible();
        for (const [status, n] of Object.entries(summary.endCounts))
          await expect(counts.locator(`tr[data-status="${status}"] td`).last()).toHaveText(
            String(n),
          );
        await expect(page.getByRole("heading", { name: /^Completed/ })).toContainText(
          String(summary.completed.length),
        );
        t.record({ range: { ...summary.endCounts, completed: summary.completed.length } });

        // Back and Forward, and a copied link.
        const withRange = page.url();
        await page.goBack();
        await expect(page).not.toHaveURL(withRange);
        await page.goForward();
        await expect(page).toHaveURL(withRange);
        await expect(counts).toBeVisible();
        const copied = await context.newPage();
        await copied.goto(withRange);
        await expect(copied.locator("[data-chronicle-counts]")).toBeVisible();
        assert.equal(
          await copied.locator("[data-chronicle-playhead]").getAttribute("data-chronicle-playhead"),
          await page.locator("[data-chronicle-playhead]").getAttribute("data-chronicle-playhead"),
        );
        await copied.close();

        // Smoothness: zoom and pan with thousands of events on screen.
        await page.goto(
          `${base}?${new URLSearchParams({ view: "chronicle", q: query, from: iso(Date.parse(seeded.showcase.claimedAt) - 20 * 24 * HOUR), to: iso(Date.now()) })}`,
        );
        await expect(lanes).toBeVisible();
        const lanesBox = (await lanes.boundingBox())!;
        const draws: number[] = [];
        await page.evaluate(() => {
          const times: number[] = [];
          let last = performance.now();
          let running = true;
          const tick = (now: number) => {
            times.push(now - last);
            last = now;
            if (running) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          (window as unknown as { stopFrames: () => number[] }).stopFrames = () => {
            running = false;
            return times;
          };
        });
        await page.mouse.move(lanesBox.x + lanesBox.width / 2, lanesBox.y + 100);
        for (let i = 0; i < 20; i++) {
          await page.keyboard.down("Control");
          await page.mouse.wheel(0, i < 10 ? -120 : 120);
          await page.keyboard.up("Control");
          draws.push(
            Number(await page.locator("[data-chronicle-timeline]").getAttribute("data-draw-ms")),
          );
        }
        await page.mouse.down();
        for (let i = 0; i < 20; i++) {
          await page.mouse.move(lanesBox.x + lanesBox.width / 2 - i * 15, lanesBox.y + 100);
          draws.push(
            Number(await page.locator("[data-chronicle-timeline]").getAttribute("data-draw-ms")),
          );
        }
        await page.mouse.up();
        const frameTimes = await page.evaluate(() =>
          (window as unknown as { stopFrames: () => number[] }).stopFrames(),
        );
        const sorted = [...draws].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
        const frameSorted = [...frameTimes].sort((a, b) => a - b);
        const frameP95 = frameSorted[Math.floor(frameSorted.length * 0.95)] ?? 0;
        const rowCount = Number(
          (await page.locator("[data-chronicle-timeline]").innerText())
            .match(/([\d,]+) issues/)?.[1]
            ?.replace(",", "") ?? 0,
        );
        t.record({
          performance: {
            drawP95Ms: p95,
            drawMaxMs: sorted.at(-1),
            frameP95Ms: frameP95,
            rows: rowCount,
          },
        });
        assert(rowCount >= 100, `Hundreds of rows on screen (${rowCount})`);
        assert(p95 < 16, `A lanes redraw stays under a frame (p95 ${p95} ms)`);
        assert(
          chronicleRequests.every((u) => Number(new URL(u).searchParams.get("limit")) <= 200),
          "Every read is a bounded page",
        );

        // Light and dark both draw; screenshots for the record.
        await page.goto(
          `${base}/issues/${encodeURIComponent(show.id)}${address(claimed + HOUR, { span: showRow.spans[0]!.id })}`,
        );
        await expect(page.locator("[data-chronicle-span-facts]")).toBeVisible();
        await setTheme(page, "dark");
        await page.screenshot({ path: shots("desktop-dark") });
        await setTheme(page, "light");
        await page.waitForTimeout(200);
        await page.screenshot({ path: shots("desktop-light") });
        await noSideways(page, "desktop");
        await context.tracing.stop();
      } catch (error) {
        await page.screenshot({ path: shots("desktop-failure"), fullPage: true }).catch(() => {});
        await context.tracing
          .stop({ path: shots("desktop-failure").replace(".png", ".zip") })
          .catch(() => {});
        throw error;
      } finally {
        await context.close();
      }
    }

    // ── Phone: the list, the scrubber, a span ─────────────────────────────
    {
      const { context, page } = await signIn({ width: 390, height: 844 }, false);
      try {
        await page.goto(`${base}${address(claimed - HOUR)}`);
        const list = page.locator("[data-chronicle-list]");
        await expect(list).toBeVisible();
        const item = list.locator(`[data-chronicle-item="${show.key}"]`);
        await expect(item).toHaveAttribute("data-state", "todo");
        // The scrubber moves the playhead from the keyboard (or a thumb).
        const scrubber = page.locator("[data-chronicle-scrubber]");
        const before = await playhead(page);
        await scrubber.focus();
        for (let i = 0; i < 30 && (await playhead(page)) < claimed + 10 * 60_000; i++)
          await page.keyboard.press("ArrowRight");
        assert((await playhead(page)) > before, "The scrubber moved the playhead");
        await expect(item).toHaveAttribute("data-state", "claimed");
        await item.locator("[data-chronicle-span]").first().tap();
        await expect(page.locator("[data-chronicle-span-facts]")).toBeVisible();
        await expect(page.locator('[data-linked-work="CI runs"]').first()).toBeVisible();
        await noSideways(page, "phone");
        await setTheme(page, "light");
        await page.waitForTimeout(200);
        await page.screenshot({ path: shots("phone-light") });
        await setTheme(page, "dark");
        await page.waitForTimeout(200);
        await page.screenshot({ path: shots("phone-dark") });
        await context.tracing.stop();
      } catch (error) {
        await page.screenshot({ path: shots("phone-failure"), fullPage: true }).catch(() => {});
        await context.tracing
          .stop({ path: shots("phone-failure").replace(".png", ".zip") })
          .catch(() => {});
        throw error;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
