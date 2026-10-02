import { config, COURSES } from "./config.js";
import { readFile, listDir, commitChanges } from "./github.js";
import { normalizeImage, downloadImage, decodeBase64Image } from "./images.js";
import {
  slugify,
  parseRecipe,
  serializeRecipe,
  setSection,
  validateIngredient,
  renderIngredient,
  renderInstructions,
  instructionWarnings,
  trailingText,
  ingredientNamesFromSection,
} from "./recipe-format.js";

const recipePath = (slug) => `recipes/${slug}.md`;
const imagePathFor = (slug, ext = "jpg") => `images/recipes/${slug}.${ext}`;
export const pageUrl = (slug) => `${config.siteUrl}/recipes/${slug}.html`;

export class UserError extends Error {}

function assertSlug(slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new UserError(`"${slug}" is not a valid recipe slug`);
}

export async function listRecipes() {
  const files = (await listDir("recipes")).filter((f) => f.endsWith(".md"));
  const recipes = await Promise.all(
    files.map(async (f) => {
      const { data } = parseRecipe((await readFile(`recipes/${f}`)).toString("utf8"));
      return {
        slug: data.slug,
        title: data.title,
        course: data.course || [],
        tags: data.tags || [],
        total_mins: data.total_mins,
        serves: data.serves,
        calories: data.calories,
        ...(data.scalable === false ? { scalable: false } : {}),
      };
    })
  );
  return recipes.sort((a, b) => a.title.localeCompare(b.title));
}

export async function getRecipe(slug) {
  assertSlug(slug);
  const raw = await readFile(recipePath(slug));
  if (!raw) throw new UserError(`No recipe with slug "${slug}". Use list_recipes to see slugs.`);
  const markdown = raw.toString("utf8");
  const { data } = parseRecipe(markdown);
  return { data, markdown };
}

