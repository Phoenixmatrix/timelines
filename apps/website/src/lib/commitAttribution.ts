/** Co-authors are claims in Git trailers, not verified Gitmatrix agent identities. */
export function coAuthors(message: string): { name: string; email: string }[] {
  const footer =
    message
      .trim()
      .split(/\r?\n\s*\r?\n/)
      .at(-1) ?? "";
  const people = new Map<string, { name: string; email: string }>();
  for (const line of footer.split(/\r?\n/)) {
    const match = /^Co-authored-by:\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/i.exec(line);
    if (match) people.set(match[2]!.toLowerCase(), { name: match[1]!, email: match[2]! });
  }
  return [...people.values()];
}
