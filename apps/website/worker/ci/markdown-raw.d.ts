// Vite's `?raw` import of a Markdown file, which Vitest's changed-file graph can follow.
declare module "*.md?raw" {
  const text: string;
  export default text;
}
