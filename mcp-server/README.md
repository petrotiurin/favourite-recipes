# Recipes MCP server

A small [MCP](https://modelcontextprotocol.io) server, hosted on Vercel, that lets an AI agent add and edit recipes on the site. Every change is committed straight to `main`, and the existing GitHub Pages workflow redeploys the site.

It's a separate deployment from the site. Vercel only builds this folder, and the site itself stays on GitHub Pages.

## Tools

| Tool | What it does |
| --- | --- |
| `list_recipes` | All recipes: slug, title, course, tags, time, servings, calories, `draft: true` for drafts and `current: true` for every current recipe. Order: drafts, other current recipes, the rest |
| `get_recipe` | Full Markdown of one recipe; with `include_image: true` it also returns the photo |
| `create_image_upload_link` | Returns one one-hour link to a page where a person uploads the dish photos for one or more recipes (`recipes: [{title} or {slug}, ...]`) from their phone |
| `create_recipe` | New recipe from structured fields; the Markdown and photo go in one commit. Added as a draft unless `draft: false` |
| `promote_recipe` | Turns a draft into a regular recipe (replaces `draft: true` with `current: true`, one commit). Its currency is unchanged: it stays current |
| `update_recipe` | Changes only the fields you pass; the slug/URL never changes |
| `set_current_recipes` | Adds regular recipes to the current rotation (`current: true`) or removes them, many slugs in one commit. Drafts are always current and can't be toggled. Unmarking the last current recipe also deletes the shopping list |
| `get_shopping_list` | The stored shopping list, the current recipes, and whether the list is `current`, `outdated` or `none` |
| `update_shopping_list` | Replaces the site's shopping page with the list the agent built from all current recipes (one commit of `shopping-list.json`) |
| `batch_changes` | Runs several of the write tools above (`create_recipe`, `update_recipe`, `promote_recipe`, `set_current_recipes`, `update_shopping_list`) in order and commits them **together in one commit**, so the site deploys once. All or nothing; `dry_run: true` validates and reports warnings without committing |

## One commit per deploy

Every commit to `main` triggers the Pages workflow, and only one deploy runs at a time, so a burst of single-change calls (as in "add five recipes, mark two current, update the shopping list") used to queue up a dozen deploys and leave the site minutes behind. To avoid that:

- **`batch_changes`.** Agents do their reads first, then send all the writes in one call. Each operation sees the ones before it (e.g. the shopping list covers recipes created earlier in the same batch), and a rejected operation commits nothing. The server's instructions tell agents to use it whenever they make more than one change.
- **Photos for recipes that don't exist yet** are committed with `[skip ci]`, because no page shows them until `create_recipe` (or `batch_changes`) commits the recipe, and that commit deploys. Replacing an existing recipe's photo deploys as usual.
- **The workflow** (`.github/workflows/deploy.yml`) never cancels a deploy that has started; pushes that arrive meanwhile collapse into one queued run for the newest commit.

Internally every write goes through a `ChangeSet` (`lib/github.js`): reads see what it has staged, and nothing reaches GitHub until it commits. The single-change tools commit their own `ChangeSet`; `batch_changes` shares one across all its operations.

## What's enforced

- **Allowed paths.** Every commit goes through `assertAllowedPath` (`lib/github.js`), which only accepts `recipes/<slug>.md`, `images/recipes/<slug>.{jpg,jpeg,png,webp}` and `shopping-list.json`. The server can't change its own code, `build.js`, templates or workflows. The agent never writes a path or raw file anyway: it passes structured fields and the server builds the file.
- **Format.** The input schemas match the `add-recipe` skill:
  - `course` is an enum.
  - `total_mins`, `serves` and `calories` (kcal per serving) must be positive integers.
  - Each ingredient is `{quantity, name, note}`. The server bolds the name, and a missing quantity is rejected unless the note says "to taste"/"to serve".
  - Instructions are numbered by the server, and you get a warning if an ingredient is mentioned without being bolded.
  - Quantities stay in the ingredient list, because the site's servings selector rescales only that list. ASCII fractions ("1/2") are converted to "½" so they scale. You get a warning if a step repeats an amount (e.g. "add 37.5g **sugar**"); the server's instructions tell the agent to write "half the **sugar**" / "the remaining **sugar**" instead.
  - `scalable: false` (optional) hides the servings selector, for recipes whose ingredient list can't be multiplied.
  - New recipes are drafts (`draft: true`) by default, and the server's instructions tell the agent to keep it that way until the family has tried the dish, then call `promote_recipe`. Drafts are highlighted on the site, sorted first and get a "Draft" filter tab.
  - The slug is derived from the title.
  - Creating a recipe whose slug already exists is refused.
- **Photos are required and normalised.** The server fixes EXIF rotation, downsizes to at most 1600px on the long edge, strips metadata and saves a JPEG at `images/recipes/<slug>.jpg`.
- **Edits are minimal.** Existing recipes round-trip byte-for-byte (see the tests), so editing one field doesn't reformat the rest of the file.

## Current recipes and the shopping list

A recipe is *current* when the family is cooking it right now: every draft is, plus any regular recipe the agent marks with `set_current_recipes` (`current: true` in its frontmatter). The site and `list_recipes` order recipes as drafts, then other current recipes, then the rest. The rotation can hold only existing recipes, only drafts, or both.

The site has a shopping page (`shopping-list.html`, linked by a button in the index header) covering all current recipes. The server doesn't merge ingredients: the agent reads each current recipe, combines and groups the items itself, and calls `update_shopping_list` with `sections: [{name, items: [{name, quantity?, note?}]}]`.

- The server fills in `recipes` (the current slugs) itself and the page links to them. It refuses when nothing is current and when an ingredient is listed twice.
- **The page shows the saved list until it is rewritten.** Changing which recipes are current does not alter it. `build.js` blanks the page only when no recipe is current. Unmarking the last current recipe (`set_current_recipes`) deletes `shopping-list.json` in the same commit, so an old list can't resurface once something becomes current again.
- `get_shopping_list` reports `current` (covers exactly the current recipes), `outdated` (the set changed since, so the agent should rewrite it) or `none`.
- Promoting a draft doesn't change its currency, so it doesn't make the list outdated.
- Editing a current recipe's ingredients with `update_recipe` doesn't touch the list, so refresh it after doing that.

The end-to-end agent flow (add recipes, select existing ones, build the list, summarise) is the `plan-recipes` skill in `.claude/skills/plan-recipes/SKILL.md`.

## Adding photos

Ranked by how well each one works in practice:

1. **Upload link (best for photos the user has).** Neither claude.ai nor phone apps can pass a chat attachment to an MCP tool, so `create_image_upload_link` returns a signed link that expires after an hour. One link covers every recipe passed in `recipes`: the page lists them all, the user picks or takes a photo for each, and each one uploads as soon as it's picked. The page shrinks every photo in the browser and sends it in its own request, which keeps each request under Vercel's 4.5MB limit and means a failed photo can be retried on its own. The link can only write photos for the recipes it lists. For new recipes the agent then creates them with `image: {uploaded: true}` (in one `batch_changes` call when there are several). For existing recipes the photo is swapped immediately. Links made before multi-recipe pages (a single `slug`) still work.
2. **`image: {url}`** works when the recipe comes from a website: pass the dish photo or `og:image` URL and the server downloads it.
3. **`image: {base64}`** is for agents that have the file bytes, such as Claude Code with a local file. Keep it under about 3MB because of the request size limit.

## Setup

Environment variables, set in Vercel → Project → Settings → Environment Variables:

| Name | Value |
| --- | --- |
| `GITHUB_TOKEN` | Fine-grained PAT, **only** for `petrotiurin/favourite-recipes`, permission **Contents: Read and write** |
| `MCP_AUTH_TOKEN` | A long random string (`openssl rand -hex 32`). Clients must send it. It also signs upload links. |
| `PUBLIC_SITE_URL` | Optional; defaults to `https://petrotiurin.github.io/favourite-recipes` |

Deploys are configured as follows:

- The Vercel project's Root Directory is `mcp-server`.
- `vercel.json`'s `ignoreCommand` skips any deploy whose commit doesn't touch this folder, so recipe commits made by the MCP don't redeploy it.
- The Pages workflow ignores `mcp-server/**`.

## Connecting a client

The endpoint is `https://<vercel-domain>/mcp`.

- **Claude Code:** `claude mcp add --transport http recipes https://<domain>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"`
- **claude.ai / Claude apps (custom connector):** use the URL `https://<domain>/mcp?key=<MCP_AUTH_TOKEN>`. Treat this URL as a password.

## Develop

```
cd mcp-server
npm install
npm test        # unit tests + end-to-end MCP tests against a fake GitHub
```
