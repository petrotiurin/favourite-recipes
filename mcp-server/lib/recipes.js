import { config, COURSES, SHOPPING_LIST_PATH } from "./config.js";
import { ChangeSet, isAllowedPath } from "./github.js";
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

// Keep in sync with templates/status.js: drafts are always current, `current: true` marks regular recipes in the rotation.
export const isDraft = (r) => r.draft === true;
export const isCurrent = (r) => r.draft === true || r.current === true;
const rank = (r) => (isDraft(r) ? 0 : isCurrent(r) ? 1 : 2);

function assertSlug(slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new UserError(`"${slug}" is not a valid recipe slug`);
}

// Every function that reads or writes takes an optional ChangeSet: reads see what it has staged,
// writes are staged into it. Without one, the function commits its own changes straight away;
// with one (batch_changes), the caller commits everything together.
const via = (verb) => `\n\n${verb} via the recipes MCP server.`;

export async function listRecipes(cs = new ChangeSet()) {
  const files = (await cs.list("recipes")).filter((f) => f.endsWith(".md"));
  const recipes = await Promise.all(
    files.map(async (f) => {
      const { data } = parseRecipe((await cs.read(`recipes/${f}`)).toString("utf8"));
      return {
        slug: data.slug,
        title: data.title,
        course: data.course || [],
        tags: data.tags || [],
        total_mins: data.total_mins,
        serves: data.serves,
        calories: data.calories,
        ...(data.scalable === false ? { scalable: false } : {}),
        ...(data.draft === true ? { draft: true } : {}),
        ...(isCurrent(data) ? { current: true } : {}), // drafts are always current
      };
    })
  );
  // Same order as the site: drafts, then current recipes, then the rest; alphabetical within each.
  return recipes.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}

export async function getRecipe(slug, cs = new ChangeSet()) {
  assertSlug(slug);
  const raw = await cs.read(recipePath(slug));
  if (!raw) throw new UserError(`No recipe with slug "${slug}". Use list_recipes to see slugs.`);
  const markdown = raw.toString("utf8");
  const { data } = parseRecipe(markdown);
  return { data, markdown };
}

