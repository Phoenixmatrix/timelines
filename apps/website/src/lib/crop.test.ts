import { describe, expect, test } from "vite-plus/test";
import { centered, clamp, coverScale, sourceRect, zoomTo } from "./crop.ts";

describe("square crop", () => {
  test("covers the viewport with the shorter side, centered", () => {
    // A 400×200 landscape in a 100px square: height fits, width overflows.
    expect(coverScale(400, 200, 100)).toBe(0.5);
    expect(centered(400, 200, 100)).toEqual({ zoom: 1, x: -50, y: 0 });
    expect(sourceRect(centered(400, 200, 100), 400, 200, 100)).toEqual({
      sx: 100,
      sy: 0,
      side: 200,
    });
  });

  test("never leaves a gap at an edge", () => {
    expect(clamp({ zoom: 1, x: 30, y: -40 }, 400, 200, 100)).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(clamp({ zoom: 1, x: -500, y: 0 }, 400, 200, 100)).toEqual({ zoom: 1, x: -100, y: 0 });
    expect(clamp({ zoom: 9, x: 0, y: 0 }, 100, 100, 100).zoom).toBe(4);
    expect(clamp({ zoom: 0.2, x: 0, y: 0 }, 100, 100, 100).zoom).toBe(1);
  });

  test("zooming keeps the center of the view on the same point", () => {
    const start = centered(200, 200, 100);
    const zoomed = zoomTo(start, 2, 200, 200, 100);
    expect(zoomed).toEqual({ zoom: 2, x: -50, y: -50 });
    // The source square halves and stays centered.
    expect(sourceRect(zoomed, 200, 200, 100)).toEqual({ sx: 50, sy: 50, side: 100 });
  });
});
