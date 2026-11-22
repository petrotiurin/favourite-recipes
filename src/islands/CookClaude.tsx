// "Cook with Claude" (see src/lib/cook-prompt.ts): a pill-shaped link to a new claude.ai chat whose prompt holds the recipe at the servings
// picked. Part of the CookActions island. The recipe comes in as props from the build (`cookRecipe` in src/lib/recipe-text.ts).
import { useLayoutEffect, useState } from "preact/hooks";
import { cookLink, type CookRecipe } from "../lib/cook-prompt.ts";
import { servings } from "../lib/servings.ts";
import Icon from "./Icon.tsx";

export interface CookClaudeProps extends CookRecipe {
  /** Whether the page has the servings picker; without one the prompt asks how many are eating. */
  scalable: boolean;
  /** The recipe page's own address, for the prompt (the build's; the browser's takes over once loaded). */
  pageUrl: string;
}

export default function CookClaude({ scalable, pageUrl, ...recipe }: CookClaudeProps) {
  const [url, setUrl] = useState(pageUrl);
  useLayoutEffect(() => setUrl(location.href.split("#")[0]), []);
  // Until the picker has loaded the page shows the recipe's own amounts.
  const n = scalable ? (servings.value ?? recipe.serves) : null;
  return (
    <a class="pill cook-claude" target="_blank" rel="noopener" aria-label="Cook with Claude (opens Claude)" href={cookLink(recipe, n, url)}>
      <Icon name="external" />
      Cook with Claude
    </a>
  );
}
