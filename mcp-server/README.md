# Recipes MCP server

A small [MCP](https://modelcontextprotocol.io) server, hosted on Vercel, that lets an AI agent add and edit recipes on the site. Every change is committed straight to `main`, and the existing GitHub Pages workflow redeploys the site.

It's a separate deployment from the site. Vercel only builds this folder, and the site itself stays on GitHub Pages.

## Tools

| Tool | What it does |
| --- | --- |
| `list_recipes` | All recipes: slug, title, course, tags, time, servings, calories |
| `get_recipe` | Full Markdown of one recipe; with `include_image: true` it also returns the photo |
| `create_image_upload_link` | Returns a one-hour link where a person can upload the dish photo from their phone |
| `create_recipe` | New recipe from structured fields; the Markdown and photo go in one commit |
| `update_recipe` | Changes only the fields you pass; the slug/URL never changes |

## What's enforced

- **Allowed paths.** Every commit goes through `assertAllowedPath` (`lib/github.js`), which only accepts `recipes/<slug>.md` and `images/recipes/<slug>.{jpg,jpeg,png,webp}`. The server can't change its own code, `build.js`, templates or workflows. The agent never writes a path or raw file anyway: it passes structured fields and the server builds the file.
- **Format.** The input schemas match the `add-recipe` skill:
  - `course` is an enum.
  - `total_mins`, `serves` and `calories` (kcal per serving) must be positive integers.
  - Each ingredient is `{quantity, name, note}`. The server bolds the name, and a missing quantity is rejected unless the note says "to taste"/"to serve".
  - Instructions are numbered by the server, and you get a warning if an ingredient is mentioned without being bolded.
  - The slug is derived from the title.
  - Creating a recipe whose slug already exists is refused.
- **Photos are required and normalised.** The server fixes EXIF rotation, downsizes to at most 1600px on the long edge, strips metadata and saves a JPEG at `images/recipes/<slug>.jpg`.
- **Edits are minimal.** Existing recipes round-trip byte-for-byte (see the tests), so editing one field doesn't reformat the rest of the file.

## Adding photos

Ranked by how well each one works in practice:

1. **Upload link (best for photos the user has).** Neither claude.ai nor phone apps can pass a chat attachment to an MCP tool, so `create_image_upload_link` returns a signed link that expires after an hour. The user opens it, picks or takes a photo, and the page shrinks it in the browser (which avoids Vercel's 4.5MB request limit), then commits it. For new recipes the agent then calls `create_recipe` with `image: {uploaded: true}`. For existing recipes the photo is swapped immediately.
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
