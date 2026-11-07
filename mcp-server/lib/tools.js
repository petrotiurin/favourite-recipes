// The one tool registry (docs/chatbot-design.md D2, 4.1): every tool the MCP server offers is defined here,
// once, with the access level it needs, and every call goes through dispatch(), which checks the caller's role
// before the handler runs. lib/server.js (MCP) and, later, api/chat.js both consume it.
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { COURSES, config } from "./config.js";
import { createUploadToken } from "./auth.js";
import { WORKFLOWS, WORKFLOW_NAMES } from "./workflows.js";
import { ChangeSet } from "./github.js";
import { slugify } from "./recipe-format.js";
import {
  listRecipes,
  searchRecipes,
  getRecipe,
  createRecipe,
  startImageGenerations,
  updateRecipe,
  promoteRecipe,
  removeDraft,
  setWeekRecipes,
  startNextWeek,
  WEEKS,
  readRecipeImage,
  pageUrl,
  UserError,
} from "./recipes.js";
import {
  getShoppingList,
  updateShoppingList,
  setShoppingServings,
  shoppingPageUrl,
  stocktakeLines,
  servingsLines,
  ShoppingListError,
  DEFAULT_SERVINGS,
  MAX_SERVINGS,
} from "./shopping-list.js";

const ingredientSchema = z.object({
  quantity: z
    .string()
    .optional()
    .describe('Amount including units, as numerals so the servings selector can rescale it, e.g. "150g (⅔ cup)", "2", "Juice of ½", "Small handful of". Omit only for "to taste"/"to serve" items.'),
  name: z.string().min(1).describe('Ingredient name, plain text (no asterisks), e.g. "Greek yogurt". Bolded automatically.'),
  note: z.string().optional().describe('Prep note after the name, e.g. "finely diced", "to taste", "(0% or full-fat)".'),
});

const imageSchema = z
  .object({
    generate: z
      .literal(true)
      .optional()
      .describe("Generate the photo from the recipe (title + ingredients), 10-20s. Use for recipes without a real photo (screenshot, text, memory)."),
    description: z
      .string()
      .max(500)
      .optional()
      .describe('Only with generate: one sentence on how the finished dish looks as served, e.g. "creamy orange soup in a white bowl, swirl of yogurt on top".'),
    uploaded: z.literal(true).optional().describe("The user already uploaded the photo via create_image_upload_link."),
    url: z.string().url().optional().describe("Direct http(s) link to the photo file."),
    base64: z.string().optional().describe("Base64-encoded image bytes (data: URL prefix allowed). Max ~3MB."),
  })
  .describe("Hero photo. Exactly one of generate / url / uploaded / base64.");

const courseSchema = z.array(z.enum(COURSES)).min(1).describe(`One or more of: ${COURSES.join(", ")}`);
const tagsSchema = z.array(z.string().min(1)).describe('Free-text tags, e.g. ["High Protein", "Low Carb"]. Empty array for none.');
const instructionsSchema = z
  .array(z.string().min(1))
  .min(1)
  .describe(
    "Ordered steps, one action each, no numbering. Bold every ingredient mention with **...**. " +
      'Don\'t repeat amounts from the ingredient list: say "the **sugar**", "half the **sugar**", "the remaining **sugar**".'
  );
const scalableSchema = z
  .boolean()
  .describe("Set false only if the ingredient list can't be rescaled (e.g. it lists amounts per number of people). Hides the servings selector.");

const createShape = {
  title: z.string().min(1).describe("Title Case recipe title"),
  course: courseSchema,
  tags: tagsSchema.optional(),
  total_mins: z.number().int().positive().describe("Total time in minutes (prep + cook)"),
  serves: z.number().int().positive().describe("How many people it serves"),
  calories: z.number().int().positive().describe("Calories (kcal) per serving. Use the source's figure, or estimate from the ingredients"),
  scalable: scalableSchema.optional(),
  ingredients: z.array(ingredientSchema).min(1).describe("In the order they're used"),
  instructions: instructionsSchema,
  notes: z.string().optional().describe("Optional free-text Markdown for a '## Notes' section (tips, nutrition, storage)."),
  image: imageSchema,
  draft: z
    .boolean()
    .optional()
    .describe(
      "Default true (recommended): the recipe is added as a highlighted draft until promoted with promote_recipe. " +
        "Pass false only if the user says it's already a tried-and-tested favourite."
    ),
  week: z
    .enum(WEEKS)
    .optional()
    .describe('Put the new recipe straight into a week: "next" for recipes being planned (the usual case, they go on the shopping list), "this" for one being cooked this week. Omit to just add it to the book.'),
};

