import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { COURSES, config } from "./config.js";
import { createUploadToken } from "./auth.js";
import { ChangeSet } from "./github.js";
import { slugify } from "./recipe-format.js";
import {
  listRecipes,
  getRecipe,
  createRecipe,
  updateRecipe,
  promoteRecipe,
  removeDraft,
  setCurrentRecipes,
  readRecipeImage,
  pageUrl,
  UserError,
} from "./recipes.js";
import { getShoppingList, updateShoppingList, shoppingPageUrl, ShoppingListError } from "./shopping-list.js";

const INSTRUCTIONS = `Manages the family's "Our Favourite Recipes" website (a static site on GitHub Pages).
Every create/update is committed straight to the main branch and the site redeploys in ~1 minute.

One commit = one site deploy, and deploys queue behind each other, so a burst of single-change calls makes the site lag behind for
minutes. Whenever you make MORE THAN ONE change in a go (several recipes, recipes + set_current_recipes, anything + the shopping
list), do the reads first (list_recipes, get_recipe, get_shopping_list), then send all the writes in ONE batch_changes call: it
applies them in order and commits them together. Use batch_changes with dry_run: true first if you want to see warnings before
anything is committed. The single-change tools are fine for one-off edits. Photos uploaded for recipes that don't exist yet don't
trigger a deploy on their own; the create_recipe that follows does.

Drafts first: a recipe the family hasn't cooked and liked yet should be created as a DRAFT (create_recipe's draft defaults to
true). Drafts are highlighted on the site, listed first and tagged "Draft". Once the user says they tried it and liked it, call
promote_recipe to turn it into a regular recipe. Only pass draft: false to create_recipe when the user says it's already a
tried-and-tested favourite (e.g. migrating an existing family recipe).

A draft the family tried and did NOT like is deleted with remove_draft (the recipe file and its photo). Only drafts can be
removed: a regular recipe can't be deleted through this server. A removed draft was current, so refresh the shopping list afterwards.

Current recipes: the recipes the family is cooking right now. Three tiers, always listed in this order on the site and in
list_recipes: (1) drafts, which are always current, (2) regular recipes marked current, (3) all the others. Mark existing recipes
current (or take them out again) with set_current_recipes; list_recipes shows current: true on every current recipe. A recipe can
be current without being a draft, so the rotation may hold only existing recipes, only drafts, or a mix. Promoting a draft does
NOT change its currency: it stays current (promote_recipe writes current: true) until you unmark it with set_current_recipes.

Shopping list: the site has a separate shopping page that covers the ingredients of ALL current recipes (drafts and current ones).
You write it: whenever the current set changes (get_shopping_list says "outdated"), read every current recipe (get_recipe), combine
the ingredients into one deduplicated list (add up amounts of the same ingredient, e.g. 2 + 1 onions -> 3 onions; use the
recipes' own units; keep different forms such as "garlic cloves" and "garlic powder" separate; skip "to taste" staples only if
clearly pantry basics, else list them without a quantity), group it into shop-aisle sections, and call update_shopping_list.
The server links the recipes itself. The page keeps showing the last list you saved, even if the current set has since changed,
so refresh it after every such change. It goes blank only when no recipe is current (unmarking the last one also deletes the
saved list) or when you replace the list.
Shopping list accuracy rules: build it ONLY from the current recipes' own ingredient lists, read fresh with get_recipe (never from
memory or the previous list). The list is always for 2 servings of EVERY recipe, whatever its own serves: scale each recipe's
amounts by 2 / serves (serves 4 -> halve, serves 1 -> double, serves 2 -> as written).
The site's 1/2/4 servings selector on the shopping page rescales quantity from this 2-serving base.
Every ingredient of every current recipe must appear, and nothing else. Add up only the same ingredient in the same unit
(3 tbsp + 2 tbsp -> 5 tbsp); mixed units stay as "100ml + 3 tbsp"; different forms stay separate (medium vs mild curry powder).
Notes name the recipes an item is for ("gyoza soup, satay salmon") but NEVER contain amounts or scaling remarks ("halved", "x2"):
only quantity rescales, so such notes would go stale. Before saving, re-add each
line against the recipes and make sure the sections cover the same recipes get_shopping_list lists.

Rules the server enforces or expects:
- Ingredients are structured: { quantity, name, note }. Give every ingredient a quantity ("150g (⅔ cup)", "2", "Juice of ½"),
  or put "to taste"/"to serve" in the note. Names are plain text; the server bolds them. Keep them in the order they are used.
- Quantities are rescaled on the site: each recipe page has a servings selector (1, 2, 4 and the recipe's own serves) that
  multiplies every number in the ingredient list. So write amounts as numerals ("2", "½", "1¾", "150g", "2-3"), never words
  ("one", "two"); ASCII fractions like "1/2" are converted to "½" for you. Numbers that must NOT scale: percentages ("0% fat"),
  the per-item size after an "x" ("2 x 150g" scales the 2 only), and anything in a parenthetical containing "each"
  ("(about 120g each)").
- If an ingredient is used in two places, put the split in the ingredient line ("75g sugar, split in half",
  "1 tbsp olive oil, plus 2 tsp for the fish"), and let the instructions refer to the parts.
- Instructions: one action per array item, sentence case, no numbering (the server numbers them).
  Bold EVERY ingredient mention with **double asterisks**, ingredient noun only, e.g. "Stir the **oats** into the **yogurt**".
  Don't bold the dish itself ("the batter", "the burgers").
- Never repeat an amount in the instructions: it won't rescale with the servings selector, so it goes wrong as soon as someone
  cooks for a different number of people. Refer to the ingredient list instead. Wording to use:
    "add 37.5g **sugar**"                 -> "add half the **sugar**"; later "add the remaining **sugar**"
    "heat 1 tbsp **olive oil**"            -> "heat the **olive oil**" (or "heat the **olive oil** for the vegetables")
    "stir in 3 tbsp **flour**"             -> "stir in the **flour**" ("the **flour**, keeping some back for dusting")
    "use a third of the dressing"          -> fine: fractions of a listed amount scale with it ("a third", "half", "the rest")
    "divide the dough into 2 portions"     -> "divide the dough into equal portions, one per person"
    "shape into 4 patties"                 -> "shape into equal patties, one per **burger roll**"
    "press 2 **sausages** on each tortilla" -> "divide the **sausages** evenly between the **tortillas**"
  Keep: times, temperatures, oven/hob settings, pan sizes, and per-item sizes that don't depend on servings
  ("about 50g per patty", "fry 2 slices at a time"). The server warns when a step looks like it repeats an amount.
- scalable: false hides the servings selector. Only use it when the ingredient list genuinely can't be multiplied, e.g. it
  already lists separate amounts per number of people ("One person: 60g rice; Two people: 120g rice").
- course: one or more of ${COURSES.join(", ")}. total_mins = prep + cook. serves is required: if the source doesn't say, estimate and confirm with the user.
- calories is required: kcal per serving. Use the source's figure when it gives one; otherwise estimate from the ingredients and tell the user it's an estimate.
- Every recipe needs a real hero photo. Never invent a placeholder.

Adding the photo, best option first:
1. The user has a photo on their phone/computer (or pasted one into chat): call create_image_upload_link (ONE call listing every
   recipe that needs a photo gives ONE page for all of them), give the user the link, wait for them to say it's all uploaded, then
   create the recipes with image: { uploaded: true }.
2. The recipe came from a web page: pass image: { url } with a direct link to the dish photo (often the page's og:image).
3. You have the file bytes yourself (e.g. a local file): image: { base64 } — keep it under ~3MB.
The server resizes to <=1600px, fixes rotation, strips metadata and stores it as images/recipes/<slug>.jpg.`;

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
    uploaded: z.literal(true).optional().describe("The user already uploaded the photo via create_image_upload_link."),
    url: z.string().url().optional().describe("Direct http(s) link to the photo file."),
    base64: z.string().optional().describe("Base64-encoded image bytes (data: URL prefix allowed). Max ~3MB."),
  })
  .describe("Hero photo. Exactly one of uploaded / url / base64.");

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
            quantity: z.string().optional().describe('Combined amount with units, e.g. "3", "450g", "2 tbsp". Omit for "to taste" items.'),
            note: z.string().optional().describe('Short extra, e.g. "for the fish tacos and the salsa", "finely diced".'),
          })
        )
        .min(1)
    })
  )
  .min(1)
  .describe("The whole list, grouped into shop sections. Replaces whatever list is there.");

const operationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_recipe"), ...createShape }).describe("Same fields as the create_recipe tool"),
  z.object({ action: z.literal("update_recipe"), ...updateShape }).describe("Same fields as the update_recipe tool"),
  z.object({ action: z.literal("promote_recipe"), slug: z.string() }).describe("Same as the promote_recipe tool"),
  z.object({ action: z.literal("remove_draft"), slug: z.string() }).describe("Same as the remove_draft tool"),
  z
    .object({ action: z.literal("set_current_recipes"), slugs: z.array(z.string()).min(1), current: z.boolean() })
    .describe("Same as the set_current_recipes tool"),
  z
    .object({ action: z.literal("update_shopping_list"), sections: sectionsSchema })
    .describe("Same as the update_shopping_list tool. Covers the recipes that are current after the operations before it."),
]);

/** Applies one batch_changes operation to the ChangeSet and returns its report lines. */
async function runOperation(op, cs) {
  const { action, ...args } = op;
  const warn = (warnings) => (warnings?.length ? warnings.map((w) => `  warning: ${w}`) : []);
  switch (action) {
    case "create_recipe": {
      const r = await createRecipe(args, cs);
      return { ...r, currentChanged: true, lines: [`Created "${r.slug}"${r.draft ? " (draft)" : ""}: ${pageUrl(r.slug)}`, ...warn(r.warnings)] };
    }
    case "update_recipe": {
      const r = await updateRecipe(args, cs);
      return { ...r, lines: [r.subject ? `${r.subject}: ${pageUrl(r.slug)}` : `"${r.slug}": no changes, it already matches`, ...(r.subject ? warn(r.warnings) : [])] };
    }
    case "promote_recipe": {
      const r = await promoteRecipe(args.slug, cs);
      return { ...r, lines: [`Promoted "${r.slug}" (draft -> regular, stays current)`] };
    }
    case "remove_draft": {
      const r = await removeDraft(args.slug, cs);
      const lines = [`Removed draft "${r.slug}" (recipe${r.removedImages.length ? " and photo" : ""} deleted)`];
      if (r.clearedShoppingList) lines.push("  no recipe is current any more, so the shopping list is cleared too");
      return { ...r, currentChanged: true, lines };
    }
    case "set_current_recipes": {
      const r = await setCurrentRecipes(args.slugs, args.current, cs);
      const lines = [r.changed.length ? `${args.current ? "Marked current" : "Removed from current"}: ${r.changed.join(", ")}` : "set_current_recipes: nothing changed"];
      if (r.unchanged.length) lines.push(`  already ${args.current ? "current" : "not current"}: ${r.unchanged.join(", ")}`);
      if (r.clearedShoppingList) lines.push("  no recipe is current any more, so the shopping list is cleared too");
      return { ...r, currentChanged: r.changed.length > 0, lines };
    }
    case "update_shopping_list": {
      const r = await updateShoppingList(args.sections, cs);
      const items = r.list.sections.reduce((n, sec) => n + sec.items.length, 0);
      return { ...r, shoppingList: true, lines: [`Shopping list: ${items} items in ${r.list.sections.length} sections, covering ${r.current.map((c) => c.slug).join(", ")}`] };
    }
    default:
      throw new UserError(`Unknown action "${action}"`);
  }
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

const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(err);
  }
};

