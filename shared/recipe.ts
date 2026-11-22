// The recipe format as zod schemas (docs/typescript-migration.md 4.4): a recipe's frontmatter and its ingredients
// (docs/structured-ingredients.md section 1, root CLAUDE.md "Recipe frontmatter schema"). The site's recipes collection (src/content.config.ts)
// validates every recipes/*.md with `recipeFrontmatterSchema`; the backend writes with the same rules: its tools take `ingredientObject` as
// their input and `ingredientProblems` checks an ingredient the way the build does, with the messages agents act on.
import { z } from "zod";
import { UNITS, sectionIssues, ingredientWhere } from "./ingredient-line.ts";
import { ITEM_ID } from "./catalogue.ts";

export { UNITS };
export const COURSES = ["Breakfast", "Lunch", "Dinner", "Snack", "Drink"] as const;

// --- one ingredient -----------------------------------------------------------------------------------------------------------

const TO_TASTE = /\bto (taste|serve)\b/i;
const RANGE_MESSAGE = "a range is [min, max], both positive, min below max";
const AMOUNT_MESSAGE = "amount must be a positive number (decimals, e.g. 0.75), or a range [min, max]";

/**
 * The fields of an ingredient, with their types and what each means (the descriptions are what an agent reads in the tool's schema). The
 * messages are the ones a write is refused with. No cross-field rules here: `ingredientSchema` adds them.
 */
export const ingredientObject = z.object({
  amount: z
    .union(
      [
        z.number({ error: AMOUNT_MESSAGE }).positive(AMOUNT_MESSAGE),
        z.tuple([z.number({ error: RANGE_MESSAGE }).positive(RANGE_MESSAGE), z.number({ error: RANGE_MESSAGE }).positive(RANGE_MESSAGE)], { error: RANGE_MESSAGE }),
      ],
      { error: (iss) => (Array.isArray(iss.input) ? RANGE_MESSAGE : AMOUNT_MESSAGE) }
    )
    .optional()
    .describe('A number (decimals: 0.75, not ¾) or a range [min, max], e.g. 200, 0.5, [2, 3]. Omit only for "to taste" / "to serve" (say so in the note).'),
  unit: z
    .enum(UNITS, { error: (iss) => `unit "${iss.input}" isn't one of ${UNITS.join(", ")} (none = a count). Convert it, e.g. oz -> g` })
    .optional()
    .describe('One measure per ingredient, metric where the source gives it ("1 cup (200g)" -> 200 g). None = a count ("4 salmon fillets"). juice / zest: "juice of 1 lime" -> amount 1, unit juice, name lime.'),
  name: z.string({ error: "name is empty" }).min(1, "name is empty").describe('What the recipe calls it, plain text (no asterisks), e.g. "jasmine rice". Bolded on the page.'),
  note: z.string().optional().describe('Prep or buying detail after the name, e.g. "finely diced", "about 140g each", "to taste". A split goes here ("1½ tbsp for the salmon, ½ for the pan").'),
  optional: z.literal(true, { error: "optional is true or left out" }).optional().describe('Garnishes and extras ("to serve, optional", "if using"). Shown as ", optional".'),
  section: z
    .string()
    .max(40)
    .optional()
    .describe('Which part of the dish it is for, when the recipe has parts ("Curry sauce", "Pickle", "Marinade"). Shown as a small heading above its lines. Lines of one section sit together, lines without one go first; leave it out on every line when the recipe is one thing. One ingredient used in two parts is two lines, one per section (not a "split" note).'),
  item: z
    .string({ error: (iss) => `item "${iss.input}" isn't a catalogue id (kebab-case)` })
    .optional()
    .describe('The catalogue item it\'s bought as (e.g. "spring-onion"). Leave it out: the server fills it from the name. Set it when a problem asks you to.'),
});

type Raw = Record<string, any>;
const noAmount = (ing: Raw) => ing.amount === undefined || ing.amount === null;
const isRange = (a: unknown): a is [number, number] => Array.isArray(a) && a.length === 2 && a.every((n) => typeof n === "number" && n > 0);

/**
 * The rules that need more than one field or more than a type, each with the message a refused write carries. They all run, even when a
 * field's own type check failed, so every problem comes out at once. A rule never throws on a malformed line (models and files send anything).
 */