const updateShape = {
  slug: z.string().describe("Slug of the recipe to edit"),
  title: z.string().min(1).optional(),
  course: courseSchema.optional(),
  tags: tagsSchema.optional(),
  total_mins: z.number().int().positive().optional(),
  serves: z.number().int().positive().optional(),
  calories: z.number().int().positive().optional().describe("Calories (kcal) per serving"),
  scalable: scalableSchema.optional().describe("false hides the servings selector; true turns it back on."),
  ingredients: z.array(ingredientSchema).min(1).optional().describe("Full replacement list, in the order used"),
  instructions: instructionsSchema.optional().describe("Full replacement list of steps. Bold every ingredient mention."),
  notes: z.string().optional(),
  image: imageSchema.optional(),
};

const sectionsSchema = z
  .array(
    z.object({
      name: z.string().min(1).describe('Section heading, e.g. "Fresh produce"'),
      items: z
        .array(
          z.object({
            name: z.string().min(1).describe('Ingredient, plain text, one line per ingredient across the WHOLE list, e.g. "Red onions"'),
            quantity: z.string().optional().describe('ONE combined amount in ONE metric unit: a count ("3"), grams ("450g") or millilitres ("145ml"). No tbsp/tsp/cups/oz and no sums like "100ml + 3 tbsp": convert (1 tbsp = 15ml, 1 tsp = 5ml) and add. Omit for "to taste" items.'),
            note: z.string().optional().describe('Optional buying info only, e.g. "skinless", "70% or higher", "to serve". Never which recipe it is for, and never amounts.'),
            recipes: z
              .array(z.string().min(1))
              .min(1)
              .describe('Slugs of the next-week recipes this item is for, e.g. ["best-ever-caesar-salad", "nutritionist-immunity-lemon-chicken-soup"]. The page shows their photos on the row. Every next-week recipe must appear on at least one item.'),
            amounts: z
              .record(z.string(), z.number().positive())
              .optional()
              .describe('Required when the item is for more than one recipe and has a quantity: how much of the 2-serving quantity each recipe needs, as numbers in the quantity\'s unit, keyed by exactly the slugs in recipes and adding up to quantity. E.g. quantity "3" for two recipes -> { "best-ever-caesar-salad": 2, "nutritionist-immunity-lemon-chicken-soup": 1 }. Lets the page scale each recipe on its own.'),
          })
        )
        .min(1)
    })
  )
  .min(1)
  .describe("The whole list, grouped into shop sections. Replaces whatever list is there.");

const servingsSchema = z
  .record(z.string(), z.number().int().min(1).max(MAX_SERVINGS))
  .describe(`How many people a recipe is planned for this week, by slug, e.g. { "spicy-tuna-loaded-sweet-potato": 1, "creamy-chicken-leek-and-pancetta-pie": 2 }. 1-${MAX_SERVINGS}. The shopping page opens on this plan.`);

const operationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_recipe"), ...createShape }).describe("Same fields as the create_recipe tool"),
  z.object({ action: z.literal("update_recipe"), ...updateShape }).describe("Same fields as the update_recipe tool"),
  z.object({ action: z.literal("promote_recipe"), slug: z.string() }).describe("Same as the promote_recipe tool"),
  z.object({ action: z.literal("remove_draft"), slug: z.string() }).describe("Same as the remove_draft tool"),
  z
    .object({ action: z.literal("set_week_recipes"), week: z.enum(WEEKS), slugs: z.array(z.string()).min(1), add: z.boolean() })
    .describe("Same as the set_week_recipes tool"),
  z
    .object({ action: z.literal("start_next_week"), carry_over: z.array(z.string()).optional() })
    .describe("Same as the start_next_week tool. Put it after the promote_recipe / remove_draft operations for this week's drafts and before anything that plans the new next week."),
  z
    .object({ action: z.literal("update_shopping_list"), sections: sectionsSchema, servings: servingsSchema.optional() })
    .describe("Same as the update_shopping_list tool. Covers the recipes that are in next week after the operations before it."),
  z
    .object({ action: z.literal("set_shopping_servings"), servings: servingsSchema })
    .describe("Same as the set_shopping_servings tool."),
]);

