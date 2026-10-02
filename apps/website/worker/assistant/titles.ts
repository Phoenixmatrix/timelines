// Chat titles: a few words from a small model, cleaned up.

/** "Urgent Tasks First" → "Urgent tasks first"; acronyms and names like CI or gm stay. */
export function sentenceCase(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  const titled = words.filter((w) => /^[A-Z][a-z]/.test(w)).length;
  if (words.length < 2 || titled < words.length - 1) return title;
  return words.map((w, i) => (i === 0 || !/^[A-Z][a-z]+$/.test(w) ? w : w.toLowerCase())).join(" ");
}
