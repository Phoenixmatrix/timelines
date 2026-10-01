// Crockford base32, per the ULID spec.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(len: number): number[] {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (byte) => byte % 32);
}

function incrementRandom(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i]! < 31) {
      digits[i] = digits[i]! + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/** Sortable 26-char ULID, monotonic within a millisecond. */
export function ulid(time: number = Date.now()): string {
  if (time > lastTime) {
    lastTime = time;
    lastRandom = randomDigits(16);
  } else if (!incrementRandom(lastRandom)) {
    lastTime += 1;
    lastRandom = randomDigits(16);
  }
  let out = "";
  let t = lastTime;
  for (let i = 0; i < 10; i++) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  for (const digit of lastRandom) out += ENCODING[digit];
  return out;
}

/** URL-safe random secret with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
