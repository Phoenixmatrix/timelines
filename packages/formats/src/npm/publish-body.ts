/**
 * Streams an npm publish body (`PUT /<pkg>`) without holding it in memory.
 *
 * The body is one JSON document whose `_attachments.<file>.data` strings hold
 * base64 tarballs (tens of MB). The scanner walks the JSON byte by byte,
 * decodes those strings straight to bytes as `data` events, and keeps every
 * other byte (with each attachment's data replaced by `""`) so the small rest
 * of the document can be parsed with `JSON.parse` at the end. Key order does
 * not matter: npm sends `versions` first, yarn sends `_attachments` first.
 */

export type ScanEvent =
  | { type: "attachment"; name: string }
  | { type: "data"; bytes: Uint8Array }
  | { type: "end" };

export class PublishBodyError extends Error {
  readonly tooLarge: boolean;
  constructor(message: string, tooLarge = false) {
    super(message);
    this.tooLarge = tooLarge;
    this.name = "PublishBodyError";
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const MAX_KEY_BYTES = 1024;

const B64 = new Uint8Array(256).fill(255);
{
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) B64[alphabet.charCodeAt(i)] = i;
}
const PAD = 0x3d;

/** Incremental base64 decoder over ASCII bytes. */
class Base64Decoder {
  private readonly quad = new Uint8Array(4);
  private filled = 0;
  private padding = 0;

  push(input: Uint8Array): Uint8Array {
    const out = new Uint8Array(Math.floor((this.filled + input.length) / 4) * 3);
    let o = 0;
    for (let i = 0; i < input.length; i++) {
      const byte = input[i]!;
      let value: number;
      if (byte === PAD) {
        if (this.filled < 2) throw new PublishBodyError("Invalid base64 in attachment");
        this.padding++;
        value = 0;
      } else {
        value = B64[byte]!;
        if (value === 255 || this.padding > 0) {
          throw new PublishBodyError("Invalid base64 in attachment");
        }
      }
      this.quad[this.filled++] = value;
      if (this.filled === 4) {
        const n =
          (this.quad[0]! << 18) | (this.quad[1]! << 12) | (this.quad[2]! << 6) | this.quad[3]!;
        out[o++] = (n >> 16) & 0xff;
        if (this.padding < 2) out[o++] = (n >> 8) & 0xff;
        if (this.padding < 1) out[o++] = n & 0xff;
        this.filled = 0;
        if (this.padding > 0) this.padding = 3; // nothing may follow padding
      }
    }
    return out.subarray(0, o);
  }

  finish(): Uint8Array {
    const filled = this.filled;
    const data = filled - (this.padding === 3 ? 0 : this.padding);
    this.filled = 0;
    if (filled === 0) return new Uint8Array();
    if (data < 2) throw new PublishBodyError("Truncated base64 in attachment");
    // Unpadded (or partially padded) tail.
    const q = this.quad;
    const n = (q[0]! << 18) | (q[1]! << 12) | ((data > 2 ? q[2]! : 0) << 6);
    return data === 2
      ? new Uint8Array([(n >> 16) & 0xff])
      : new Uint8Array([(n >> 16) & 0xff, (n >> 8) & 0xff]);
  }
}

interface Frame {
  type: "object" | "array";
  key: string | null;
  expectKey: boolean;
}

export class PublishBodyScanner {
  private readonly stack: Frame[] = [];
  private inString = false;
  private escape = false;
  private stringIsKey = false;
  private keyBytes: number[] = [];
  private keyOverflow = false;
  private inData = false;
  private decoder: Base64Decoder | null = null;
  private readonly meta: Uint8Array[] = [];
  private metaSize = 0;
  private started = false;

  private readonly options: { maxMetadataBytes: number };
  constructor(options: { maxMetadataBytes: number }) {
    this.options = options;
  }

  private keep(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.metaSize += bytes.length;
    if (this.metaSize > this.options.maxMetadataBytes) {
      throw new PublishBodyError(
        `Package metadata exceeds ${this.options.maxMetadataBytes} bytes`,
        true,
      );
    }
    // Copy: the caller may reuse its chunk buffer.
    this.meta.push(bytes.slice());
  }

