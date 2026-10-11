// Claude Code mod (CORE-303), installed by `gm agent mod`: a corner card
// above the prompt with the gitmatrix issue this session works on. The chord
// `gm agent mod` binds to ACTION (ctrl+x g) or /gm-work toggles it.
import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { GmSnapshot } from "../types";
import { resolveIdentity } from "./identity";
import { currentTimeline, gmCalls, metaLine, myClaims, nextFocus, toWork } from "./gm";

type Engine = EngineInterface;

/**
 * The engine keybinding action the hidden toggle Button answers to. Mods
 * can't declare actions of their own, so this borrows one that is idle
 * unless the diff panel has pre-session changes. `gm agent mod` binds a
 * chord to the same action (claude_mod.rs's ACTION).
 */
const ACTION = "app:toggleDiffPreSession";
const COMMAND = "gm-work";
const STORE_SHOWN = "isShown";
const REFRESH_MS = 60_000;
const CARD_COLUMNS = 46;

const isShown = atom({ plugin: "gitmatrix-work", key: "isShown" } as const, true);
const snapshot = atom({ plugin: "gitmatrix-work", key: "snapshot" } as const, null);
const focusKey = atom({ plugin: "gitmatrix-work", key: "focusKey" } as const, null);

// Module state: a hot reload starts these over, which is fine.
let checkout: string | null = null;
let isLoading = false;
let isStale = false;

async function gm($: Engine, args: string[]): Promise<unknown> {
  const ran = await $.process.run(["gm", ...args, "-o", "json"], { timeoutMs: 20_000 });
  if (ran.exitCode !== 0) {
    throw new Error("Timelines work unavailable");
  }
  return JSON.parse(ran.stdout);
}

async function load($: Engine): Promise<GmSnapshot> {
  const now = await $.clock.now();
  const cwd = await $.session.cwd();
  if (checkout !== cwd) {
    checkout = cwd;
    await update($, focusKey, () => null);
    await update($, snapshot, () => null);
  }
  const identity = await resolveIdentity(
    (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: 20_000 }),
    cwd,
  );
  if (!identity) {
    await update($, focusKey, () => null);
    return { identity: null, work: null, error: null, fetchedAt: now };
  }
  const agentId = identity.id;
  const previous = await read($, snapshot);
  if (previous?.identity && previous.identity.id !== agentId) {
    await update($, focusKey, () => null);
  }
  try {
    const focus = await read($, focusKey);
    const listing = gm($, [
      "issue",
      "list",
      "--status",
      "in_progress",
      "--all-teams",
      "--limit",
      "100",
    ]);
    const timelines = gm($, ["timeline", "list"]).catch(() => null);
    const focused = focus === null ? null : gm($, ["issue", "show", focus]);
    const claims = myClaims(await listing, agentId, now);
    const key = focus ?? claims[0]?.key ?? null;
    if (key === null) return { identity, work: null, error: null, fetchedAt: now };
    const shown = await (focused ?? gm($, ["issue", "show", key]));
    const work = toWork(shown, {
      agentId,
      timeline: currentTimeline(await timelines),
      otherClaims: claims.filter((claim) => claim.key !== key).length,
    });
    return { identity, work, error: null, fetchedAt: now };
  } catch {
    return { identity, work: null, error: "Timelines work unavailable", fetchedAt: now };
  }
}

/** Reloads the card; a call during a load runs one more after it. */
async function refresh($: Engine): Promise<void> {
  if (isLoading) {
    isStale = true;
    return;
  }
  isLoading = true;
  try {
    do {
      isStale = false;
      const cwd = await $.session.cwd();
      const next = await load($);
      if (cwd !== (await $.session.cwd())) isStale = true;
      if (!isStale) await update($, snapshot, () => next);
    } while (isStale);
  } finally {
    isLoading = false;
  }
}

