import { highlightLines } from "../../shared/semantic/highlight.ts";

self.onmessage = ({ data }: MessageEvent<{ path: string; text: string }>) => {
  self.postMessage(highlightLines(data.path, data.text));
};
