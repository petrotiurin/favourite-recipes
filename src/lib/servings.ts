// The servings picked on a recipe page, shared by the islands that follow it (the picker, which sets it, and "Cook with Claude", which
// writes the prompt for that many people). A store with @preact/signals: both islands import this one module, and Astro's bundle keeps a
// single copy of it in the page. `null` until the picker has loaded; "Cook with Claude" then takes the recipe's own number (what the page
// shows before the picker loads) or, on a recipe with no picker, asks how many are eating.
import { signal } from "@preact/signals";

export const servings = signal<number | null>(null);