async function toggle($: Engine): Promise<boolean> {
  const shown = !(await read($, isShown));
  await update($, isShown, () => shown);
  await $.store.set(STORE_SHOWN, shown);
  if (shown) void refresh($);
  return shown;
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Toggle the Timelines work card",
    });
    checkout = null;
    await update($, snapshot, () => null);
    await update($, focusKey, () => null);
    await update($, isShown, () => true);
    if ((await $.store.get(STORE_SHOWN)) === false) await update($, isShown, () => false);
    $.clock.after(0, () => void refresh($));
    $.clock.every(REFRESH_MS, () => {
      void read($, isShown).then((shown) => (shown ? refresh($) : undefined));
    });
    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($) => {
    const shown = await toggle($);
    return { text: shown ? "Timelines work card shown." : "Timelines work card hidden." };
  });

  // Follows the session's own gm commands: what it claims, checkpoints,
  // completes or releases becomes (or stops being) the card's issue.
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const ran = await next(e);
    const calls = gmCalls(e.command);
    if (calls.length === 0 || ran.deny !== undefined || ran.isError) return ran;
    const focus = await read($, focusKey);
    const focused = nextFocus(focus, calls, ran.text ?? "");
    if (focused !== focus) await update($, focusKey, () => focused);
    $.clock.after(0, () => void refresh($));
    return ran;
  }).catch(($, e, next) => next(e));

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);

    // Always mounted, so the chord works while the card is hidden too.
    const toggleButton = (
      <Box display="none">
        <Button key="gm-work-toggle" label="gm" plain action={ACTION} onPress={() => toggle($)} />
      </Box>
    );
    if (!(await read($, isShown))) return toggleButton;

    const snap = await read($, snapshot);
    const now = await $.clock.now();
    const width = Math.min(CARD_COLUMNS, e.props.bodyColumns);
    const isFramed = e.props.maxRows >= 5 && width >= 20;
    const lines: JSX.Element[] = [];
    if (snap?.identity) {
      lines.push(
        <Text bold wrap="truncate-end">
          Agent: {snap.identity.name}
        </Text>,
      );
      if (snap.identity.accountable) {
        lines.push(
          <Text dimColor wrap="truncate-end">
            Accountable: {snap.identity.accountable}
          </Text>,
        );
      }
    }

    if (snap === null) {
      lines.push(
        <Text dimColor wrap="truncate-end">
          Timelines: loading…
        </Text>,
      );
    } else if (snap.work === null) {
      lines.push(
        <Text dimColor wrap="truncate-end">
          {!snap.identity
            ? "No Timelines agent identity"
            : snap.error
              ? "Timelines: unavailable"
              : "No Timelines issue claimed"}
        </Text>,
      );
      lines.push(
        <Text dimColor wrap="truncate-end">
          {!snap.identity
            ? "gm agent setup configures this checkout"
            : (snap.error ?? "gm issue next picks one")}
        </Text>,
      );
    } else {
      const { work } = snap;
      lines.push(
        <Text wrap="truncate-end">
          <Text bold color="claude">
            {work.key}
          </Text>{" "}
          {work.title}
        </Text>,
      );
      lines.push(
        <Text dimColor wrap="truncate-end">
          {metaLine(work, now)}
        </Text>,
      );
      if (snap.error) {
        lines.push(
          <Text color="warning" wrap="truncate-end">
            ⚠ {snap.error}
          </Text>,
        );
      } else if (work.checkpoint) {
        lines.push(
          <Text dimColor wrap="truncate-end">
            ↳ {work.checkpoint}
          </Text>,
        );
      } else if (work.otherClaims > 0) {
        lines.push(
          <Text dimColor wrap="truncate-end">
            +{work.otherClaims} more claimed issue{work.otherClaims === 1 ? "" : "s"}
          </Text>,
        );
      }
    }

    const shownLines = lines.slice(0, Math.max(1, e.props.maxRows - (isFramed ? 2 : 0)));
    return (
      <Box flexDirection="row" justifyContent="flex-end">
        {toggleButton}
        <Box
          key="gm-work-card"
          flexDirection="column"
          width={width}
          borderStyle={isFramed ? "round" : undefined}
          borderDimColor
          paddingX={isFramed ? 1 : 0}
        >
          {shownLines}
        </Box>
      </Box>
    );
  });
};