/** Applies one batch_changes operation to the ChangeSet and returns its report lines. */
async function runOperation(op, cs, caller) {
  const { action, ...args } = op;
  const warn = (warnings) => (warnings?.length ? warnings.map((w) => `  warning: ${w}`) : []);
  switch (action) {
    case "create_recipe": {
      const r = await createRecipe(args, cs, caller);
      const tags = [r.draft ? "draft" : null, r.week ? `${r.week} week` : null].filter(Boolean).join(", ");
      return { ...r, nextChanged: r.week === "next", lines: [`Created "${r.slug}"${tags ? ` (${tags})` : ""}: ${pageUrl(r.slug)}`, ...warn(r.warnings)] };
    }
    case "update_recipe": {
      const r = await updateRecipe(args, cs, caller);
      return { ...r, lines: [r.subject ? `${r.subject}: ${pageUrl(r.slug)}` : `"${r.slug}": no changes, it already matches`, ...(r.subject ? warn(r.warnings) : [])] };
    }
    case "promote_recipe": {
      const r = await promoteRecipe(args.slug, cs, caller);
      return { ...r, lines: [`Promoted "${r.slug}" (draft -> regular, its weeks unchanged)`] };
    }
    case "remove_draft": {
      const r = await removeDraft(args.slug, cs, caller);
      return { ...r, lines: [`Removed draft "${r.slug}" (recipe${r.removedImages.length ? " and photo" : ""} deleted)`] };
    }
    case "set_week_recipes": {
      const r = await setWeekRecipes(args.slugs, args.week, args.add, cs, caller);
      return { ...r, nextChanged: args.week === "next" && r.changed.length > 0, lines: weekLines(r) };
    }
    case "start_next_week": {
      const r = await startNextWeek(args.carry_over, cs, caller);
      // Only empties next week, which leaves the saved list showing as it is: nothing to refresh.
      return { ...r, lines: switchLines(r) };
    }
    case "update_shopping_list": {
      const r = await updateShoppingList(args.sections, cs, args.servings, caller);
      const items = r.list.sections.reduce((n, sec) => n + sec.items.length, 0);
      const plan = Object.entries(r.list.servings).map(([slug, n]) => `${slug} x${n}`).join(", ");
      return { ...r, shoppingList: true, lines: [`Shopping list: ${items} items in ${r.list.sections.length} sections, covering ${plan}`] };
    }
    case "set_shopping_servings": {
      const r = await setShoppingServings(args.servings, cs, caller);
      return { ...r, lines: [r.changed.length ? `Planned servings: ${r.changed.map(([slug, n]) => `${slug} x${n}`).join(", ")}` : "set_shopping_servings: already planned like that"] };
    }
    default:
      throw new UserError(`Unknown action "${action}"`);
  }
}

const WEEK_NAME = { this: "this week", next: "next week" };

function weekLines({ changed, unchanged, week, add }) {
  const lines = [changed.length ? `${add ? "Added to" : "Taken out of"} ${WEEK_NAME[week]}: ${changed.join(", ")}` : "set_week_recipes: nothing changed"];
  if (unchanged.length) lines.push(`  already ${add ? "in" : "not in"} ${WEEK_NAME[week]}: ${unchanged.join(", ")}`);
  return lines;
}

function switchLines({ started, stayed, carried, left, droppedDrafts, subject }) {
  const list = (xs) => (xs.length ? xs.join(", ") : "none");
  return [
    subject ? "Started next week: next week's recipes are now this week, and next week is empty." : "start_next_week: nothing to change (both weeks were already empty).",
    `  this week now: ${list([...started, ...stayed, ...carried])}`,
    ...(stayed.length ? [`  (already in this week too: ${stayed.join(", ")})`] : []),
    ...(carried.length ? [`  carried over from last week: ${carried.join(", ")}`] : []),
    ...(left.length ? [`  left this week: ${left.join(", ")}`] : []),
    ...(droppedDrafts.length ? [`  drafts back in the book (still drafts, in no week): ${droppedDrafts.join(", ")}`] : []),
    "  the shopping list is unchanged: the page keeps showing it until next week is planned and a new list saved",
  ];
}

function ok(text, extra = []) {
  return { content: [{ type: "text", text }, ...extra] };
}

function fail(err) {
  const expected = err instanceof UserError || err instanceof ShoppingListError;
  const msg = expected ? err.message : `Server error: ${err.message}`;
  if (!expected) console.error(err);
  return { content: [{ type: "text", text: msg }], isError: true };
}

const safe = (fn) => async (args, ctx) => {
  try {
    return await fn(args, ctx);
  } catch (err) {
    return fail(err);
  }
};

function shoppingResult({ list, next, commit }) {
  const items = list.sections.reduce((n, s) => n + s.items.length, 0);
  return [
    `Saved the shopping list (${items} items in ${list.sections.length} sections, covering ${next.length} next-week recipe${next.length === 1 ? "" : "s"}) and committed to main: ${commit.url}`,
    `It will be live in about a minute at ${shoppingPageUrl()}`,
    "",
    "The page keeps showing this list until you call update_shopping_list again, so refresh it whenever next week's recipes change (the switch to a new week doesn't touch it).",
    "A new list starts without a stocktake: the user marks what's already at home on the page (signed in), and get_shopping_list then shows what's left to buy.",
    "",
    "Covers (planned servings, which the page opens on):",
    ...next.map((r) => `- ${r.title} (${r.slug})${r.draft ? " [draft]" : ""}: ${list.servings[r.slug]}`),
  ].join("\n");
}