function shoppingResult({ list, current, commit }) {
  const items = list.sections.reduce((n, s) => n + s.items.length, 0);
  return [
    `Saved the shopping list (${items} items in ${list.sections.length} sections, covering ${current.length} current recipe${current.length === 1 ? "" : "s"}) and committed to main: ${commit.url}`,
    `It will be live in about a minute at ${shoppingPageUrl()}`,
    "",
    "The page keeps showing this list until you call update_shopping_list again, so refresh it whenever the current recipes change. It only goes blank when no recipe is current.",
    "",
    "Covers:",
    ...current.map((r) => `- ${r.title} (${r.slug})${r.draft ? " [draft]" : ""}`),
  ].join("\n");
}

function resultText(verb, { slug, markdown, commit, draft, warnings }) {
  const lines = [];
  if (commit) {
    lines.push(`${verb} "${slug}" and committed to main: ${commit.url}`);
    lines.push(`It will be live in about a minute at ${pageUrl(slug)}`);
  }
  if (draft) {
    lines.push("", `It's a draft. Once the user has cooked it and wants to keep it, call promote_recipe with slug "${slug}".`);
  }
  if (warnings?.length) {
    lines.push("", "Warnings (consider fixing with update_recipe):", ...warnings.map((w) => `- ${w}`));
  }
  lines.push("", "Saved file:", "```markdown", markdown.trimEnd(), "```");
  return lines.join("\n");
}

