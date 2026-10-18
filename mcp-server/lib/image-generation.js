import { config } from "./config.js";

const GENERATION_TIMEOUT_MS = 120_000; // Muse usually answers in 10-20s; leave room for slow runs
const MAX_PROMPT_INGREDIENTS = 20;

/** Builds the image prompt from the recipe itself, in one fixed style so every generated photo on the site looks alike. */
export function dishPrompt({ title, ingredients = [], description }) {
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
export async function generateDishImage(recipe) {
  if (!config.openrouterKey) throw new Error("image generation isn't set up on the server (OPENROUTER_API_KEY is missing)");
  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openrouterKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.imageModel, prompt: dishPrompt(recipe) }),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(err.name === "TimeoutError" ? `${config.imageModel} took longer than ${GENERATION_TIMEOUT_MS / 1000}s` : err.message);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`);
  const image = body?.data?.[0];
  if (image?.b64_json) return Buffer.from(image.b64_json, "base64");
  if (image?.url) {
    const download = await fetch(image.url, { signal: AbortSignal.timeout(30_000) });
    if (!download.ok) throw new Error(`downloading the generated image failed: HTTP ${download.status}`);
    return Buffer.from(await download.arrayBuffer());
  }
  throw new Error("OpenRouter returned no image");
}
