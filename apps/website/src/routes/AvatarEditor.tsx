// Account pictures: your profile picture (CORE-116) and an organization's
// icon (CORE-128). Upload or drop one, crop it to a square,
// or pick one of four generated options (made once, never more).

import { Dialog } from "@base-ui/react/dialog";
import { ImageIcon, SparkleIcon, TrashIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useRevalidator } from "react-router";
import type { AvatarOptions, Viewer } from "../../shared/api.ts";
import { Monogram } from "../components/Monogram.tsx";
import { Card, FormError, dialogMotion, fadeMotion } from "../components/ui.tsx";
import { ApiError, api } from "../lib/api.ts";
import { centered, clamp, MAX_ZOOM, MIN_ZOOM, sourceRect, zoomTo, type Crop } from "../lib/crop.ts";

/** What the browser sends: 256×256, well under the server's 256 KiB limit. */
const OUTPUT = 256;
/** The crop viewport, in CSS pixels. */
const VIEW = 256;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

interface Source {
  url: string;
  width: number;
  height: number;
  image: HTMLImageElement;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That file isn't a picture this browser can open."));
    image.src = url;
  });
}

/** The cropped square as an image file: WebP where the browser can, else PNG. */
async function render(source: Source, crop: Crop): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT;
  canvas.height = OUTPUT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can't crop pictures.");
  const { sx, sy, side } = sourceRect(crop, source.width, source.height, VIEW);
  context.imageSmoothingQuality = "high";
  context.drawImage(source.image, sx, sy, side, side, 0, 0, OUTPUT, OUTPUT);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.9),
  );
  if (!blob) throw new Error("Couldn't prepare the picture.");
  return blob;
}

