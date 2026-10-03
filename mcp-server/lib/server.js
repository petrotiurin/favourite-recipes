import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { COURSES } from "./config.js";
import { createUploadToken } from "./auth.js";
import { slugify } from "./recipe-format.js";
import {
  listRecipes,
  getRecipe,
  createRecipe,
  updateRecipe,
  promoteRecipe,
  readRecipeImage,
  pageUrl,
  UserError,
} from "./recipes.js";
import { getShoppingList, updateShoppingList, shoppingPageUrl, ShoppingListError } from "./shopping-list.js";

const INSTRUCTIONS = `Manages the family's "Our Favourite Recipes" website (a static site on GitHub Pages).
Every create/update is committed straight to the main branch and the site redeploys in ~1 minute.

Drafts first: a recipe the family hasn't cooked and liked yet should be created as a DRAFT (create_recipe's draft defaults to
true). Drafts are highlighted on the site, listed first and tagged "Draft". Once the user says they tried it and liked it, call
promote_recipe to turn it into a regular recipe. Only pass draft: false to create_recipe when the user says it's already a
tried-and-tested favourite (e.g. migrating an existing family recipe).

Shopping list: the site has a separate shopping page that covers the ingredients of ALL current draft recipes. You write it:
after adding drafts (or when get_shopping_list says it is stale), read every draft (get_recipe), combine the ingredients into one
deduplicated list (add up amounts of the same ingredient, e.g. 2 + 1 onions -> 3 onions; use the recipes' own units; keep
different forms such as "garlic cloves" and "garlic powder" separate; skip "to taste" staples only if clearly pantry basics, else
list them without a quantity), group it into shop-aisle sections, and call update_shopping_list. The server links the drafts
itself. The page is blank whenever the drafts change (a draft is promoted, removed or added), so refresh it after every such change.

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
1. The user has a photo on their phone/computer (or pasted one into chat): call create_image_upload_link, give the user the link,
   wait for them to say it's uploaded, then call create_recipe with image: { uploaded: true }.
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

function shoppingResult({ list, drafts, commit }) {
  const items = list.sections.reduce((n, s) => n + s.items.length, 0);
  return [
    `Saved the shopping list (${items} items in ${list.sections.length} sections, covering ${drafts.length} draft recipe${drafts.length === 1 ? "" : "s"}) and committed to main: ${commit.url}`,
    `It will be live in about a minute at ${shoppingPageUrl()}`,
    "",
    "The page blanks itself as soon as a draft is promoted, removed or added, so call update_shopping_list again after any such change.",
    "",
    "Covers:",
    ...drafts.map((r) => `- ${r.title} (${r.slug})`),
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
        "Drafts (not yet promoted) have draft: true and are listed first.",
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
        "Get a one-time web link (valid 1 hour) the user can open on their phone or computer to upload the recipe's hero photo. " +
        "The photo is resized and committed as images/recipes/<slug>.jpg. For an existing recipe, the recipe is updated to use it automatically. " +
        "For a new recipe, call create_recipe with image: { uploaded: true } after the user confirms the upload. " +
        "Use this whenever the user has the photo (e.g. attached it in chat) but you can't pass it as a URL.",
      inputSchema: {
        title: z.string().optional().describe("Title of the NEW recipe you are about to create (the slug is derived from it)."),
        slug: z.string().optional().describe("Slug of an EXISTING recipe whose photo should be replaced."),
      },
    },
    safe(async ({ title, slug }) => {
      if (!!title === !!slug) throw new UserError("Pass exactly one of: title (new recipe) or slug (existing recipe)");
      let target = slug;
      if (title) {
        target = slugify(title);
        if (!target) throw new UserError("Title must contain letters or numbers");
        const exists = await getRecipe(target).then(() => true, () => false);
        if (exists) throw new UserError(`A recipe with slug "${target}" already exists. Pass slug: "${target}" to replace its photo instead.`);
      } else {
        await getRecipe(target); // throws if it doesn't exist
      }
      const url = `${origin}/upload?t=${createUploadToken(target)}`;
      return ok(
        `Upload link for "${target}" (valid for 1 hour):\n${url}\n\n` +
          `Send this link to the user and ask them to pick the photo there. ` +
          (title
            ? `Once they say it's done, call create_recipe with image: { uploaded: true } and the same title.`
            : `Once they say it's done the recipe already uses the new photo; nothing else to do.`)
      );
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
      inputSchema: {
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
      },
    },
    safe(async (args) => ok(resultText("Created", await createRecipe(args))))
  );

  server.registerTool(
    "promote_recipe",
    {
      title: "Promote draft recipe",
      description:
        "Turn a draft into a regular recipe (the user cooked it and wants to keep it). Removes draft: true from its frontmatter " +
        "in one commit to main; nothing else in the file changes. Fails if the recipe isn't a draft.",
      inputSchema: {
        slug: z.string().describe("Slug of the draft recipe (list_recipes shows drafts with draft: true)"),
      },
    },
    safe(async ({ slug }) => ok(resultText("Promoted", await promoteRecipe(slug))))
  );

  server.registerTool(
    "update_recipe",
    {
      title: "Update recipe",
      description:
        "Edit an existing recipe. Only the fields you pass are changed; ingredients and instructions replace the whole list. " +
        "Pass notes: \"\" to remove the Notes section. The slug (and so the URL) never changes, even if the title does. " +
        "Call get_recipe first so you edit the current version.",
      inputSchema: {
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
      },
    },
    safe(async (args) => ok(resultText("Updated", await updateRecipe(args))))
  );

  server.registerTool(
    "get_shopping_list",
    {
      title: "Get shopping list",
      description:
        "Show the stored shopping list and whether it is current. Status is 'current' (covers exactly today's draft recipes), " +
        "'stale' (drafts were promoted/removed/added since it was written, so the site shows a blank page) or 'none'. " +
        "Also lists the current drafts so you know which recipes to combine.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const { list, drafts, status } = await getShoppingList();
      const lines = [
        `Status: ${status}${status === "stale" ? " (the site shows a blank page until you call update_shopping_list)" : ""}`,
        `Page: ${shoppingPageUrl()}`,
        "",
        drafts.length ? "Current draft recipes:" : "There are no draft recipes right now.",
        ...drafts.map((r) => `- ${r.title} (${r.slug})`),
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
        "Replace the site's shopping page with a combined ingredient list for ALL current draft recipes. " +
        "You do the combining: read each draft with get_recipe, merge duplicate ingredients (add up quantities), and group the items " +
        "into sections such as 'Fresh produce', 'Meat & fish', 'Dairy & eggs', 'Pantry'. The server records which drafts the list covers " +
        "and links them on the page. Commits shopping-list.json to main. The page goes blank automatically when the drafts change, " +
        "so call this again after adding a draft or promoting/removing one. Fails if there are no drafts.",
      inputSchema: {
        sections: z
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
          .describe("The whole list, grouped into shop sections. Replaces whatever list is there."),
      },
    },
    safe(async ({ sections }) => ok(shoppingResult(await updateShoppingList(sections))))
  );

  return server;
}
