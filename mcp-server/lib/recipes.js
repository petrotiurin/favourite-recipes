import { config, COURSES, CARD_ASPECT } from "./config.js";
import { ChangeSet, isAllowedPath } from "./github.js";
import { normalizeImage, downloadImage, decodeBase64Image } from "./images.js";
import { generateDishImage } from "./image-generation.js";
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

// Keep in sync with templates/status.js. Two weeks, both independent of `draft`:
//   `current: true` = this week (what's being cooked now), `next: true` = next week (what the shopping list is for).
// A recipe can be in both (cooked two weeks running). Order: this week (drafts first), next week, the rest.
export const isDraft = (r) => r.draft === true;
export const isThisWeek = (r) => r.current === true;
export const isNextWeek = (r) => r.next === true;
const rank = (r) => (isThisWeek(r) ? (isDraft(r) ? 0 : 1) : isNextWeek(r) ? 2 : 3);
export const WEEKS = ["this", "next"];
const WEEK_KEY = { this: "current", next: "next" };
const WEEK_NAME = { this: "this week", next: "next week" };

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
        ...(isThisWeek(data) ? { current: true } : {}),
        ...(isNextWeek(data) ? { next: true } : {}),
      };
    })
  );
  // Same order as the site: this week (drafts first), then next week, then the rest; alphabetical within each.
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

/** Starts generating a dish photo; the error is left for whoever awaits it, so an unused failure isn't an unhandled rejection. */
function startGeneration(recipe) {
  const pending = generateDishImage(recipe);
  pending.catch(() => {});
  return pending;
}

/**
 * Generation takes 10-20s, so batch_changes starts every create_recipe's generation up front and they run in parallel.
 * Each operation then awaits its own in resolveImageInput. (update_recipe generates when it runs: it needs the stored recipe.)
 * A dry run generates nothing: those operations are checked without writing a photo.
 */
export function startImageGenerations(operations, { dryRun = false } = {}) {
  return operations.map((op) => {
    if (!op.image?.generate) return op;
    if (dryRun) return { ...op, image: { ...op.image, skip: true } };
    if (op.action !== "create_recipe") return op;
    return { ...op, image: { ...op.image, pending: startGeneration({ title: op.title, ingredients: op.ingredients, description: op.image.description }) } };
  });
}

/**
 * Turns the tool's image input into a normalised JPEG buffer (or null for "already uploaded").
 * `recipe` ({ title, ingredients }) is what a generated photo is drawn from.
 */