function Cropper({
  source,
  busy,
  error,
  onSave,
  onCancel,
}: {
  source: Source;
  busy: boolean;
  error: string;
  onSave: (crop: Crop) => void;
  onCancel: () => void;
}) {
  const [crop, setCrop] = useState(() => centered(source.width, source.height, VIEW));
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null);
  const fit = (next: Crop) => setCrop(clamp(next, source.width, source.height, VIEW));
  const scale = (Math.max(VIEW / source.width, VIEW / source.height) * crop.zoom).toFixed(4);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, crop };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    fit({
      ...start.crop,
      x: start.crop.x + event.clientX - start.x,
      y: start.crop.y + event.clientY - start.y,
    });
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      fit({ ...crop, x: crop.x + move[0], y: crop.y + move[1] });
    } else if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      setCrop(
        zoomTo(
          crop,
          crop.zoom + (event.key === "-" ? -0.2 : 0.2),
          source.width,
          source.height,
          VIEW,
        ),
      );
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className={`mk-backdrop ${fadeMotion}`} />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Popup className={`mk-dialog ${dialogMotion}`}>
            <Dialog.Title className="mk-dialog-title">Crop your picture</Dialog.Title>
            <Dialog.Description className="mk-dialog-desc text-body-sm">
              Drag to move it, or use the arrow keys; zoom with the slider or + and −.
            </Dialog.Description>
            <div className="mt-4 flex flex-col items-center gap-4">
              <div
                role="img"
                aria-label="Picture to crop: drag or use the arrow keys to move it"
                tabIndex={0}
                className="relative cursor-grab touch-none overflow-hidden rounded-full bg-raised outline-offset-4 select-none active:cursor-grabbing"
                style={{ width: VIEW, height: VIEW, maxWidth: "100%" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={() => (drag.current = null)}
                onPointerCancel={() => (drag.current = null)}
                onKeyDown={onKey}
              >
                <img
                  src={source.url}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left"
                  style={{
                    width: source.width,
                    height: source.height,
                    transform: `translate(${crop.x}px, ${crop.y}px) scale(${scale})`,
                  }}
                />
              </div>
              <label className="flex w-full max-w-64 items-center gap-3 text-body-sm text-ink-muted">
                Zoom
                <input
                  type="range"
                  className="flex-1"
                  min={MIN_ZOOM}
                  max={MAX_ZOOM}
                  step={0.01}
                  value={crop.zoom}
                  onChange={(event) =>
                    setCrop(
                      zoomTo(crop, Number(event.target.value), source.width, source.height, VIEW),
                    )
                  }
                />
              </label>
            </div>
            <FormError message={error} />
            <div className="mk-dialog-actions">
              <button
                type="button"
                className="mk-btn mk-btn--ghost"
                onClick={onCancel}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="mk-btn mk-btn--primary"
                onClick={() => onSave(crop)}
                disabled={busy}
              >
                {busy ? "Saving…" : "Use this picture"}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What the editor changes: your picture, or an organization's icon. */
export interface PictureTarget {
  /** The account's API path: "/account/avatar" or "/accounts/<slug>/avatar". */
  endpoint: string;
  name: string;
  avatarUrl: string | null;
  shape: "person" | "place";
  /** "picture" for people, "icon" for organizations. */
  noun: "picture" | "icon";
  /** One line on where it shows. */
  intro: string;
}

/** Your profile picture, on Settings → Profile. */
export function AvatarCard({ viewer }: { viewer: Viewer }) {
  return (
    <Card title="Picture">
      <PictureEditor
        target={{
          endpoint: "/account/avatar",
          name: viewer.displayName,
          avatarUrl: viewer.avatarUrl,
          shape: "person",
          noun: "picture",
          intro: "Shown wherever you appear.",
        }}
      />
    </Card>
  );
}

export function PictureEditor({ target }: { target: PictureTarget }) {
  const { endpoint, noun } = target;
  const article = noun === "icon" ? "an" : "a";
  const plural = `${noun}s`;
  const revalidator = useRevalidator();
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState("");
  const [cropError, setCropError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [options, setOptions] = useState<AvatarOptions | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api<AvatarOptions>(`${endpoint}/options`, { signal: controller.signal }).then(
      setOptions,
      () => {},
    );
    return () => controller.abort();
  }, [endpoint]);
  // Object URLs for local files are released when replaced or closed.
  useEffect(() => {
    const url = source?.url;
    return () => {
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    };
  }, [source?.url]);

  const open = async (blob: Blob) => {
    setError("");
    setCropError("");
    if (!ACCEPTED.includes(blob.type)) {
      setError("Choose a PNG, JPEG, WebP or GIF picture.");
      return;
    }
    if (blob.size > 20 * 1024 * 1024) {
      setError("That picture is over 20 MB; choose a smaller one.");
      return;
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImage(url);
      setSource({ url, width: image.naturalWidth, height: image.naturalHeight, image });
    } catch (cause) {
      URL.revokeObjectURL(url);
      setError(cause instanceof Error ? cause.message : "Couldn't open that picture.");
    }
  };

  const save = async (crop: Crop) => {
    if (!source) return;
    setBusy(true);
    setCropError("");
    try {
      const blob = await render(source, crop);
      await api(endpoint, {
        method: "PUT",
        body: blob,
        headers: { "content-type": blob.type },
      });
      setSource(null);
      await revalidator.revalidate();
    } catch (cause) {
      setCropError(cause instanceof Error ? cause.message : "Couldn't save the picture.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api(endpoint, { method: "DELETE" });
      await revalidator.revalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't remove the picture.");
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setConfirming(false);
    setGenerating(true);
    setError("");
    try {
      setOptions(await api<AvatarOptions>(`${endpoint}/options`, { method: "POST" }));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 503)
        setError("Generated pictures are off on this server.");
      else {
        setError(cause instanceof Error ? cause.message : "Couldn't generate pictures.");
        // A conflict or a partial failure still leaves options to show.
        api<AvatarOptions>(`${endpoint}/options`).then(setOptions, () => {});
      }
    } finally {
      setGenerating(false);
    }
  };

  const pick = async (url: string) => {
    setError("");
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Couldn't load that option.");
      await open(await response.blob());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't load that option.");
    }
  };

  const canGenerate = options?.status === "none" || options?.status === "failed";

  return (
    <>
      <div
        className={`mk-card-body rounded-pane transition-colors ${dragging ? "bg-raised outline-2 outline-dashed outline-signal-line" : ""}`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) void open(file);
        }}
      >
        <div className="flex flex-wrap items-center gap-4">
          <Monogram name={target.name} src={target.avatarUrl} shape={target.shape} size="lg" />
          <p className="m-0 min-w-0 flex-1 text-body-sm text-ink-muted">
            {target.intro} Drop {article} {noun} here, upload one, or pick a generated one; you can
            crop it before saving.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="mk-btn"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <UploadSimpleIcon className="size-4" aria-hidden />
            Upload {article} {noun}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED.join(",")}
            className="sr-only"
            tabIndex={-1}
            aria-label="Picture file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void open(file);
            }}
          />
          {target.avatarUrl && (
            <button type="button" className="mk-btn mk-btn--ghost" disabled={busy} onClick={remove}>
              <TrashIcon className="size-4" aria-hidden />
              Remove {noun}
            </button>
          )}
        </div>

        <section
          aria-label={`Generated ${plural}`}
          className="flex flex-col gap-2 border-t border-line-soft pt-4"
        >
          <h3 className="m-0 flex items-center gap-2 text-body font-semibold">
            <SparkleIcon className="size-4 text-ink-muted" aria-hidden />
            Generated {plural}
          </h3>
          {options?.status === "ready" && (
            <>
              <p className="m-0 text-body-sm text-ink-muted">
                The generated set: pick one to crop and use. There won't be more.
              </p>
              <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4">
                {options.options.map((url, index) => (
                  <li key={url}>
                    <button
                      type="button"
                      className="block w-full overflow-hidden rounded-pane border border-line-soft p-0 hover:border-signal-line focus-visible:outline-2"
                      aria-label={`Use generated ${noun} ${index + 1}`}
                      onClick={() => void pick(url)}
                    >
                      <img src={url} alt="" className="block aspect-square w-full object-cover" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {generating && (
            <p role="status" className="m-0 text-body-sm text-ink-muted">
              <ImageIcon className="mr-1 inline size-4 align-[-2px]" aria-hidden />
              Generating four {plural}… this takes a little while.
            </p>
          )}
          {!generating && canGenerate && !confirming && (
            <>
              <p className="m-0 text-body-sm text-ink-muted">
                {options?.status === "failed"
                  ? `The last attempt didn't produce any ${plural}, so you can try again.`
                  : `Timelines can make four abstract ${plural} to choose from. There's one set, once: no prompts and no redos.`}
              </p>
              <div>
                <button type="button" className="mk-btn" onClick={() => setConfirming(true)}>
                  <SparkleIcon className="size-4" aria-hidden />
                  {options?.status === "failed" ? "Try again" : `Generate four ${plural}`}
                </button>
              </div>
            </>
          )}
          {confirming && (
            <div
              className="flex flex-col gap-2"
              role="group"
              aria-label="Confirm generating pictures"
            >
              <p className="m-0 text-body-sm">
                This can only be done once. Generate the four {plural} now?
              </p>
              <div className="flex gap-2">
                <button type="button" className="mk-btn mk-btn--primary" onClick={generate}>
                  Generate them
                </button>
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost"
                  onClick={() => setConfirming(false)}
                >
                  Not now
                </button>
              </div>
            </div>
          )}
        </section>
        <FormError message={error} />
      </div>
      {source && (
        <Cropper
          source={source}
          busy={busy}
          error={cropError}
          onSave={save}
          onCancel={() => setSource(null)}
        />
      )}
    </>
  );
}