export function buildServer({ origin }) {
  const server = new McpServer({ name: "favourite-recipes", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_recipes",
    {
      title: "List recipes",
      description:
        "List every recipe on the site with its slug, title, course, tags, time, servings and calories. " +
        "Order: drafts (draft: true), then other current recipes, then the rest. Every current recipe, drafts included, has current: true.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const recipes = await listRecipes();
      return ok(JSON.stringify(recipes, null, 2));
    })
  );

  server.registerTool(
    "get_recipe",
    {
      title: "Get recipe",
      description: "Get one recipe's full Markdown source (frontmatter + body). Optionally include its hero photo so you can see it.",
      inputSchema: {
        slug: z.string().describe("Recipe slug from list_recipes"),
        include_image: z.boolean().optional().describe("Also return the hero image. Default false."),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ slug, include_image }) => {
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
    })
  );

  server.registerTool(
    "create_image_upload_link",
    {
      title: "Create photo upload link",
      description:
        "Get ONE web link (valid 1 hour) the user can open on their phone or computer to upload hero photos for one or more recipes: " +
        "the page lists every recipe and each photo uploads as soon as it's picked. Each photo is resized and committed as " +
        "images/recipes/<slug>.jpg. An existing recipe is switched to its new photo automatically. For a new recipe, create it " +
        "with image: { uploaded: true } (create_recipe or batch_changes) after the user confirms the uploads. " +
        "When several recipes need photos, put them all in one call's recipes list rather than making a link per recipe. " +
        "Use this whenever the user has the photo (e.g. attached it in chat) but you can't pass it as a URL.",
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
    },
    safe(async ({ recipes, title, slug }) => {
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
    })
  );

  server.registerTool(
    "create_recipe",
    {
      title: "Create recipe",
      description:
        "Add a new recipe to the site. Writes recipes/<slug>.md (+ the photo) in one commit to main. The slug is derived from the title. " +
        "Fails if a recipe with that slug already exists. New recipes are drafts by default (recommended): promote them with " +
        "promote_recipe once the user has tried and liked them.",
      inputSchema: createShape,
    },
    safe(async (args) => ok(resultText("Created", await createRecipe(args))))
  );

  server.registerTool(
    "promote_recipe",
    {
      title: "Promote draft recipe",
      description:
        "Turn a draft into a regular recipe (the user cooked it and wants to keep it). Removes draft: true from its frontmatter " +
        "in one commit to main; nothing else in the file changes. Fails if the recipe isn't a draft. " +
        "The recipe's currency is unchanged: it stays current (current: true is written) until you unmark it with set_current_recipes.",
      inputSchema: {
        slug: z.string().describe("Slug of the draft recipe (list_recipes shows drafts with draft: true)"),
      },
    },
    safe(async ({ slug }) => ok(resultText("Promoted", await promoteRecipe(slug))))
  );

  server.registerTool(
    "remove_draft",
    {
      title: "Remove draft recipe",
      description:
        "Delete a draft the family tried and did not like: removes recipes/<slug>.md and its photo in one commit to main. " +
        "ONLY drafts can be removed; it fails for a regular recipe (promote_recipe keeps a liked one). This is permanent on the site " +
        "(it can only be recovered from git history), so only call it when the user said they didn't like it. " +
        "A draft is always current, so the current set changes: refresh the shopping list with update_shopping_list " +
        "(if no recipe is current afterwards, the saved list is deleted too).",
      inputSchema: {
        slug: z.string().describe("Slug of the draft recipe (list_recipes shows drafts with draft: true)"),
      },
    },
    safe(async ({ slug }) => {
      const { title, removedImages, commit, clearedShoppingList } = await removeDraft(slug);
      const lines = [
        `Removed draft "${title}" (${slug}): deleted recipes/${slug}.md${removedImages.map((p) => ` and ${p}`).join("")}.`,
        `Committed to main: ${commit.url}`,
        `The site updates in about a minute at ${config.siteUrl}/`,
        "",
      ];
      if (clearedShoppingList) lines.push("No recipe is current any more, so the shopping list was cleared too.");
      else lines.push("The current set changed: call update_shopping_list to refresh the shopping list.");
      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "update_recipe",
    {
      title: "Update recipe",
      description:
        "Edit an existing recipe. Only the fields you pass are changed; ingredients and instructions replace the whole list. " +
        "Pass notes: \"\" to remove the Notes section. The slug (and so the URL) never changes, even if the title does. " +
        "Call get_recipe first so you edit the current version.",
      inputSchema: updateShape,
    },
    safe(async (args) => ok(resultText("Updated", await updateRecipe(args))))
  );

  server.registerTool(
    "set_current_recipes",
    {
      title: "Set recipes current",
      description:
        "Add regular recipes to the current rotation (current: true) or take them out of it, in one commit to main. Current recipes are " +
        "highlighted on the site, listed after the drafts and before all other recipes, and their ingredients go on the shopping list. " +
        "Drafts are always current and can't be changed here (promote one first, it stays current, then unmark it). Slugs already in the " +
        "requested state are skipped. If nothing is current afterwards, the saved shopping list is deleted too; otherwise call update_shopping_list.",
      inputSchema: {
        slugs: z.array(z.string()).min(1).describe("Slugs from list_recipes"),
        current: z.boolean().describe("true = make current, false = no longer current"),
      },
    },
    safe(async ({ slugs, current }) => {
      const { changed, unchanged, commit, clearedShoppingList } = await setCurrentRecipes(slugs, current);
      const lines = [];
      if (commit) {
        lines.push(`${current ? "Marked current" : "Removed from current"}: ${changed.join(", ")}`, `Committed to main: ${commit.url}`);
        lines.push(`The site updates in about a minute at ${config.siteUrl}/`);
      } else {
        lines.push("Nothing changed.");
      }
      if (unchanged.length) lines.push(`Already ${current ? "current" : "not current"}: ${unchanged.join(", ")}`);
      if (clearedShoppingList) lines.push("", "No recipe is current any more, so the shopping list was cleared too.");
      else if (commit) lines.push("", "The current set changed: call update_shopping_list to refresh the shopping list.");
      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "get_shopping_list",
    {
      title: "Get shopping list",
      description:
        "Show the stored shopping list and whether it is current. Status is 'current' (covers exactly today's draft recipes), " +
        "'outdated' (the current recipes changed since it was written; the site still shows it, so rewrite it) or 'none'. " +
        "Also lists the current recipes (drafts and recipes marked current) so you know which ones to combine.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const { list, current, status } = await getShoppingList();
      const lines = [
        `Status: ${status}${status === "outdated" ? " (the current recipes changed; the site still shows the old list until you call update_shopping_list)" : ""}`,
        `Page: ${shoppingPageUrl()}`,
        "",
        current.length ? "Current recipes (the ones to combine):" : "There are no current recipes right now.",
        ...current.map((r) => `- ${r.title} (${r.slug})${r.draft ? " [draft]" : ""}`),
      ];
      if (list) lines.push("", "Stored list:", "```json", JSON.stringify(list, null, 2), "```");
      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "update_shopping_list",
    {
      title: "Update shopping list",
      description:
        "Replace the site's shopping page with a combined ingredient list for ALL current recipes (drafts and recipes marked current). " +
        "You do the combining: read each current recipe with get_recipe, merge duplicate ingredients (add up quantities), and group the items " +
        "into sections such as 'Fresh produce', 'Meat & fish', 'Dairy & eggs', 'Pantry'. The server records which recipes the list covers " +
        "and links them on the page. Commits shopping-list.json to main. The page keeps showing the saved list until you call this again, " +
        "so call it after adding a draft or marking/unmarking recipes current. It goes blank only when no recipe is current. Fails if there are no current recipes.",
      inputSchema: { sections: sectionsSchema },
    },
    safe(async ({ sections }) => ok(shoppingResult(await updateShoppingList(sections))))
  );

  server.registerTool(
    "batch_changes",
    {
      title: "Batch changes",
      description:
        "Apply several changes in ONE commit to main, so the site deploys once instead of once per change. Operations run in order, " +
        "each seeing the result of the ones before it (e.g. create drafts, mark existing recipes current, then update_shopping_list " +
        "covering all of them). Each operation takes the same fields as the tool it is named after. All or nothing: if any operation " +
        "is rejected, nothing is committed and the error names the operation. dry_run: true validates everything and reports warnings " +
        "without committing.",
      inputSchema: {
        operations: z.array(operationSchema).min(1).describe("Changes to apply, in order"),
        dry_run: z.boolean().optional().describe("Validate and report only; commit nothing. Default false."),
      },
    },
    safe(async ({ operations, dry_run }) => {
      const cs = new ChangeSet();
      const results = [];
      for (const [i, op] of operations.entries()) {
        try {
          results.push(await runOperation(op, cs));
        } catch (err) {
          const prefix = `operations[${i}] (${op.action}) failed, so nothing was committed`;
          if (err instanceof UserError || err instanceof ShoppingListError) throw new err.constructor(`${prefix}:\n${err.message}`);
          throw new Error(`${prefix}: ${err.message}`, { cause: err });
        }
      }

      const report = results.flatMap((r, i) => r.lines.map((l, j) => (j === 0 ? `${i + 1}. ${l}` : `   ${l}`)));
      const lastShopping = results.findLastIndex((r) => r.shoppingList);
      const staleList = results.some((r, i) => r.currentChanged && i > lastShopping) && !results.at(-1).clearedShoppingList;
      const footer = staleList ? ["", "The current recipes changed after the last shopping list update: refresh it with update_shopping_list."] : [];

      if (!cs.size) return ok(["Nothing to commit: every operation was a no-op.", "", ...report].join("\n"));
      if (dry_run) {
        return ok([`Dry run: nothing committed. These ${cs.size} file change(s) would go in one commit:`, ...cs.paths().map((p) => `- ${p}`), "", ...report, ...footer].join("\n"));
      }

      const subjects = results.map((r) => r.subject).filter(Boolean);
      const message =
        subjects.length === 1
          ? `${subjects[0]}\n\nUpdated via the recipes MCP server.`
          : `Batch update: ${subjects.length} changes\n\n${subjects.map((s) => `- ${s}`).join("\n")}\n\nUpdated via the recipes MCP server.`;
      const commit = await cs.commit(message);
      return ok(
        [
          `Committed ${subjects.length} change(s) to main in one commit: ${commit.url}`,
          `The site deploys once and will be live in about a minute at ${config.siteUrl}/`,
          "",
          ...report,
          ...footer,
        ].join("\n")
      );
    })
  );

  return server;
}