function resultText(verb, { slug, markdown, commit, draft, week, warnings }) {
  const lines = [];
  if (commit) {
    lines.push(`${verb} "${slug}" and committed to main: ${commit.url}`);
    lines.push(`It will be live in about a minute at ${pageUrl(slug)}`);
  }
  if (week === "next") lines.push("", "It's in next week: refresh the shopping list with update_shopping_list.");
  if (draft) {
    lines.push("", `It's a draft. Once the user has cooked it and wants to keep it, call promote_recipe with slug "${slug}".`);
  }
  if (warnings?.length) {
    lines.push("", "Warnings (consider fixing with update_recipe):", ...warnings.map((w) => `- ${w}`));
  }
  lines.push("", "Saved file:", "```markdown", markdown.trimEnd(), "```");
  return lines.join("\n");
}


export const TOOLS = [
  {
    name: "get_workflow_guide",
    title: "Get workflow guide",
    description:
      "The step-by-step guide for a multi-step job with this server. Call it before starting one and follow it. " +
      WORKFLOW_NAMES.map((n) => `"${n}": ${WORKFLOWS[n].description}`).join(" "),
    inputSchema: { name: z.enum(WORKFLOW_NAMES).describe("Which workflow") },
    access: "read",
    handler: safe(async ({ name }) => ok(WORKFLOWS[name].text)),
  },
  {
    name: "list_recipes",
    title: "List recipes",
    description:
      "List every recipe on the site with its slug, title, course, tags, time, servings and calories. " +
      "current: true = in this week, next: true = in next week (a recipe can be in both), draft: true = not tried yet. " +
      "Order: this week (drafts first), then next week, then the rest.",
    inputSchema: {},
    access: "read",
    handler: safe(async () => {
      const recipes = await listRecipes();
      return ok(JSON.stringify(recipes, null, 2));
    }),
  },
  {
    name: "search_recipes",
    title: "Search recipes",
    description:
      "Find recipes by what is in them and how they fit: free text (title or method), ingredients to include or leave out " +
      "(matched against the bolded ingredient names, case-insensitive, e.g. \"chicken\"), course, tags, a calorie or time ceiling, " +
      "draft or regular, and which week they are in. All filters are optional and combine (AND). Returns compact rows " +
      "(slug, title, course, tags, total_mins, calories, draft, current, next, url) in the list_recipes order; " +
      "use get_recipe for the full recipe.",
    inputSchema: {
      text: z.string().optional().describe("Words that must all appear in the title or the recipe text"),
      include_ingredients: z.array(z.string().min(1)).optional().describe('Ingredients the recipe must contain, e.g. ["chicken", "lemon"]. Substring match on the bolded ingredient names.'),
      exclude_ingredients: z.array(z.string().min(1)).optional().describe('Ingredients the recipe must NOT contain, e.g. ["nuts", "dairy"]. Substring match on the bolded ingredient names.'),
      course: z.enum(COURSES).optional().describe(`One of: ${COURSES.join(", ")}`),
      tags: z.array(z.string().min(1)).optional().describe('Tags the recipe must all have, e.g. ["High Protein"]'),
      max_calories: z.number().positive().optional().describe("At most this many kcal per serving"),
      max_minutes: z.number().positive().optional().describe("At most this many minutes in total"),
      draft: z.boolean().optional().describe("true = only drafts (not tried yet), false = only regular recipes"),
      week: z.enum(["this", "next", "none"]).optional().describe('"this" = in this week, "next" = in next week, "none" = in neither'),
    },
    access: "read",
    handler: safe(async (args) => {
      const rows = await searchRecipes(args);
      return ok(rows.length ? JSON.stringify(rows, null, 2) : "No recipes match those filters.");
    }),
  },
  {
    name: "get_recipe",
    title: "Get recipe",
    description: "Get one recipe's full Markdown source (frontmatter + body). Optionally include its hero photo so you can see it.",
    inputSchema: {
      slug: z.string().describe("Recipe slug from list_recipes"),
      include_image: z.boolean().optional().describe("Also return the hero image. Default false."),
    },
    access: "read",
    handler: safe(async ({ slug, include_image }) => {
      const { data, markdown } = await getRecipe(slug);
      const extra = [];
      if (include_image) {
        const img = await readRecipeImage(data.image);
        if (img) {
          const ext = String(data.image).split(".").pop().toLowerCase();
          const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
          extra.push({ type: "image", data: img.toString("base64"), mimeType });
        }
      }
      return ok(`Page: ${pageUrl(slug)}\n\n\`\`\`markdown\n${markdown.trimEnd()}\n\`\`\``, extra);
    }),
  },
  {
    name: "create_image_upload_link",
    title: "Create photo upload link",
    description:
      "Get ONE web link (valid 1 hour) the user can open on their phone or computer to upload hero photos for one or more recipes: " +
      "the page lists every recipe and each photo uploads as soon as it's picked. Each photo is resized and committed as " +
      "images/recipes/<slug>.jpg. An existing recipe is switched to its new photo automatically. For a new recipe, create it " +
      "with image: { uploaded: true } (create_recipe or batch_changes) after the user confirms the uploads. " +
      "When several recipes need photos, put them all in one call's recipes list rather than making a link per recipe. " +
      "This is the fallback to image: { generate: true }: use it when the user wants their own photo (e.g. attached it in chat, or to replace " +
      "a generated one) or when generating failed.",
    inputSchema: {
      recipes: z
        .array(
          z.object({
            title: z.string().optional().describe("Title of a NEW recipe you are about to create (the slug is derived from it)."),
            slug: z.string().optional().describe("Slug of an EXISTING recipe whose photo should be replaced."),
          })
        )
        .min(1)
        .max(20)
        .optional()
        .describe("Every recipe that needs a photo, in the order to list them; each item has exactly one of title / slug."),
      title: z.string().optional().describe("Shortcut for a single NEW recipe: same as recipes: [{ title }]."),
      slug: z.string().optional().describe("Shortcut for a single EXISTING recipe: same as recipes: [{ slug }]."),
    },
    access: "write",
    handler: safe(async ({ recipes, title, slug }, { origin }) => {
      if ([recipes, title, slug].filter(Boolean).length !== 1) throw new UserError("Pass exactly one of: recipes, title or slug");
      const requested = recipes || [{ title, slug }];
      const items = [];
      for (const [i, r] of requested.entries()) {
        const where = requested.length > 1 ? `recipes[${i}]: ` : "";
        if (!!r.title === !!r.slug) throw new UserError(`${where}pass exactly one of: title (new recipe) or slug (existing recipe)`);
        if (r.title) {
          const target = slugify(r.title);
          if (!target) throw new UserError(`${where}title must contain letters or numbers`);
          const exists = await getRecipe(target).then(() => true, () => false);
          if (exists) throw new UserError(`${where}a recipe with slug "${target}" already exists. Pass slug: "${target}" to replace its photo instead.`);
          items.push({ slug: target, label: r.title.trim(), isNew: true });
        } else {
          const { data } = await getRecipe(r.slug); // throws if it doesn't exist
          items.push({ slug: r.slug, label: data.title || r.slug, isNew: false });
        }
      }
      const dupe = items.find((it, i) => items.findIndex((o) => o.slug === it.slug) !== i);
      if (dupe) throw new UserError(`"${dupe.slug}" is listed twice`);

      const url = `${origin}/upload?t=${createUploadToken(items.map(({ slug, label }) => ({ slug, label })))}`;
      const newOnes = items.filter((it) => it.isNew);
      const lines = [
        `Upload link for ${items.length === 1 ? `"${items[0].slug}"` : `${items.length} recipes`} (valid for 1 hour, one page for all of them):`,
        url,
        "",
        ...items.map((it, i) => `${i + 1}. ${it.label} (${it.slug})${it.isNew ? " [new recipe]" : " [replaces the current photo]"}`),
        "",
        "Send the user this one link with the numbered list of which photo goes with which recipe, and ask them to tell you when they're all uploaded.",
      ];
      if (newOnes.length) {
        lines.push(
          `Then create the new recipe${newOnes.length === 1 ? "" : "s"} with image: { uploaded: true } and the same title${newOnes.length === 1 ? "" : "s"} ` +
            "(all in one batch_changes call if there are several changes)."
        );
      }
      if (items.length > newOnes.length) lines.push("Existing recipes switch to their new photo as soon as it's uploaded; nothing else to do for them.");
      return ok(lines.join("\n"));
    }),
  },
  {
    name: "create_recipe",
    title: "Create recipe",
    description:
      "Add a new recipe to the site. Writes recipes/<slug>.md (+ the photo) in one commit to main. The slug is derived from the title. " +
      "Fails if a recipe with that slug already exists. New recipes are drafts by default (recommended): promote them with " +
      "promote_recipe once the user has tried and liked them. Pass week: \"next\" to plan it for next week.",
    inputSchema: createShape,
    access: "write",
    handler: safe(async (args, { caller }) => ok(resultText("Created", await createRecipe(args, undefined, caller)))),
  },
  {
    name: "promote_recipe",
    title: "Promote draft recipe",
    description:
      "Turn a draft into a regular recipe (the user cooked it and wants to keep it). Removes draft: true from its frontmatter " +
      "in one commit to main; nothing else in the file changes. Fails if the recipe isn't a draft. " +
      "Its weeks are unchanged: a draft in this week stays in this week.",
    inputSchema: {
      slug: z.string().describe("Slug of the draft recipe (list_recipes shows drafts with draft: true)"),
    },
    access: "write",
    handler: safe(async ({ slug }, { caller }) => ok(resultText("Promoted", await promoteRecipe(slug, undefined, caller)))),
  },
  {
    name: "remove_draft",
    title: "Remove draft recipe",
    description:
      "Delete a draft the family tried and did not like: removes recipes/<slug>.md and its photo in one commit to main. " +
      "ONLY drafts can be removed; it fails for a regular recipe (promote_recipe keeps a liked one). This is permanent on the site " +
      "(it can only be recovered from git history), so only call it when the user said they didn't like it. " +
      "Refuses a draft that is planned for next week (the family keeps those: tell the user instead). " +
      "The shopping list isn't touched (it's for next week, which this draft isn't in).",
    inputSchema: {
      slug: z.string().describe("Slug of the draft recipe (list_recipes shows drafts with draft: true)"),
    },
    access: "write",
    handler: safe(async ({ slug }, { caller }) => {
      const { title, removedImages, commit } = await removeDraft(slug, undefined, caller);
      return ok(
        [
          `Removed draft "${title}" (${slug}): deleted recipes/${slug}.md${removedImages.map((p) => ` and ${p}`).join("")}.`,
          `Committed to main: ${commit.url}`,
          `The site updates in about a minute at ${config.siteUrl}/`,
        ].join("\n")
      );
    }),
  },
  {
    name: "update_recipe",
    title: "Update recipe",
    description:
      "Edit an existing recipe. Only the fields you pass are changed; ingredients and instructions replace the whole list. " +
      "Pass notes: \"\" to remove the Notes section. The slug (and so the URL) never changes, even if the title does. " +
      "Call get_recipe first so you edit the current version.",
    inputSchema: updateShape,
    access: "write",
    handler: safe(async (args, { caller }) => ok(resultText("Updated", await updateRecipe(args, undefined, caller)))),
  },
  {
    name: "set_week_recipes",
    title: "Set this week's / next week's recipes",
    description:
      "Add recipes to this week (current: true) or next week (next: true), or take them out, in one commit to main. Drafts and " +
      "regular recipes alike; a recipe can be in both weeks. This week is shown at the top of the home page; next week only under its " +
      "own tab, and its ingredients are what the shopping list covers, so call update_shopping_list after changing next week. " +
      "Slugs already in the requested state are skipped.",
    inputSchema: {
      week: z.enum(WEEKS).describe('"this" = this week (being cooked now), "next" = next week (being planned, on the shopping list)'),
      slugs: z.array(z.string()).min(1).describe("Slugs from list_recipes"),
      add: z.boolean().describe("true = put them in that week, false = take them out of it"),
    },
    access: "write",
    handler: safe(async ({ week, slugs, add }, { caller }) => {
      const r = await setWeekRecipes(slugs, week, add, undefined, caller);
      const lines = weekLines(r);
      if (r.commit) lines.push(`Committed to main: ${r.commit.url}`, `The site updates in about a minute at ${config.siteUrl}/`);
      if (r.commit && week === "next") lines.push("", "Next week changed: call update_shopping_list to refresh the shopping list.");
      return ok(lines.join("\n"));
    }),
  },
  {
    name: "start_next_week",
    title: "Start next week",
    description:
      "The switch from one week to the next, in one commit: next week's recipes become this week's and next week is emptied. " +
      "Recipes in this week that aren't in next week leave it, except the carry_over ones (e.g. drafts the family hasn't tried yet " +
      "and wants to keep cooking). A draft that leaves goes back into the book, still a draft. Call it when the user says the new " +
      "week has started, and FIRST before planning whenever next week already has recipes. Before calling it, ask about this " +
      "week's drafts and send promote_recipe / remove_draft for them in the same batch_changes, before this operation. " +
      "The shopping list is not touched: it keeps showing until next week is planned and a new list saved.",
    inputSchema: {
      carry_over: z
        .array(z.string())
        .optional()
        .describe("Slugs of recipes in this week now that should stay in this week (e.g. untried drafts the user wants to carry over)."),
    },
    access: "write",
    handler: safe(async ({ carry_over }, { caller }) => {
      const r = await startNextWeek(carry_over, undefined, caller);
      const lines = switchLines(r);
      if (r.commit) lines.push(`Committed to main: ${r.commit.url}`, `The site updates in about a minute at ${config.siteUrl}/`);
      return ok(lines.join("\n"));
    }),
  },
  {
    name: "get_shopping_list",
    title: "Get shopping list",
    description:
      "Show the stored shopping list and whether it is up to date. Status is 'current' (covers exactly next week's recipes), " +
      "'outdated' (next week changed since it was written; the site still shows it, so rewrite it), 'not planned' (next week is " +
      "empty, e.g. just after start_next_week: the page keeps showing the last list) or 'none'. " +
      "Also lists next week's recipes so you know which ones to combine, and the user's " +
      "planned servings per recipe and stocktake: items already at home (have: true) or partly at home (have: <amount in the item's unit>), " +
      "with what is left to buy at the planned servings.",
    inputSchema: {},
    access: "read",
    handler: safe(async () => {
      const { list, next, status } = await getShoppingList();
      const note = {
        outdated: " (next week's recipes changed; the site still shows the old list until you call update_shopping_list)",
        "not planned": " (next week has no recipes yet; the site keeps showing the last list, made for what is now this week)",
      };
      const lines = [
        `Status: ${status}${note[status] || ""}`,
        `Page: ${shoppingPageUrl()}`,
        "",
        next.length ? "Next week's recipes (the ones to combine):" : "Next week has no recipes yet.",
        ...next.map((r) => `- ${r.title} (${r.slug})${r.draft ? " [draft]" : ""}`),
      ];
      if (list) lines.push("", ...stocktakeLines(list), "", "Stored list:", "```json", JSON.stringify(list, null, 2), "```");
      return ok(lines.join("\n"));
    }),
  },
  {
    name: "update_shopping_list",
    title: "Update shopping list",
    description:
      "Replace the site's shopping page with a combined ingredient list for ALL of next week's recipes (next: true). " +
      "You do the combining: read each next-week recipe with get_recipe, merge duplicate ingredients (add up quantities), and group the items " +
      "into sections such as 'Fresh produce', 'Meat & fish', 'Dairy & eggs', 'Pantry'. Tag each item with the slugs of the recipes it is for, " +
      "and for an item with several recipes give each one's share in amounts. Optionally plan servings per recipe. The server records which recipes the list covers " +
      "and links them on the page. Commits shopping-list.json to main. The page keeps showing the saved list until you call this again, " +
      "so call it after changing next week. Fails if next week has no recipes.",
    inputSchema: {
      sections: sectionsSchema,
      servings: servingsSchema
        .optional()
        .describe(`Planned servings for individual recipes, by slug. Recipes left out keep what the previous list planned, else ${DEFAULT_SERVINGS}.`),
    },
    access: "write",
    handler: safe(async ({ sections, servings }, { caller }) => ok(shoppingResult(await updateShoppingList(sections, undefined, servings, caller)))),
  },
  {
    name: "set_shopping_servings",
    title: "Set shopping list servings",
    description:
      "Change how many people individual recipes on the saved shopping list are planned for (e.g. one recipe just for 1, another for 2). " +
      "The shopping page opens on this plan and rescales each recipe's share of every item; the user can still pick 1/2/4 for all, or " +
      "change single recipes, on the page. Doesn't rebuild the list: quantities and the stocktake stay. Only recipes on the saved list.",
    inputSchema: { servings: servingsSchema },
    access: "write",
    handler: safe(async ({ servings }, { caller }) => {
      const { list, changed, commit } = await setShoppingServings(servings, undefined, caller);
      const lines = commit
        ? [`Saved the planned servings and committed to main: ${commit.url}`, `It will be live in about a minute at ${shoppingPageUrl()}`]
        : ["Nothing changed: those recipes are already planned like that."];
      if (changed.length) lines.push("", `Changed: ${changed.map(([slug, n]) => `${slug} -> ${n}`).join(", ")}`);
      return ok([...lines, "", "Planned servings:", ...servingsLines(list)].join("\n"));
    }),
  },
  {
    name: "batch_changes",
    title: "Batch changes",
    description:
      "Apply several changes in ONE commit to main, so the site deploys once instead of once per change. Operations run in order, " +
      "each seeing the result of the ones before it (e.g. start_next_week, create drafts for next week, add existing recipes to next week, then update_shopping_list " +
      "covering all of them). Each operation takes the same fields as the tool it is named after. All or nothing: if any operation " +
      "is rejected, nothing is committed and the error names the operation. dry_run: true validates everything and reports warnings " +
      "without committing (it doesn't generate photos, so image: { generate: true } is only checked).",
    inputSchema: {
      operations: z.array(operationSchema).min(1).describe("Changes to apply, in order"),
      dry_run: z.boolean().optional().describe("Validate and report only; commit nothing. Default false."),
    },
    access: "write",
    handler: safe(async ({ operations, dry_run }, { caller }) => {
      const cs = new ChangeSet();
      const results = [];
      for (const [i, op] of startImageGenerations(operations, { dryRun: dry_run }).entries()) {
        try {
          results.push(await runOperation(op, cs, caller));
        } catch (err) {
          const prefix = `operations[${i}] (${op.action}) failed, so nothing was committed`;
          if (err instanceof UserError || err instanceof ShoppingListError) throw new err.constructor(`${prefix}:\n${err.message}`);
          throw new Error(`${prefix}: ${err.message}`, { cause: err });
        }
      }

      const report = results.flatMap((r, i) => r.lines.map((l, j) => (j === 0 ? `${i + 1}. ${l}` : `   ${l}`)));
      const lastShopping = results.findLastIndex((r) => r.shoppingList);
      const staleList = results.some((r, i) => r.nextChanged && i > lastShopping);
      const footer = staleList ? ["", "Next week's recipes changed after the last shopping list update: refresh it with update_shopping_list."] : [];

      if (!cs.size) return ok(["Nothing to commit: every operation was a no-op.", "", ...report].join("\n"));
      if (dry_run) {
        return ok([`Dry run: nothing committed. These ${cs.size} file change(s) would go in one commit:`, ...cs.paths().map((p) => `- ${p}`), "", ...report, ...footer].join("\n"));
      }

      const subjects = results.map((r) => r.subject).filter(Boolean);
      const message =
        subjects.length === 1
          ? `${subjects[0]}\n\nUpdated via the recipes MCP server.`
          : `Batch update: ${subjects.length} changes\n\n${subjects.map((s) => `- ${s}`).join("\n")}\n\nUpdated via the recipes MCP server.`;
      const commit = await cs.commit(message, caller);
      return ok(
        [
          `Committed ${subjects.length} change(s) to main in one commit: ${commit.url}`,
          `The site deploys once and will be live in about a minute at ${config.siteUrl}/`,
          "",
          ...report,
          ...footer,
        ].join("\n")
      );
    }),
  },
];

