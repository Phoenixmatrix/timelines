// Square cropping for profile pictures: the image covers a square viewport,
// can be zoomed and moved, and never leaves a gap at the edges.

export interface Crop {
  /** Zoom on top of the cover scale: 1 fits the shorter side exactly. */
  zoom: number;
  /** The image's top-left corner within the viewport, in viewport pixels (≤ 0). */
  x: number;
  y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** The scale at which the image just covers a square viewport of `size`. */
export function coverScale(width: number, height: number, size: number): number {
  return Math.max(size / width, size / height);
}

/** Keeps the image covering the viewport: no gaps at any edge. */
export function clamp(crop: Crop, width: number, height: number, size: number): Crop {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, crop.zoom));
  const scale = coverScale(width, height, size) * zoom;
  const minX = size - width * scale;
  const minY = size - height * scale;
  return {
    zoom,
    x: Math.min(0, Math.max(minX, crop.x)),
    y: Math.min(0, Math.max(minY, crop.y)),
  };
}

/** The starting crop: no zoom, centered. */
export function centered(width: number, height: number, size: number): Crop {
  const scale = coverScale(width, height, size);
  return { zoom: 1, x: (size - width * scale) / 2, y: (size - height * scale) / 2 };
}

/** A new zoom that keeps the viewport's center over the same point of the image. */
export function zoomTo(crop: Crop, zoom: number, width: number, height: number, size: number) {
  const before = coverScale(width, height, size) * crop.zoom;
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const after = coverScale(width, height, size) * next;
  const centerX = (size / 2 - crop.x) / before;
  const centerY = (size / 2 - crop.y) / before;
  return clamp(
    { zoom: next, x: size / 2 - centerX * after, y: size / 2 - centerY * after },
    width,
    height,
    size,
  );
}

/** The square of the source image the viewport shows, in image pixels. */
export function sourceRect(crop: Crop, width: number, height: number, size: number) {
  const scale = coverScale(width, height, size) * crop.zoom;
  return { sx: 0 - crop.x / scale, sy: 0 - crop.y / scale, side: size / scale };
}
