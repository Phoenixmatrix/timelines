// The overview brush behaves like a conventional range brush (CORE-276).

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";
import { ChronicleOverview } from "./ChronicleOverview.tsx";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-01-01T00:00:00Z");
// 100 days of history in a 500px strip: 5px a day.
const NOW = START + 100 * DAY;

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

function mount(initial: { from: number; to: number }) {
  const windows: { from: number; to: number }[] = [];
  let current = initial;
  function Harness() {
    const [view, setView] = useState(initial);
    current = view;
    return (
      <div style={{ width: 500, padding: 0 }}>
        <ChronicleOverview
          density={{
            start: new Date(START).toISOString(),
            bucketMs: DAY,
            counts: Array(100).fill(1),
          }}
          history={null}
          window={view}
          at={view.to}
          now={NOW}
          onWindow={(next, commit) => {
            setView(next);
            if (commit) windows.push(next);
          }}
        />
      </div>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  const strip = container.querySelector<HTMLElement>("[data-chronicle-overview]")!;
  const box = () => strip.getBoundingClientRect();
  const at = (t: number) => box().left + ((t - START) / (NOW - START)) * box().width;
  const fire = (type: string, clientX: number, buttons: number) =>
    act(() => {
      strip.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          buttons,
          clientX,
          clientY: box().top + box().height / 2,
        }),
      );
    });
  const drag = (fromX: number, toX: number) => {
    fire("pointerdown", fromX, 1);
    for (let i = 1; i <= 10; i++) fire("pointermove", fromX + ((toX - fromX) * i) / 10, 1);
    fire("pointerup", toX, 0);
  };
  return { strip, at, fire, drag, windows, view: () => current };
}

const days = (window: { from: number; to: number }) =>
  [(window.from - START) / DAY, (window.to - START) / DAY].map((d) => Math.round(d * 10) / 10);

test("each edge resizes its own side, even on a narrow window", async () => {
  // One day wide: 5px, so the old 8px zones around each edge overlapped and the
  // left edge took every press.
  const { at, drag, view } = mount({ from: START + 50 * DAY, to: START + 51 * DAY });
  drag(at(START + 51 * DAY) - 1, at(START + 60 * DAY) - 1);
  expect(days(view())).toEqual([50, 60]);
  drag(at(START + 50 * DAY) + 1, at(START + 40 * DAY) + 1);
  expect(days(view())).toEqual([40, 60]);
});

test("a narrow window still moves from its middle", async () => {
  const { at, drag, view } = mount({ from: START + 50 * DAY, to: START + 53 * DAY });
  drag(at(START + 51.5 * DAY), at(START + 61.5 * DAY));
  expect(days(view())).toEqual([60, 63]);
});

test("dragging an edge past now stops at now instead of running away", async () => {
  const { at, fire, view, strip } = mount({ from: START + 50 * DAY, to: START + 60 * DAY });
  const right = strip.getBoundingClientRect().right;
  fire("pointerdown", at(START + 60 * DAY), 1);
  // Held past the end, the window doesn't keep growing.
  for (let i = 0; i < 5; i++) fire("pointermove", right + 40, 1);
  expect(days(view())).toEqual([50, 100]);
  fire("pointerup", right + 40, 0);
  expect(days(view())).toEqual([50, 100]);
});

test("moving the window stops at the start of history and keeps its width", async () => {
  const { at, drag, view } = mount({ from: START + 10 * DAY, to: START + 30 * DAY });
  drag(at(START + 20 * DAY), at(START + 20 * DAY) - 300);
  expect(days(view())).toEqual([0, 20]);
});

test("the pointer says what a press will do", async () => {
  const { at, fire, strip } = mount({ from: START + 40 * DAY, to: START + 60 * DAY });
  const cursorAt = (x: number) => {
    fire("pointermove", x, 0);
    return strip.style.cursor;
  };
  expect(cursorAt(at(START + 40 * DAY))).toBe("ew-resize");
  expect(cursorAt(at(START + 60 * DAY))).toBe("ew-resize");
  expect(cursorAt(at(START + 50 * DAY))).toBe("grab");
  expect(cursorAt(at(START + 80 * DAY))).toBe("crosshair");
  fire("pointerdown", at(START + 50 * DAY), 1);
  expect(strip.style.cursor).toBe("grabbing");
  fire("pointerup", at(START + 50 * DAY), 0);
});

test("a cancelled drag puts the window back", async () => {
  const { at, fire, view, windows } = mount({ from: START + 40 * DAY, to: START + 60 * DAY });
  fire("pointerdown", at(START + 50 * DAY), 1);
  fire("pointermove", at(START + 70 * DAY), 1);
  expect(days(view())).toEqual([60, 80]);
  fire("pointercancel", at(START + 70 * DAY), 0);
  expect(days(view())).toEqual([40, 60]);
  expect(days(windows.at(-1)!)).toEqual([40, 60]);
});
