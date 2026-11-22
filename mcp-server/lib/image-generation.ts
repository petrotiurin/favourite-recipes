import { config } from "./config.ts";
import { startTrace } from "./langfuse.ts";
import { errorMessage } from "./errors.ts";
import { asRecord } from "./narrow.ts";
import type { DishPromptInput, ReaderUsage } from "./types/photos.ts";
import type { DishSubject } from "./types/recipe.ts";

const GENERATION_TIMEOUT_MS = 120_000; // Muse usually answers in 10-20s; leave room for slow runs
const MAX_PROMPT_INGREDIENTS = 20;

/** Builds the image prompt from the recipe itself, in one fixed style so every generated photo on the site looks alike. */
export function dishPrompt({ title, ingredients = [], description }: DishPromptInput) {
  const names = [...new Set(ingredients.map((i) => i.name.trim()).filter(Boolean))].slice(0, MAX_PROMPT_INGREDIENTS);
  return [
    `A realistic, appetising food photograph of "${title}", a home-cooked dish, finished and ready to eat.`,
    description?.trim() ? `How it looks: ${description.trim()}` : "",
    names.length ? `It is made with: ${names.join(", ")}. Only show ingredients from this list.` : "",
    "Style: natural daylight, shot from a 45-degree angle, plated on a simple plate or bowl on a plain wooden or stone table, " +
      "shallow depth of field, landscape 4:3 framing with the whole dish in the centre of the frame.",
    "No text, labels, watermarks, hands or people.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Generates a dish photo with OpenRouter and returns the raw image bytes (normalise them before saving). */
export async function generateDishImage(recipe: DishSubject) {
  if (!config.openrouterKey) throw new Error("image generation isn't set up on the server (OPENROUTER_API_KEY is missing)");
  const prompt = dishPrompt(recipe);
  // Its own small trace (Langfuse, design 8.1): the photo is made in the background, after the turn that asked for it has finished.
  const trace = startTrace({ name: "generate-recipe-photo", tags: ["image"], input: recipe.title, metadata: { ingredients: recipe.ingredients?.length || 0 } });
  const gen = trace.generation({ name: "generate-image", model: config.imageModel, input: prompt });
  try {
    const { bytes, usage } = await requestImage(prompt);
    gen.end({ output: `[image, ${bytes.length} bytes]`, usage });
    trace.finish(`photo generated (${bytes.length} bytes)`);
    return bytes;
  } catch (err) {
    gen.end({ error: errorMessage(err) });
    trace.finish(`failed: ${errorMessage(err)}`.slice(0, 200));
    throw err;
  }
}

async function requestImage(prompt: string): Promise<{ bytes: Buffer; usage: ReaderUsage | undefined }> {
  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openrouterKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.imageModel, prompt }),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(asRecord(err)?.name === "TimeoutError" ? `${config.imageModel} took longer than ${GENERATION_TIMEOUT_MS / 1000}s` : errorMessage(err));
  }
  const body = asRecord(await res.json().catch((): unknown => null));
  const message = asRecord(body?.error)?.message;
  if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}${message ? `: ${message}` : ""}`);
  const data = body?.data;
  const image = asRecord(Array.isArray(data) ? data[0] : undefined);
  const usage = asRecord(body?.usage);
  if (typeof image?.b64_json === "string" && image.b64_json) return { bytes: Buffer.from(image.b64_json, "base64"), usage };
  if (typeof image?.url === "string" && image.url) {
    const download = await fetch(image.url, { signal: AbortSignal.timeout(30_000) });
    if (!download.ok) throw new Error(`downloading the generated image failed: HTTP ${download.status}`);
    return { bytes: Buffer.from(await download.arrayBuffer()), usage };
  }
  throw new Error("OpenRouter returned no image");
}
