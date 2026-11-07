import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { COURSES } from "./config.js";
import { WORKFLOWS } from "./workflows.js";
import { TOOLS, accessOf, dispatch, makeCaller } from "./tools.js";
import { DEFAULT_SERVINGS, MAX_SERVINGS } from "./shopping-list.js";

// The /mcp endpoint is the shared-secret agent (docs/chatbot-design.md 4.1): a fixed, frozen caller, never built from request data.
const AGENT = makeCaller({ role: "agent" });

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
- The home page shows this week at the top, then the rest of the book, with a link to a separate Next week page;
  a draft that is ONLY in next week is only on that page until the switch.

Drafts first: a recipe the family hasn't cooked and liked yet should be created as a DRAFT (create_recipe's draft defaults to
true). The site labels recipes by week only; a draft is marked by a line on its own page. Being a draft says nothing about the
week: a draft is in whichever week(s) you put it in, or in none (then it sits in the book). Once the user says they tried it and liked it, call promote_recipe to turn
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

/** The prompts (workflow guides) and the registry's tools, each tool call going through dispatch() as the agent caller. */
export function buildServer({ origin }) {
  const server = new McpServer({ name: "favourite-recipes", version: "1.0.0" }, { instructions: INSTRUCTIONS });

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

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(accessOf(tool) === "read" ? { annotations: { readOnlyHint: true } } : {}),
      },
      (args) => dispatch(tool.name, args, AGENT, { origin })
    );
  }

  return server;
}