export async function readRecipeImage(imageFrontmatter) {
  const path = String(imageFrontmatter || "").replace(/^\//, "");
  return path ? readFile(path) : null;
}

/** Turns the tool's image input into a normalised JPEG buffer (or null for "already uploaded"). */
async function resolveImageInput(image, slug) {
  const provided = ["url", "base64", "uploaded"].filter((k) => image?.[k]);
  if (provided.length !== 1) {
    throw new UserError("image must have exactly one of: url, base64, uploaded: true");
  }
  if (image.uploaded) {
    const existing = await readFile(imagePathFor(slug));
    if (!existing) {
      throw new UserError(
        `No uploaded image found at ${imagePathFor(slug)} yet. Ask the user to finish uploading via the link from create_image_upload_link, then try again.`
      );
    }
    return null;
  }
  const source = image.url ? await downloadImage(image.url) : decodeBase64Image(image.base64);
  try {
    return (await normalizeImage(source)).buffer;
  } catch (err) {
    throw new UserError(err.message);
  }
}

function validateCommon({ course, total_mins, serves, calories, ingredients, instructions }) {
  const errors = [];
  if (course) {
    const bad = course.filter((c) => !COURSES.includes(c));
    if (bad.length) errors.push(`course: ${bad.join(", ")} not allowed (use ${COURSES.join(", ")})`);
    if (!course.length) errors.push("course: pick at least one");
  }
  if (total_mins !== undefined && !(Number.isInteger(total_mins) && total_mins > 0)) errors.push("total_mins must be a positive whole number");
  if (serves !== undefined && !(Number.isInteger(serves) && serves > 0)) errors.push("serves must be a positive whole number");
  if (calories !== undefined && !(Number.isInteger(calories) && calories > 0)) errors.push("calories must be a positive whole number (kcal per serving)");
  if (ingredients) {
    if (!ingredients.length) errors.push("ingredients: at least one is required");
    ingredients.forEach((ing, i) => errors.push(...validateIngredient(ing, i)));
  }
  if (instructions) {
    if (!instructions.length) errors.push("instructions: at least one step is required");
    instructions.forEach((s, i) => {
      if (!s.trim()) errors.push(`instructions[${i}] is empty`);
      if (/\n/.test(s.trim())) errors.push(`instructions[${i}]: one step per array item, no line breaks`);
    });
  }
  if (errors.length) throw new UserError(`Recipe rejected:\n- ${errors.join("\n- ")}`);
}

function tidyTags(tags) {
  return [...new Set((tags || []).map((t) => t.trim()).filter(Boolean))];
}

export async function createRecipe(input) {
  const title = input.title.trim();
  const slug = slugify(title);
  if (!slug) throw new UserError("Title must contain letters or numbers");
  validateCommon(input);

  if (await readFile(recipePath(slug))) {
    throw new UserError(`A recipe with slug "${slug}" already exists. Use update_recipe to change it, or pick a different title.`);
  }

  const imageBuffer = await resolveImageInput(input.image, slug);
  const data = {
    title,
    slug,
    image: `/${imagePathFor(slug)}`,
    course: input.course,
    tags: tidyTags(input.tags),
    total_mins: input.total_mins,
    serves: input.serves,
    calories: input.calories,
    ...(input.scalable === false ? { scalable: false } : {}),
  };
  const sections = [
    { heading: "Ingredients", content: input.ingredients.map(renderIngredient).join("\n") },
    { heading: "Instructions", content: renderInstructions(input.instructions) },
  ];
  if (input.notes?.trim()) sections.push({ heading: "Notes", content: input.notes.trim() });

  const markdown = serializeRecipe(data, sections);
  const changes = [{ path: recipePath(slug), content: Buffer.from(markdown) }];
  if (imageBuffer) changes.push({ path: imagePathFor(slug), content: imageBuffer });

  const commit = await commitChanges(changes, `Add recipe: ${title}\n\nAdded via the recipes MCP server.`);
  return { slug, markdown, commit, warnings: instructionWarnings(input.ingredients, input.instructions) };
}

export async function updateRecipe(input) {
  const { slug } = input;
  const { markdown: before } = await getRecipe(slug);
  validateCommon(input);

  const { data, sections } = parseRecipe(before);
  const changes = [];
  const summary = [];

  if (input.title !== undefined) { data.title = input.title.trim(); summary.push("title"); }
  if (input.course !== undefined) { data.course = input.course; summary.push("course"); }
  if (input.tags !== undefined) { data.tags = tidyTags(input.tags); summary.push("tags"); }
  if (input.total_mins !== undefined) { data.total_mins = input.total_mins; summary.push("time"); }
  if (input.serves !== undefined) { data.serves = input.serves; summary.push("serves"); }
  if (input.calories !== undefined) { data.calories = input.calories; summary.push("calories"); }
  if (input.scalable !== undefined) {
    if (input.scalable === false) data.scalable = false;
    else delete data.scalable; // scaling is the default, so drop the key
    summary.push("scalable");
  }

  if (input.ingredients !== undefined) {
    setSection(sections, "Ingredients", input.ingredients.map(renderIngredient).join("\n"));
    summary.push("ingredients");
  }
  if (input.instructions !== undefined) {
    const existing = sections.find((s) => s.heading?.toLowerCase() === "instructions");
    const tail = existing ? trailingText(existing.content) : "";
    const content = renderInstructions(input.instructions) + (tail ? `\n\n${tail}` : "");
    setSection(sections, "Instructions", content, { after: "Ingredients" });
    summary.push("instructions");
  }
  if (input.notes !== undefined) {
    setSection(sections, "Notes", input.notes?.trim() ? input.notes.trim() : null, { after: "Instructions" });
    summary.push("notes");
  }

  if (input.image !== undefined) {
    const imageBuffer = await resolveImageInput(input.image, slug);
    const newPath = imagePathFor(slug);
    if (imageBuffer) changes.push({ path: newPath, content: imageBuffer });
    const oldPath = String(data.image || "").replace(/^\//, "");
    if (oldPath && oldPath !== newPath && oldPath.startsWith("images/recipes/")) changes.push({ path: oldPath, delete: true });
    data.image = `/${newPath}`;
    summary.push("image");
  }

  if (!summary.length) throw new UserError("Nothing to update: pass at least one field to change");

  const markdown = serializeRecipe(data, sections);
  if (markdown !== before) changes.unshift({ path: recipePath(slug), content: Buffer.from(markdown) });
  if (!changes.length) return { slug, markdown, commit: null, warnings: ["No changes: the recipe already matches"] };

  const commit = await commitChanges(changes, `Update recipe: ${data.title} (${summary.join(", ")})\n\nUpdated via the recipes MCP server.`);

  const ingredientsForCheck =
    input.ingredients || ingredientNamesFromSection(sections.find((s) => s.heading?.toLowerCase() === "ingredients")?.content);
  const warnings = input.instructions ? instructionWarnings(ingredientsForCheck, input.instructions) : [];
  return { slug, markdown, commit, warnings };
}

/**
 * Called by the phone upload page. Commits images/recipes/<slug>.jpg and, if
 * the recipe already exists with a different image path (e.g. an old .webp),
 * repoints its frontmatter and removes the old file in the same commit.
 */
export async function saveUploadedImage(slug, rawBuffer) {
  assertSlug(slug);
  const { buffer } = await normalizeImage(rawBuffer);
  const newPath = imagePathFor(slug);
  const changes = [{ path: newPath, content: buffer }];

  const existing = await readFile(recipePath(slug));
  let title = slug;
  if (existing) {
    const { data, sections } = parseRecipe(existing.toString("utf8"));
    title = data.title;
    const oldPath = String(data.image || "").replace(/^\//, "");
    if (oldPath !== newPath) {
      data.image = `/${newPath}`;
      changes.push({ path: recipePath(slug), content: Buffer.from(serializeRecipe(data, sections)) });
      if (oldPath.startsWith("images/recipes/")) changes.push({ path: oldPath, delete: true });
    }
  }
  const verb = existing ? "Update" : "Add";
  return commitChanges(changes, `${verb} photo: ${title}\n\nUploaded via the recipes MCP server.`);
}