export async function readRecipeImage(imageFrontmatter) {
  const path = String(imageFrontmatter || "").replace(/^\//, "");
  return path ? new ChangeSet().read(path) : null;
}

/** Turns the tool's image input into a normalised JPEG buffer (or null for "already uploaded"). */
async function resolveImageInput(image, slug, cs) {
  const provided = ["url", "base64", "uploaded"].filter((k) => image?.[k]);
  if (provided.length !== 1) {
    throw new UserError("image must have exactly one of: url, base64, uploaded: true");
  }
  if (image.uploaded) {
    const existing = await cs.read(imagePathFor(slug));
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

export async function createRecipe(input, batch) {
  const cs = batch || new ChangeSet();
  const title = input.title.trim();
  const slug = slugify(title);
  if (!slug) throw new UserError("Title must contain letters or numbers");
  validateCommon(input);

  if (await cs.read(recipePath(slug))) {
    throw new UserError(`A recipe with slug "${slug}" already exists. Use update_recipe to change it, or pick a different title.`);
  }

  const imageBuffer = await resolveImageInput(input.image, slug, cs);
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
    ...(input.draft !== false ? { draft: true } : {}), // new recipes start as drafts unless told otherwise
  };
  const sections = [
    { heading: "Ingredients", content: input.ingredients.map(renderIngredient).join("\n") },
    { heading: "Instructions", content: renderInstructions(input.instructions) },
  ];
  if (input.notes?.trim()) sections.push({ heading: "Notes", content: input.notes.trim() });

  const markdown = serializeRecipe(data, sections);
  cs.write(recipePath(slug), Buffer.from(markdown));
  if (imageBuffer) cs.write(imagePathFor(slug), imageBuffer);

  const subject = `${data.draft ? "Add draft recipe" : "Add recipe"}: ${title}`;
  const commit = batch ? null : await cs.commit(subject + via("Added"));
  return { slug, markdown, commit, subject, draft: !!data.draft, warnings: instructionWarnings(input.ingredients, input.instructions) };
}

/** Turns a draft into a regular recipe by dropping `draft: true` from its frontmatter. */
export async function promoteRecipe(slug, batch) {
  const cs = batch || new ChangeSet();
  const { markdown: before } = await getRecipe(slug, cs);
  const { data, sections } = parseRecipe(before);
  if (data.draft !== true) throw new UserError(`"${slug}" is not a draft, it's already a regular recipe.`);
  delete data.draft;
  data.current = true; // drafts are implicitly current, so promoting keeps the recipe in the rotation
  const markdown = serializeRecipe(data, sections);
  cs.write(recipePath(slug), Buffer.from(markdown));
  const subject = `Promote recipe: ${data.title} (draft -> regular)`;
  const commit = batch ? null : await cs.commit(subject + via("Promoted"));
  return { slug, markdown, commit, subject };
}

/**
 * Nothing current any more -> the shopping list goes too (staged in the same commit), so an old list
 * can't reappear when something else becomes current later. Returns whether it was removed.
 */
async function clearShoppingListIfNoneCurrent(cs) {
  const stillCurrent = (await listRecipes(cs)).filter(isCurrent);
  if (stillCurrent.length || !(await cs.read(SHOPPING_LIST_PATH))) return false;
  cs.remove(SHOPPING_LIST_PATH);
  return true;
}

/**
 * Adds regular recipes to / removes them from the current rotation (`current: true`),
 * all in one commit. Drafts are always current, so they can't be added or removed here.
 */
export async function setCurrentRecipes(slugs, current, batch) {
  const cs = batch || new ChangeSet();
  const unique = [...new Set(slugs)];
  const updates = [];
  const changed = [];
  const unchanged = [];
  const titles = [];
  for (const slug of unique) {
    const { markdown: before } = await getRecipe(slug, cs);
    const { data, sections } = parseRecipe(before);
    if (data.draft === true) {
      throw new UserError(
        current
          ? `"${slug}" is a draft, and drafts are always current already.`
          : `"${slug}" is a draft, and drafts are always current. Promote it with promote_recipe once it's tried (it stays current), then unmark it.`
      );
    }
    if ((data.current === true) === current) {
      unchanged.push(slug);
      continue;
    }
    if (current) data.current = true;
    else delete data.current;
    updates.push([recipePath(slug), Buffer.from(serializeRecipe(data, sections))]);
    changed.push(slug);
    titles.push(data.title);
  }
  // Stage only once every slug checked out, so a refused call leaves a batch untouched.
  for (const [path, content] of updates) cs.write(path, content);
  if (!changed.length) return { changed, unchanged, commit: null, subject: null, clearedShoppingList: false };

  const clearedShoppingList = current ? false : await clearShoppingListIfNoneCurrent(cs);
  const verb = current ? "Make current" : "Remove from current";
  const subject = `${verb}: ${titles.length > 3 ? `${titles.length} recipes` : titles.join(", ")}`;
  const commit = batch ? null : await cs.commit(subject + via("Updated"));
  return { changed, unchanged, commit, subject, clearedShoppingList };
}

/**
 * Deletes a draft the family didn't like: recipes/<slug>.md and its photo, in one commit. Only drafts can be
 * removed (a safety net: regular recipes are the family's keepers and can't be deleted through the server).
 */
export async function removeDraft(slug, batch) {
  const cs = batch || new ChangeSet();
  const { markdown } = await getRecipe(slug, cs);
  const { data } = parseRecipe(markdown);
  if (data.draft !== true) {
    throw new UserError(`"${slug}" is not a draft, so it can't be removed. Only drafts (recipes nobody has tried yet) can be removed through the server.`);
  }

  cs.remove(recipePath(slug));
  const removedImages = [];
  for (const path of new Set([String(data.image || "").replace(/^\//, ""), imagePathFor(slug)])) {
    if (path && isAllowedPath(path) && path.startsWith("images/recipes/") && (await cs.read(path))) {
      cs.remove(path);
      removedImages.push(path);
    }
  }

  // Drafts are always current, so removing the last current recipe leaves nothing to shop for.
  const clearedShoppingList = await clearShoppingListIfNoneCurrent(cs);
  const subject = `Remove draft recipe: ${data.title}`;
  const commit = batch ? null : await cs.commit(subject + via("Removed"));
  return { slug, title: data.title, removedImages, commit, subject, clearedShoppingList };
}

export async function updateRecipe(input, batch) {
  const cs = batch || new ChangeSet();
  const { slug } = input;
  const { markdown: before } = await getRecipe(slug, cs);
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
    const imageBuffer = await resolveImageInput(input.image, slug, cs);
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
  if (!changes.length) return { slug, markdown, commit: null, subject: null, warnings: ["No changes: the recipe already matches"] };

  for (const c of changes) (c.delete ? cs.remove(c.path) : cs.write(c.path, c.content));
  const subject = `Update recipe: ${data.title} (${summary.join(", ")})`;
  const commit = batch ? null : await cs.commit(subject + via("Updated"));

  const ingredientsForCheck =
    input.ingredients || ingredientNamesFromSection(sections.find((s) => s.heading?.toLowerCase() === "ingredients")?.content);
  const warnings = input.instructions ? instructionWarnings(ingredientsForCheck, input.instructions) : [];
  return { slug, markdown, commit, subject, warnings };
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
  const cs = new ChangeSet();
  cs.write(newPath, buffer);

  const existing = await cs.read(recipePath(slug));
  let title = slug;
  if (existing) {
    const { data, sections } = parseRecipe(existing.toString("utf8"));
    title = data.title;
    const oldPath = String(data.image || "").replace(/^\//, "");
    if (oldPath !== newPath) {
      data.image = `/${newPath}`;
      cs.write(recipePath(slug), Buffer.from(serializeRecipe(data, sections)));
      if (oldPath.startsWith("images/recipes/")) cs.remove(oldPath);
    }
  }
  // A photo for a recipe that doesn't exist yet isn't on any page, so don't spend a site deploy on it:
  // [skip ci] stops the Pages workflow, and the create_recipe commit that follows deploys it.
  const subject = existing ? `Update photo: ${title}` : `Add photo: ${title} [skip ci]`;
  return cs.commit(subject + via("Uploaded"));
}