  private atAttachmentData(): { name: string } | null {
    const [root, attachments, attachment] = this.stack;
    if (this.stack.length !== 3 || !root || !attachments || !attachment) return null;
    if (root.type !== "object" || root.key !== "_attachments") return null;
    if (attachments.type !== "object" || attachments.key === null) return null;
    if (attachment.type !== "object" || attachment.key !== "data") return null;
    return { name: attachments.key };
  }

  push(chunk: Uint8Array): ScanEvent[] {
    const events: ScanEvent[] = [];
    let keepFrom = 0;
    let i = 0;
    const n = chunk.length;
    while (i < n) {
      if (this.inData) {
        let end = i;
        while (end < n) {
          const byte = chunk[end]!;
          if (byte === QUOTE) break;
          if (byte === BACKSLASH)
            throw new PublishBodyError("Escapes are not allowed in attachment data");
          end++;
        }
        if (end > i) {
          const bytes = this.decoder!.push(chunk.subarray(i, end));
          if (bytes.length > 0) events.push({ type: "data", bytes });
        }
        if (end === n) {
          i = n;
          keepFrom = n;
          break;
        }
        const tail = this.decoder!.finish();
        if (tail.length > 0) events.push({ type: "data", bytes: tail });
        events.push({ type: "end" });
        this.decoder = null;
        this.inData = false;
        keepFrom = end; // keeps the closing quote
        i = end + 1;
        continue;
      }

      const byte = chunk[i]!;
      if (this.inString) {
        if (this.escape) {
          this.escape = false;
          if (this.stringIsKey) this.collectKey(byte);
        } else if (byte === BACKSLASH) {
          this.escape = true;
          if (this.stringIsKey) this.collectKey(byte);
        } else if (byte === QUOTE) {
          this.inString = false;
          if (this.stringIsKey) {
            const frame = this.stack[this.stack.length - 1]!;
            frame.key = this.keyOverflow
              ? null
              : new TextDecoder().decode(new Uint8Array(this.keyBytes));
          }
        } else if (this.stringIsKey) this.collectKey(byte);
        i++;
        continue;
      }

      const top = this.stack[this.stack.length - 1];
      switch (byte) {
        case 0x20:
        case 0x09:
        case 0x0a:
        case 0x0d:
          break;
        case 0x7b: // {
          if (!this.started) this.started = true;
          else if (!top) throw new PublishBodyError("Trailing data after the JSON document");
          this.stack.push({ type: "object", key: null, expectKey: true });
          break;
        case 0x5b: // [
          if (!this.started) throw new PublishBodyError("The publish body must be a JSON object");
          this.stack.push({ type: "array", key: null, expectKey: false });
          break;
        case 0x7d: // }
        case 0x5d: // ]
          if (!top) throw new PublishBodyError("Malformed JSON");
          this.stack.pop();
          break;
        case 0x3a: // :
          if (top) top.expectKey = false;
          break;
        case 0x2c: // ,
          if (top?.type === "object") top.expectKey = true;
          break;
        case QUOTE: {
          if (!top) throw new PublishBodyError("The publish body must be a JSON object");
          if (top.type === "object" && top.expectKey) {
            this.inString = true;
            this.stringIsKey = true;
            this.keyBytes = [];
            this.keyOverflow = false;
            break;
          }
          const attachment = this.atAttachmentData();
          if (attachment) {
            this.keep(chunk.subarray(keepFrom, i + 1)); // up to the opening quote
            this.inData = true;
            this.decoder = new Base64Decoder();
            events.push({ type: "attachment", name: attachment.name });
            i++;
            keepFrom = i;
            continue;
          }
          this.inString = true;
          this.stringIsKey = false;
          break;
        }
        default:
          if (!this.started) throw new PublishBodyError("The publish body must be a JSON object");
      }
      i++;
    }
    if (!this.inData) this.keep(chunk.subarray(keepFrom));
    return events;
  }

  private collectKey(byte: number): void {
    if (this.keyBytes.length >= MAX_KEY_BYTES) this.keyOverflow = true;
    else this.keyBytes.push(byte);
  }

  /** Parses everything except attachment data. */
  finish(): unknown {
    if (!this.started || this.stack.length > 0 || this.inString || this.inData) {
      throw new PublishBodyError("Truncated JSON body");
    }
    const all = new Uint8Array(this.metaSize);
    let at = 0;
    for (const part of this.meta) {
      all.set(part, at);
      at += part.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(all));
    } catch {
      throw new PublishBodyError("Malformed JSON");
    }
  }
}