function withRules<T extends z.ZodType<Raw>>(base: T): T {
  const rules: [path: string, fails: (ing: Raw) => boolean, message: string | ((ing: Raw) => string)][] = [
    ["name", (i) => typeof i.name === "string" && i.name.length > 0 && !i.name.trim(), "name is empty"],
    ["name", (i) => /\*/.test(i.name || ""), "name must be plain text, the page adds the bold"],
    ["note", (i) => /\*\*/.test(i.note || ""), "note must not contain bold"],
    ["amount", (i) => isRange(i.amount) && !(i.amount[0] < i.amount[1]), RANGE_MESSAGE],
    ["amount", (i) => noAmount(i) && !TO_TASTE.test(i.note || ""), 'every ingredient needs an amount, or a note saying "to taste" / "to serve"'],
    ["amount", (i) => noAmount(i) && i.unit !== undefined && !["pinch", "handful"].includes(i.unit), "a unit needs an amount"],
    ["item", (i) => typeof i.item === "string" && !ITEM_ID.test(i.item), (i) => `item "${i.item}" isn't a catalogue id (kebab-case)`],
  ];
  return rules.reduce<z.ZodType<Raw>>(
    (schema, [path, fails, message]) => schema.refine((ing) => !(ing && typeof ing === "object" && fails(ing)), { error: (iss) => (typeof message === "function" ? message(iss.input as Raw) : message), path: [path], when: () => true }),
    base
  ) as T;
}

export type IngredientInput = z.input<typeof ingredientObject>;
/** An ingredient as the backend's tools take it and the file holds it: `item` is filled by the server when the caller leaves it out. */
export type Ingredient = z.infer<typeof ingredientObject>;

// A file may say `optional: false` (the tools don't offer it, and it means the same as leaving it out).
const looseOptional = z.boolean({ error: "optional is true or left out" }).optional();

/** An ingredient with all its rules; `item` is optional (the backend fills it from the name). */
export const ingredientSchema = withRules(ingredientObject.extend({ optional: looseOptional }));

/** An ingredient in a stored recipe: `item`, the catalogue id it's bought as, is there. */
export const storedIngredientSchema = withRules(ingredientObject.extend({ optional: looseOptional, item: z.string({ error: "no `item` (the catalogue id it's bought as)" }).describe("The catalogue item it's bought as.") }));
export type StoredIngredient = z.infer<typeof storedIngredientSchema>;

/**
 * Problems with one ingredient as the lines the backend refuses a write with: "ingredients[2] (milk): unit \"oz\" isn't one of …", in the
 * order the fields are checked (name, note, unit, amount, optional, item). `null` amounts count as none.
 */
export function ingredientProblems(raw: unknown, i: number): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [`ingredients[${i}]: must be an object`];
  const ing: Raw = { ...raw };
  if (ing.amount === null) delete ing.amount;
  const where = ingredientWhere(ing, i);
  const parsed = ingredientSchema.safeParse(ing);
  if (parsed.success) return [];
  const order = ["name", "note", "unit", "amount", "optional", "item"];
  const rank = (path: PropertyKey[]) => {
    const r = order.indexOf(String(path[0]));
    return r === -1 ? order.length : r;
  };
  return parsed.error.issues
    .map((iss, n) => ({ iss, n }))
    .sort((a, b) => rank(a.iss.path) - rank(b.iss.path) || a.n - b.n)
    .map(({ iss }) => `${where}: ${iss.message}`);
}

// --- a recipe's frontmatter ---------------------------------------------------------------------------------------------------

const positiveInt = z.number().int().positive();

/**
 * The frontmatter of recipes/<slug>.md. `ingredients` is the only place a recipe's ingredients live ([] when none are recorded yet). Anything
 * else in the frontmatter is dropped on parse, so a typo in a key doesn't silently become data.
 */
export const recipeFrontmatterSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1),
  /** Site path of the hero photo, e.g. /images/recipes/<slug>.jpg */
  image: z.string().min(1),
  course: z.array(z.enum(COURSES)).optional(),
  tags: z.array(z.string()).optional(),
  total_mins: positiveInt,
  /** How many people it serves. */
  serves: positiveInt,
  /** kcal per serving. */
  calories: positiveInt,
  /** false hides the servings selector. */
  scalable: z.boolean().optional(),
  /** In this week (being cooked now). */
  current: z.boolean().optional(),
  /** In next week (being planned). */
  next: z.boolean().optional(),
  /** Not tried yet. */
  draft: z.boolean().optional(),
  ingredients: z.array(storedIngredientSchema).superRefine((list, ctx) => {
    for (const { index, message } of sectionIssues(list)) ctx.addIssue({ code: "custom", message, path: [index] });
  }),
});
export type RecipeFrontmatter = z.infer<typeof recipeFrontmatterSchema>;
