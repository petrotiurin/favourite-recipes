import { readFileSync } from "node:fs";

// Agent workflows the server hands out (as MCP prompts and through get_workflow_guide), so the
// steps ship with the server: a deploy updates them for every client, and skills only point here.
// The Markdown lives in workflows/ (bundled into the Vercel functions via vercel.json includeFiles).

const read = (name) =>
  readFileSync(new URL(`../workflows/${name}.md`, import.meta.url), "utf8")
    .replace(/^<!--[\s\S]*?-->\s*/, "") // the maintainers' note at the top
    .trim();

export const WORKFLOWS = {
  "plan-recipes": {
    title: "Plan recipes and the shopping list",
    description:
      "The full \"what are we cooking\" flow: close out last round's recipes, add new ones as drafts, mark existing ones current " +
      "(with planned servings), build the combined shopping list in one batch, and summarise.",
    text: read("plan-recipes"),
  },
};

export const WORKFLOW_NAMES = Object.keys(WORKFLOWS);
