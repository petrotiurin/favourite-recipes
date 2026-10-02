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
  readRecipeImage,
  pageUrl,
  UserError,
} from "./recipes.js";

const INSTRUCTIONS = `Manages the family's "Our Favourite Recipes" website (a static site on GitHub Pages).
Every create/update is committed straight to the main branch and the site redeploys in ~1 minute.

Rules the server enforces or expects:
- Ingredients are structured: { quantity, name, note }. Give every ingredient a quantity ("150g (2/3 cup)", "2", "Juice of 1/2"),
  or put "to taste"/"to serve" in the note. Names are plain text; the server bolds them. Keep them in the order they are used.
- Instructions: one action per array item, sentence case, no numbering (the server numbers them).
  Bold EVERY ingredient mention with **double asterisks**, ingredient noun only, e.g. "Stir the **oats** into the **yogurt**".
  Don't bold the dish itself ("the batter", "the burgers").
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
    .describe('Amount including units, e.g. "150g (2/3 cup)", "2", "Juice of 1/2", "Small handful of". Omit only for "to taste"/"to serve" items.'),
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
  .describe("Ordered steps, one action each, no numbering. Bold every ingredient mention with **...**.");

function ok(text, extra = []) {
  return { content: [{ type: "text", text }, ...extra] };
}

function fail(err) {
  const msg = err instanceof UserError ? err.message : `Server error: ${err.message}`;
  if (!(err instanceof UserError)) console.error(err);
  return { content: [{ type: "text", text: msg }], isError: true };
}

const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(err);
  }
};

function resultText(verb, { slug, markdown, commit, warnings }) {
  const lines = [];
  if (commit) {
    lines.push(`${verb} "${slug}" and committed to main: ${commit.url}`);
    lines.push(`It will be live in about a minute at ${pageUrl(slug)}`);
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
      description: "List every recipe on the site with its slug, title, course, tags, time, servings and calories.",
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
        "Fails if a recipe with that slug already exists.",
      inputSchema: {
        title: z.string().min(1).describe("Title Case recipe title"),
        course: courseSchema,
        tags: tagsSchema.optional(),
        total_mins: z.number().int().positive().describe("Total time in minutes (prep + cook)"),
        serves: z.number().int().positive().describe("How many people it serves"),
        calories: z.number().int().positive().describe("Calories (kcal) per serving. Use the source's figure, or estimate from the ingredients"),
        ingredients: z.array(ingredientSchema).min(1).describe("In the order they're used"),
        instructions: instructionsSchema,
        notes: z.string().optional().describe("Optional free-text Markdown for a '## Notes' section (tips, nutrition, storage)."),
        image: imageSchema,
      },
    },
    safe(async (args) => ok(resultText("Created", await createRecipe(args))))
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
        ingredients: z.array(ingredientSchema).min(1).optional().describe("Full replacement list, in the order used"),
        instructions: instructionsSchema.optional().describe("Full replacement list of steps. Bold every ingredient mention."),
        notes: z.string().optional(),
        image: imageSchema.optional(),
      },
    },
    safe(async (args) => ok(resultText("Updated", await updateRecipe(args))))
  );

  return server;
}
