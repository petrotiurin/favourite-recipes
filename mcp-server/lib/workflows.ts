import { readFileSync } from "node:fs";

// Agent workflows the server hands out (as MCP prompts and through get_workflow_guide), so the
// steps ship with the server: a deploy updates them for every client, and skills only point here.
// The Markdown lives in workflows/ (bundled into the Vercel functions via vercel.json includeFiles).
// A line `<!-- include: shared/<name> -->` pulls in workflows/shared/<name>.md, so rules shared by
// several workflows (e.g. the shops' picking rules) are written once.

const INCLUDE = /^<!--\s*include:\s*([\w/-]+)\s*-->\s*$/gm;

const read = (name: string, seen: string[] = []): string => {
  if (seen.includes(name)) throw new Error(`workflow include cycle: ${[...seen, name].join(" -> ")}`);
  return readFileSync(new URL(`../workflows/${name}.md`, import.meta.url), "utf8")
    .replace(/^<!--[\s\S]*?-->\s*/, "") // the maintainers' note at the top
    .replace(INCLUDE, (_, inc: string) => read(inc, [...seen, name]))
    .trim();
};

/** The workflows, in the order they are offered. */
export const WORKFLOW_NAMES = ["plan-recipes", "ocado-shop", "sainsburys-shop"] as const;
export type WorkflowName = (typeof WORKFLOW_NAMES)[number];

export interface Workflow {
  title: string;
  description: string;
  /** What the prompt's `request` argument is for. */
  request: string;
  text: string;
}

export const WORKFLOWS: Record<WorkflowName, Workflow> = {
  "plan-recipes": {
    title: "Plan recipes and the shopping list",
    description:
      "The full \"what are we cooking next week\" flow: switch weeks first if next week is already planned (asking about this week's " +
      "drafts), add new recipes to next week as drafts, add existing ones to next week (with planned servings), build next week's " +
      "shopping list in one batch, and summarise.",
    request: "What to cook: recipe links, names of recipes we have, servings (\"the soup just for me\"). Attach screenshots in the chat.",
    text: read("plan-recipes"),
  },
  "ocado-shop": {
    title: "Fill the Ocado basket",
    description:
      "Fill the Ocado basket from the shopping list's \"To buy\" items with Claude in Chrome: favourites first, then search with " +
      "the star cutoff and the family's product rules (free range chicken, lactose-free yoghurt…), never checks out.",
    request: "Anything on top of the shopping list (\"also 2 more avocados\", \"skip the pecans\"), or a pasted list instead of it.",
    text: read("ocado-shop"),
  },
  "sainsburys-shop": {
    title: "Fill the Sainsbury's trolley",
    description:
      "Fill the Sainsbury's trolley from the shopping list's \"To buy\" items with Claude in Chrome: Nectar prices, star cutoff, " +
      "the family's product rules (free range chicken, lactose-free yoghurt…), never checks out.",
    request: "Anything on top of the shopping list (\"also 2 more avocados\", \"skip the pecans\"), or a pasted list instead of it.",
    text: read("sainsburys-shop"),
  },
};

/**
 * The parts of plan-recipes that the chat's editor model needs in its system prompt: the recipe-writing rules ("Writing a recipe that passes
 * first time"), "3. Build the shopping list" and the "In chat" section, which says how the rest maps onto the tray. Cut out by heading, so the
 * MCP-only plumbing (batch_changes, AskUserQuestion, upload links) stays out of the chat prompt.
 */
export function chatGuide() {
  const text = WORKFLOWS["plan-recipes"].text;
  const between = (start: string, end?: string) => {
    const i = text.indexOf(start);
    if (i === -1) throw new Error(`plan-recipes.md has no "${start}" section`);
    const j = end ? text.indexOf(end, i) : text.length;
    return text.slice(i, j === -1 ? text.length : j).trim();
  };
  return [between("### Writing a recipe that passes first time", "**Photos.**"), between("## 3. Build the shopping list (always)", "## 4."), between("## In chat")].join("\n\n");
}

/**
 * The recipe-writing rules ("Writing a recipe that passes first time", rules 1-5) on their own, for the photo reader's prompt
 * (lib/photo-reader-prompt.ts): one source with the chat guide, so the two can't drift.
 */
export function recipeRules() {
  const text = WORKFLOWS["plan-recipes"].text;
  const i = text.indexOf("**1. Ingredients are fields");
  const j = text.indexOf("**Photos.**", i);
  if (i === -1 || j === -1) throw new Error('plan-recipes.md has no recipe-writing rules ("**1. Ingredients are fields" … "**Photos.**")');
  return text.slice(i, j).trim();
}
