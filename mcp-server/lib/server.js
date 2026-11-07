import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { COURSES, config } from "./config.js";
import { createUploadToken } from "./auth.js";
import { WORKFLOWS, WORKFLOW_NAMES } from "./workflows.js";
import { ChangeSet } from "./github.js";
import { slugify } from "./recipe-format.js";
import {
  listRecipes,
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

const INSTRUCTIONS = `Manages the family's "Our Favourite Recipes" website (a static site on GitHub Pages).
Every create/update is committed straight to the main branch and the site redeploys in ~1 minute.

Workflow: when the user hands over recipes to cook or shop for (screenshots, links, pasted recipes, names of recipes we have),
or asks for a shopping list, FIRST call get_workflow_guide({ name: "plan-recipes" }) and follow it step by step. It is the
up-to-date flow (switching weeks, drafts, next week's recipes, servings, shopping list, one batch, summary); it overrides
any older copy of it you may have in a skill. It is also offered as the "plan-recipes" prompt.
When the user asks to shop the list at Ocado or at Sainsbury's (fill the basket/trolley), FIRST call
get_workflow_guide({ name: "ocado-shop" }) or get_workflow_guide({ name: "sainsburys-shop" }) and follow it (also offered as
the prompts of the same names).

One commit = one site deploy, and deploys queue behind each other, so a burst of single-change calls makes the site lag behind for
minutes. Whenever you make MORE THAN ONE change in a go (several recipes, recipes + set_week_recipes, anything + the shopping
list), do the reads first (list_recipes, get_recipe, get_shopping_list), then send all the writes in ONE batch_changes call: it
applies them in order and commits them together. Use batch_changes with dry_run: true first if you want to see warnings before
anything is committed. The single-change tools are fine for one-off edits. Photos uploaded for recipes that don't exist yet don't
trigger a deploy on their own; the create_recipe that follows does.

Two weeks: the site has a THIS WEEK (what the family is cooking now, current: true) and a NEXT WEEK (what they're
planning and shopping for, next: true). A recipe can be in this week, next week, both (cooked two weeks running) or neither.
list_recipes shows current: true / next: true and lists this week first (drafts first), then next week, then the rest.
- New recipes for the plan go into next week: create_recipe with week: "next". Existing recipes are added to (or taken out of)
  a week with set_week_recipes({ week: "this" | "next", slugs, add: true | false }).
- The switch: when the user says next week has started (or, if they forgot, FIRST thing before planning whenever next week
  already has recipes), call start_next_week: next week's recipes become this week, next week is emptied. Before switching, ask
  about this week's drafts (see the plan-recipes workflow): liked -> promote_recipe, didn't like -> remove_draft, not tried ->
  carry_over (stays in this week) or left to drop back into the book.
- The home page shows this week at the top, then the rest of the book. Next week is only shown under its own "Next week" tab;
  a draft that is ONLY in next week is hidden everywhere else until the switch.

Drafts first: a recipe the family hasn't cooked and liked yet should be created as a DRAFT (create_recipe's draft defaults to
true). Drafts get a "To try" kicker on the site. Being a draft says nothing about the week: a draft is in whichever week(s) you put
it in, or in none (then it sits in the book as "To try"). Once the user says they tried it and liked it, call promote_recipe to turn
it into a regular recipe (its weeks don't change). Only pass draft: false to create_recipe when the user says it's already a
tried-and-tested favourite (e.g. migrating an existing family recipe).

A draft the family tried and did NOT like is deleted with remove_draft (the recipe file and its photo). Only drafts can be
removed: a regular recipe can't be deleted through this server. remove_draft also refuses a draft that is planned for next week:
the family keeps those, so tell the user it's still on next week's plan instead.

Shopping list: the site has a separate shopping page for NEXT WEEK's recipes only (this week's food is already bought).
You write it: whenever next week changes (get_shopping_list says "outdated"), read every next-week recipe (get_recipe), combine
the ingredients into one deduplicated list (add up amounts of the same ingredient, e.g. 2 + 1 onions -> 3 onions; use the
recipes' own units; keep different forms such as "garlic cloves" and "garlic powder" separate; skip "to taste" staples only if
clearly pantry basics, else list them without a quantity), group it into shop-aisle sections, and call update_shopping_list.
Tag every item with the slugs of the next-week recipes it is for (recipes: [...]); the page shows their photos on the row, and the
server rejects a slug that isn't in next week or a next-week recipe with no items. The server links the recipes itself.
The page keeps showing the last list you saved until you save a new one: changing the weeks (start_next_week included) never
alters or clears it, so after the switch it simply still shows the list that was built for what is now this week.
Shopping list accuracy rules: build it ONLY from next week's recipes' own ingredient lists, read fresh with get_recipe (never from
memory or the previous list). The list is always for 2 servings of EVERY recipe, whatever its own serves: scale each recipe's
amounts by 2 / serves (serves 4 -> halve, serves 1 -> double, serves 2 -> as written).
Items for several recipes also say how much of that 2-serving quantity each recipe needs (amounts: { slug: number }, in the item's
unit, adding up to quantity), so the page can scale every recipe on its own.
Planned servings: each recipe on the list is planned for a number of people (servings: { slug: n }, 1-${MAX_SERVINGS}). The shopping
page opens on that plan, and the user can switch everything to 1/2/4 or change single recipes there. Pass servings to
update_shopping_list when the user says how many a recipe is for ("the soup just for me", "the pie for two");
recipes you don't name keep their previous plan, else ${DEFAULT_SERVINGS}. To change only the plan later, use set_shopping_servings:
it keeps the list and the stocktake and needs no rebuild.
Every ingredient of every next-week recipe must appear, and nothing else. Add up only the same ingredient in the same unit
(2 + 1 onions -> 3); different forms stay separate (medium vs mild curry powder).
The list is one homogenised list: no per-recipe notes (which recipe an item is for goes in recipes, never in note), and notes never contain amounts (only quantity rescales). Quantities are ONE
number in ONE metric unit per line: convert tbsp/tsp/cups/oz to g or ml (1 tbsp = 15ml, 1 tsp = 5ml; use the ingredient's usual
weight for dry things, e.g. 1 tbsp flour ~ 10g) and add everything up, so "100ml + 3 tbsp" becomes "145ml". Recipes keep their own units;
only the shopping list is converted. The server rejects kitchen measures and sums. Before saving, re-add each
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
- Every recipe needs a hero photo: a real one, or one the server generates. Never invent a placeholder.

Adding the photo, best option first:
1. The recipe came from a web page with a photo of the dish: pass image: { url } with a direct link to it (often the page's og:image).
   A real photo always wins over a generated one.
2. Otherwise (screenshot, pasted text, dictated from memory, or the page has no usable photo): image: { generate: true, description }.
   The server generates a photo from the title and ingredients (10-20s), so don't ask the user for one and don't wait for approval:
   carry on, a photo can always be replaced later. description is optional but helps: one sentence on how the finished dish looks
   as served (e.g. "golden traybake of chicken thighs and potatoes, scattered with parsley"). In batch_changes all generations run
   in parallel. If generation fails, retry once, then fall back to option 3.
3. The user wants to use their own photo, or generation failed: call create_image_upload_link (ONE call listing every recipe that
   needs a photo gives ONE page for all of them), give the user the link, wait for them to say it's all uploaded, then create the
   recipes with image: { uploaded: true }. To swap an existing recipe's photo (e.g. a real one for a generated one), pass its slug.
4. You have the file bytes yourself (e.g. a local file): image: { base64 } — keep it under ~3MB.
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
async function runOperation(op, cs) {
  const { action, ...args } = op;
  const warn = (warnings) => (warnings?.length ? warnings.map((w) => `  warning: ${w}`) : []);
  switch (action) {
    case "create_recipe": {
      const r = await createRecipe(args, cs);
      const tags = [r.draft ? "draft" : null, r.week ? `${r.week} week` : null].filter(Boolean).join(", ");
      return { ...r, nextChanged: r.week === "next", lines: [`Created "${r.slug}"${tags ? ` (${tags})` : ""}: ${pageUrl(r.slug)}`, ...warn(r.warnings)] };
    }
    case "update_recipe": {
      const r = await updateRecipe(args, cs);
      return { ...r, lines: [r.subject ? `${r.subject}: ${pageUrl(r.slug)}` : `"${r.slug}": no changes, it already matches`, ...(r.subject ? warn(r.warnings) : [])] };
    }
    case "promote_recipe": {
      const r = await promoteRecipe(args.slug, cs);
      return { ...r, lines: [`Promoted "${r.slug}" (draft -> regular, its weeks unchanged)`] };
    }
    case "remove_draft": {
      const r = await removeDraft(args.slug, cs);
      return { ...r, lines: [`Removed draft "${r.slug}" (recipe${r.removedImages.length ? " and photo" : ""} deleted)`] };
    }
    case "set_week_recipes": {
      const r = await setWeekRecipes(args.slugs, args.week, args.add, cs);
      return { ...r, nextChanged: args.week === "next" && r.changed.length > 0, lines: weekLines(r) };
    }
    case "start_next_week": {
      const r = await startNextWeek(args.carry_over, cs);
      // Only empties next week, which leaves the saved list showing as it is: nothing to refresh.
      return { ...r, lines: switchLines(r) };
    }
    case "update_shopping_list": {
      const r = await updateShoppingList(args.sections, cs, args.servings);
      const items = r.list.sections.reduce((n, sec) => n + sec.items.length, 0);
      const plan = Object.entries(r.list.servings).map(([slug, n]) => `${slug} x${n}`).join(", ");
      return { ...r, shoppingList: true, lines: [`Shopping list: ${items} items in ${r.list.sections.length} sections, covering ${plan}`] };
    }
    case "set_shopping_servings": {
      const r = await setShoppingServings(args.servings, cs);
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
    ...(droppedDrafts.length ? [`  drafts back in the book (still "To try", in no week): ${droppedDrafts.join(", ")}`] : []),
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

const safe = (fn) => async (args) => {
  try {
    return await fn(args);
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

export function buildServer({ origin }) {
  const server = new McpServer({ name: "favourite-recipes", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_workflow_guide",
    {
      title: "Get workflow guide",
      description:
        "The step-by-step guide for a multi-step job with this server. Call it before starting one and follow it. " +
        WORKFLOW_NAMES.map((n) => `"${n}": ${WORKFLOWS[n].description}`).join(" "),
      inputSchema: { name: z.enum(WORKFLOW_NAMES).describe("Which workflow") },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ name }) => ok(WORKFLOWS[name].text))
  );

  for (const [name, wf] of Object.entries(WORKFLOWS)) {
    server.registerPrompt(
      name,
      {
        title: wf.title,
        description: wf.description,
        argsSchema: {
          request: z.string().optional().describe(wf.request),
        },
      },
      ({ request }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `${wf.text}\n\n---\n\nFollow the workflow above for this request:\n\n${request?.trim() || "(see my message and any attachments)"}`,
            },
          },
        ],
      })
    );
  }

  server.registerTool(
    "list_recipes",
    {
      title: "List recipes",
      description:
        "List every recipe on the site with its slug, title, course, tags, time, servings and calories. " +
        "current: true = in this week, next: true = in next week (a recipe can be in both), draft: true = not tried yet. " +
        "Order: this week (drafts first), then next week, then the rest.",
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
        "promote_recipe once the user has tried and liked them. Pass week: \"next\" to plan it for next week.",
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
        "Its weeks are unchanged: a draft in this week stays in this week.",
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
        "Refuses a draft that is planned for next week (the family keeps those: tell the user instead). " +
        "The shopping list isn't touched (it's for next week, which this draft isn't in).",
      inputSchema: {
        slug: z.string().describe("Slug of the draft recipe (list_recipes shows drafts with draft: true)"),
      },
    },
    safe(async ({ slug }) => {
      const { title, removedImages, commit } = await removeDraft(slug);
      return ok(
        [
          `Removed draft "${title}" (${slug}): deleted recipes/${slug}.md${removedImages.map((p) => ` and ${p}`).join("")}.`,
          `Committed to main: ${commit.url}`,
          `The site updates in about a minute at ${config.siteUrl}/`,
        ].join("\n")
      );
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
    "set_week_recipes",
    {
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
    },
    safe(async ({ week, slugs, add }) => {
      const r = await setWeekRecipes(slugs, week, add);
      const lines = weekLines(r);
      if (r.commit) lines.push(`Committed to main: ${r.commit.url}`, `The site updates in about a minute at ${config.siteUrl}/`);
      if (r.commit && week === "next") lines.push("", "Next week changed: call update_shopping_list to refresh the shopping list.");
      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "start_next_week",
    {
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
    },
    safe(async ({ carry_over }) => {
      const r = await startNextWeek(carry_over);
      const lines = switchLines(r);
      if (r.commit) lines.push(`Committed to main: ${r.commit.url}`, `The site updates in about a minute at ${config.siteUrl}/`);
      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "get_shopping_list",
    {
      title: "Get shopping list",
      description:
        "Show the stored shopping list and whether it is up to date. Status is 'current' (covers exactly next week's recipes), " +
        "'outdated' (next week changed since it was written; the site still shows it, so rewrite it), 'not planned' (next week is " +
        "empty, e.g. just after start_next_week: the page keeps showing the last list) or 'none'. " +
        "Also lists next week's recipes so you know which ones to combine, and the user's " +
        "planned servings per recipe and stocktake: items already at home (have: true) or partly at home (have: <amount in the item's unit>), " +
        "with what is left to buy at the planned servings.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
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
    })
  );

  server.registerTool(
    "update_shopping_list",
    {
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
    },
    safe(async ({ sections, servings }) => ok(shoppingResult(await updateShoppingList(sections, undefined, servings))))
  );

  server.registerTool(
    "set_shopping_servings",
    {
      title: "Set shopping list servings",
      description:
        "Change how many people individual recipes on the saved shopping list are planned for (e.g. one recipe just for 1, another for 2). " +
        "The shopping page opens on this plan and rescales each recipe's share of every item; the user can still pick 1/2/4 for all, or " +
        "change single recipes, on the page. Doesn't rebuild the list: quantities and the stocktake stay. Only recipes on the saved list.",
      inputSchema: { servings: servingsSchema },
    },
    safe(async ({ servings }) => {
      const { list, changed, commit } = await setShoppingServings(servings);
      const lines = commit
        ? [`Saved the planned servings and committed to main: ${commit.url}`, `It will be live in about a minute at ${shoppingPageUrl()}`]
        : ["Nothing changed: those recipes are already planned like that."];
      if (changed.length) lines.push("", `Changed: ${changed.map(([slug, n]) => `${slug} -> ${n}`).join(", ")}`);
      return ok([...lines, "", "Planned servings:", ...servingsLines(list)].join("\n"));
    })
  );

  server.registerTool(
    "batch_changes",
    {
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
    },
    safe(async ({ operations, dry_run }) => {
      const cs = new ChangeSet();
      const results = [];
      for (const [i, op] of startImageGenerations(operations, { dryRun: dry_run }).entries()) {
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
