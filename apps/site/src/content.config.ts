import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// The docs (CORE-115): Markdown under src/content/docs, one page per file.
// `order` sorts a section's pages in the sidebar.
const docs = defineCollection({
  loader: glob({ base: "./src/content/docs", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    section: z.enum(["Start", "Concepts"]),
    order: z.number(),
  }),
});

export const collections = { docs };