async function resolveImageInput(image, slug, cs, recipe) {
  const provided = ["url", "base64", "uploaded", "generate"].filter((k) => image?.[k]);
  if (provided.length !== 1) {
    throw new UserError("image must have exactly one of: generate: true, url, base64, uploaded: true");
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
  if (image.generate) {
    if (image.skip) return null;
    try {
      const generated = await (image.pending || startGeneration({ ...recipe, description: image.description }));
      return (await normalizeImage(generated, { aspect: CARD_ASPECT })).buffer;
    } catch (err) {
      throw new UserError(
        `Generating the photo for "${slug}" failed (${err.message}). Try again, or fall back to create_image_upload_link and image: { uploaded: true }.`
      );
    }
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

  const imageBuffer = await resolveImageInput(input.image, slug, cs, { title, ingredients: input.ingredients });
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
    ...(input.week ? { [WEEK_KEY[input.week]]: true } : {}),
  };
  const sections = [
    { heading: "Ingredients", content: input.ingredients.map(renderIngredient).join("\n") },
    { heading: "Instructions", content: renderInstructions(input.instructions) },
  ];
  if (input.notes?.trim()) sections.push({ heading: "Notes", content: input.notes.trim() });

  const markdown = serializeRecipe(data, sections);
  cs.write(recipePath(slug), Buffer.from(markdown));
  if (imageBuffer) cs.write(imagePathFor(slug), imageBuffer);

  const subject = `${data.draft ? "Add draft recipe" : "Add recipe"}: ${title}${input.week ? ` (${WEEK_NAME[input.week]})` : ""}`;
  const commit = batch ? null : await cs.commit(subject + via("Added"));
  return { slug, markdown, commit, subject, draft: !!data.draft, week: input.week || null, warnings: instructionWarnings(input.ingredients, input.instructions) };
}

/** Turns a draft into a regular recipe by dropping `draft: true` from its frontmatter. Its weeks are unchanged. */
export async function promoteRecipe(slug, batch) {
  const cs = batch || new ChangeSet();
  const { markdown: before } = await getRecipe(slug, cs);
  const { data, sections } = parseRecipe(before);
  if (data.draft !== true) throw new UserError(`"${slug}" is not a draft, it's already a regular recipe.`);
  delete data.draft;
  const markdown = serializeRecipe(data, sections);
  cs.write(recipePath(slug), Buffer.from(markdown));
  const subject = `Promote recipe: ${data.title} (draft -> regular)`;
  const commit = batch ? null : await cs.commit(subject + via("Promoted"));
  return { slug, markdown, commit, subject };
}

/**
 * Adds recipes to / takes them out of this week (`current: true`) or next week (`next: true`), all in one commit.
 * Drafts and regular recipes alike. A recipe can be in both weeks.
 */
export async function setWeekRecipes(slugs, week, add, batch) {
  if (!WEEKS.includes(week)) throw new UserError(`week must be one of: ${WEEKS.join(", ")}`);
  const key = WEEK_KEY[week];
  const cs = batch || new ChangeSet();
  const unique = [...new Set(slugs)];
  const updates = [];
  const changed = [];
  const unchanged = [];
  const titles = [];
  for (const slug of unique) {
    const { markdown: before } = await getRecipe(slug, cs);
    const { data, sections } = parseRecipe(before);
    if ((data[key] === true) === add) {
      unchanged.push(slug);
      continue;
    }
    if (add) data[key] = true;
    else delete data[key];
    updates.push([recipePath(slug), Buffer.from(serializeRecipe(data, sections))]);
    changed.push(slug);
    titles.push(data.title);
  }
  // Stage only once every slug checked out, so a refused call leaves a batch untouched.
  for (const [path, content] of updates) cs.write(path, content);
  if (!changed.length) return { changed, unchanged, week, add, commit: null, subject: null };

  const verb = `${add ? "Add to" : "Take out of"} ${WEEK_NAME[week]}`;
  const subject = `${verb}: ${titles.length > 3 ? `${titles.length} recipes` : titles.join(", ")}`;
  const commit = batch ? null : await cs.commit(subject + via("Updated"));
  return { changed, unchanged, week, add, commit, subject };
}

/**
 * The switch: next week becomes this week. Every recipe's `current` becomes what its `next` was, and next week
 * is emptied. `carryOver` (slugs that are in this week now, e.g. drafts the family hasn't got round to) stay in
 * this week as well. The shopping list isn't touched: it was built for next week, so it now covers this week and
 * the page keeps showing it until a new next week is planned and a new list saved.
 */
export async function startNextWeek(carryOver = [], batch) {
  const cs = batch || new ChangeSet();
  const recipes = await listRecipes(cs);
  const bySlug = new Map(recipes.map((r) => [r.slug, r]));
  const carry = new Set(carryOver);
  const bad = [...carry].filter((slug) => !bySlug.get(slug)?.current);
  if (bad.length) {
    throw new UserError(`carry_over: ${bad.map((s) => `"${s}"`).join(", ")} ${bad.length === 1 ? "is" : "are"} not in this week, so there's nothing to carry over.`);
  }

  const report = { started: [], stayed: [], carried: [], left: [], droppedDrafts: [] };
  let writes = 0;
  for (const r of recipes) {
    const nowThis = r.next === true || carry.has(r.slug);
    if (r.next && r.current) report.stayed.push(r.slug);
    else if (r.next) report.started.push(r.slug);
    else if (carry.has(r.slug)) report.carried.push(r.slug);
    else if (r.current) (r.draft ? report.droppedDrafts : report.left).push(r.slug);
    if (nowThis === !!r.current && !r.next) continue;
    const { markdown } = await getRecipe(r.slug, cs);
    const { data, sections } = parseRecipe(markdown);
    if (nowThis) data.current = true;
    else delete data.current;
    delete data.next;
    cs.write(recipePath(r.slug), Buffer.from(serializeRecipe(data, sections)));
    writes++;
  }
  const thisWeek = [...report.started, ...report.stayed, ...report.carried];
  const subject = `Start next week (${thisWeek.length} recipe${thisWeek.length === 1 ? "" : "s"} this week)`;
  if (!writes) return { ...report, thisWeek, commit: null, subject: null };
  const commit = batch ? null : await cs.commit(subject + via("Switched"));
  return { ...report, thisWeek, commit, subject };
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
  if (isNextWeek(data)) {
    // The family's rule: a disliked draft that's already planned for next week is kept, and the user is told.
    throw new UserError(
      `"${slug}" is planned for next week, so it isn't removed. Tell the user it's still on next week's plan; if they want it gone, take it out of next week first (set_week_recipes with week: "next", add: false), refresh the shopping list, then remove it.`
    );
  }

  cs.remove(recipePath(slug));
  const removedImages = [];
  for (const path of new Set([String(data.image || "").replace(/^\//, ""), imagePathFor(slug)])) {
    if (path && isAllowedPath(path) && path.startsWith("images/recipes/") && (await cs.read(path))) {
      cs.remove(path);
      removedImages.push(path);
    }
  }

  const subject = `Remove draft recipe: ${data.title}`;
  const commit = batch ? null : await cs.commit(subject + via("Removed"));
  return { slug, title: data.title, removedImages, commit, subject };
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
    const ingredients =
      input.ingredients || ingredientNamesFromSection(sections.find((s) => s.heading?.toLowerCase() === "ingredients")?.content);
    const imageBuffer = await resolveImageInput(input.image, slug, cs, { title: data.title, ingredients });
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
