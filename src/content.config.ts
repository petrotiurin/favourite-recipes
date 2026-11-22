// The recipes collection: every recipes/*.md, its frontmatter validated by the schema the backend writes with (shared/recipe.ts), plus the
// check against the ingredient catalogue. A recipe that breaks either fails `astro build` with the file and the field named
// (docs/typescript-migration.md 4.4).
import fs from "node:fs";
import path from "node:path";
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { recipeFrontmatterSchema } from "../shared/recipe.ts";
import { catalogueSchema } from "../shared/catalogue.ts";

const CATALOGUE_FILE = path.join(process.cwd(), "data", "ingredients.json");

/** data/ingredients.json, checked against its schema (a broken catalogue fails the build too). */
function loadCatalogue() {
  if (!fs.existsSync(CATALOGUE_FILE)) return {};
  const parsed = catalogueSchema.safeParse(JSON.parse(fs.readFileSync(CATALOGUE_FILE, "utf8")));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`data/ingredients.json doesn't match the catalogue schema:\n- ${problems.join("\n- ")}`);
  }
  return parsed.data;
}

const catalogue = loadCatalogue();

const recipes = defineCollection({
  loader: glob({ pattern: "*.md", base: "./recipes" }),
  // Every ingredient points at an item in the catalogue, so a recipe added by hand with a typo fails the build instead of making a wrong
  // shopping list. The MCP server checks the rest (names, conversions) when it writes a recipe.
  schema: recipeFrontmatterSchema.superRefine((recipe, ctx) => {
    recipe.ingredients.forEach((ing, i) => {
      if (!catalogue[ing.item]) ctx.addIssue({ code: "custom", path: ["ingredients", i, "item"], message: `${ing.name}: item "${ing.item}" isn't in data/ingredients.json` });
    });
  }),
});

export const collections = { recipes };