// --- dispatch ------------------------------------------------------------------------------------------
// The one place a tool call runs, for MCP and chat alike (docs/chatbot-design.md 4.1 layers 3 and 7).

const WRITER_ROLES = new Set(["editor", "agent"]);
const ACCESS_LEVELS = new Set(["read", "stage", "write"]);

/** The access a tool needs. A missing or unknown level counts as "write": a new tool can't be public by accident. */
export const accessOf = (tool) => (ACCESS_LEVELS.has(tool?.access) ? tool.access : "write");

/** May this role run a tool of this access level? public: read only. editor and agent: everything. */
export const roleMay = (role, access) => access === "read" || WRITER_ROLES.has(role);

/** A frozen caller: { role: "public" | "editor" | "agent", email?, userId?, ip?, via? }. Built by the transport, never from request data. */
export const makeCaller = (caller) => Object.freeze({ ...caller });

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// Who is asking, for the log: role plus email or ip when we have them. Never a token.
const describeCaller = (c) => [`role=${c?.role ?? "none"}`, c?.email && `email=${c.email}`, c?.ip && `ip=${c.ip}`].filter(Boolean).join(" ");

/**
 * Runs a tool for a caller: looks the tool up (unknown name -> error), checks its access level against caller.role
 * (refused -> error result, logged), validates the arguments against its zod schema, then calls the handler.
 * Always resolves to an MCP-shaped result ({ content, isError? }). ctx carries transport details the handlers need ({ origin }).
 */
export async function dispatch(name, args, caller, ctx = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`Unknown tool "${name}".`);
  const access = accessOf(tool);
  if (!caller || typeof caller.role !== "string" || !roleMay(caller.role, access)) {
    console.warn(`Refused tool "${name}" (access ${access}) for ${describeCaller(caller)}`);
    return errorResult(`Not allowed: "${name}" changes the site, so it needs a signed-in editor.`);
  }
  const parsed = z.object(tool.inputSchema).safeParse(args ?? {});
  if (!parsed.success) {
    return errorResult(`Invalid arguments for "${name}": ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return tool.handler(parsed.data, { ...ctx, caller });
}

/**
 * The registry as OpenAI-style function tool definitions (plain JSON Schema, model-agnostic), limited to what the role may call.
 * The model is only offered these, but dispatch() is what actually enforces access.
 */
export function toolDefinitions(role) {
  return TOOLS.filter((t) => roleMay(role, accessOf(t))).map((t) => {
    const { $schema, ...parameters } = zodToJsonSchema(z.object(t.inputSchema), { target: "jsonSchema7", $refStrategy: "none" });
    return { type: "function", function: { name: t.name, description: t.description, parameters } };
  });
}
