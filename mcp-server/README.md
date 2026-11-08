# Recipes MCP server

A small [MCP](https://modelcontextprotocol.io) server, hosted on Vercel, that lets an AI agent add and edit recipes on the site. Every change is committed straight to `main`, and the existing GitHub Pages workflow redeploys the site.

It's a separate deployment from the site. Vercel only builds this folder, and the site itself stays on GitHub Pages.

## Tools

| Tool | What it does |
| --- | --- |
| `list_recipes` | All recipes: slug, title, course, tags, time, servings, calories, `draft: true` for drafts, `current: true` for this week's and `next: true` for next week's. Order: this week (drafts first), next week, the rest |
| `search_recipes` | Find recipes: `text` (title/method), `include_ingredients` / `exclude_ingredients` (substring of the **bolded** ingredient names, case-insensitive), `course`, `tags`, `max_calories`, `max_minutes`, `draft`, `week` (`this` / `next` / `none`); all optional, ANDed. Compact rows (slug, title, course, tags, total_mins, calories, draft, current, next, url). Reads from GitHub with a 60s in-memory cache (cleared on our own commits) |
| `get_recipe` | Full Markdown of one recipe; with `include_image: true` it also returns the photo |
| `create_image_upload_link` | Fallback to generated photos: returns one one-hour link to a page where a person uploads the dish photos for one or more recipes (`recipes: [{title} or {slug}, ...]`) from their phone |
| `create_recipe` | New recipe from structured fields; the Markdown and photo go in one commit. Added as a draft unless `draft: false`; `week: "next"` (or `"this"`) puts it straight into that week |
| `promote_recipe` | Turns a draft into a regular recipe (drops `draft: true`, one commit). Its weeks are unchanged |
| `remove_draft` | Deletes a draft the family didn't like (`recipes/<slug>.md` and its photo, one commit). **Only drafts** can be removed: a regular recipe is refused, and so is a draft planned for next week (the family keeps those) |
| `update_recipe` | Changes only the fields you pass; the slug/URL never changes |
| `set_week_recipes` | Adds recipes to this week (`current: true`) or next week (`next: true`), or takes them out, many slugs in one commit. Drafts and regular recipes alike; a recipe can be in both weeks |
| `start_next_week` | The switch, in one commit: next week's recipes become this week's, next week is emptied. `carry_over` keeps chosen recipes (untried drafts) in this week too. The shopping list isn't touched |
| `get_workflow_guide` | The step-by-step guide for a multi-step flow (`plan-recipes`, `ocado-shop`, `sainsburys-shop`); the same text is the prompt of that name |
| `get_shopping_list` | The stored shopping list, next week's recipes, and whether the list is `current`, `outdated`, `not planned` (next week empty) or `none` |
| `update_shopping_list` | Replaces the site's shopping page with the list the agent built from all of next week's recipes (one commit of `shopping-list.json`), optionally with planned servings per recipe |
| `set_shopping_servings` | Changes the planned servings of individual recipes on the saved list (e.g. one for 1, another for 2) without rebuilding it; the stocktake stays |
| `batch_changes` | Runs several of the write tools above (`create_recipe`, `update_recipe`, `promote_recipe`, `remove_draft`, `set_week_recipes`, `start_next_week`, `update_shopping_list`, `set_shopping_servings`) in order and commits them **together in one commit**, so the site deploys once. All or nothing; `dry_run: true` validates and reports warnings without committing |

## One commit per deploy

Every commit to `main` triggers the Pages workflow, and only one deploy runs at a time, so a burst of single-change calls (as in "add five recipes, plan two more for next week, update the shopping list") used to queue up a dozen deploys and leave the site minutes behind. To avoid that:

- **`batch_changes`.** Agents do their reads first, then send all the writes in one call. Each operation sees the ones before it (e.g. the shopping list covers recipes created earlier in the same batch), and a rejected operation commits nothing. The server's instructions tell agents to use it whenever they make more than one change.
- **Photos for recipes that don't exist yet** are committed with `[skip ci]`, because no page shows them until `create_recipe` (or `batch_changes`) commits the recipe, and that commit deploys. Replacing an existing recipe's photo deploys as usual.
- **The workflow** (`.github/workflows/deploy.yml`) never cancels a deploy that has started; pushes that arrive meanwhile collapse into one queued run for the newest commit.

Every tool is defined once in `lib/tools.js` (the registry: name, description, zod schema, `access: "read" | "stage" | "write"`, handler) and runs through `dispatch(name, args, caller)`, which checks the caller's role (`public` may only run `read`; `editor` and `agent` run all; a missing `access` counts as `write`) before the handler. `/mcp` registers the registry's tools with a fixed `{ role: "agent" }` caller; the functions that commit take the caller and assert the role again. `toolDefinitions(role)` turns the registry into OpenAI-style function tools for the chat. `test/tools.test.js` walks the registry and expects every non-read tool to refuse a public caller.

Internally every write goes through a `ChangeSet` (`lib/github.js`): reads see what it has staged, and nothing reaches GitHub until it commits. The single-change tools commit their own `ChangeSet`; `batch_changes` shares one across all its operations.

## What's enforced

- **Deletion is limited to drafts.** `remove_draft` is the only way a recipe leaves the site, and it refuses anything without `draft: true` (promoted recipes are protected) and any draft with `next: true` (planned for next week). `assertAllowedPath` still applies to the deleted recipe and photo paths.
- **Allowed paths.** Every commit goes through `assertAllowedPath` (`lib/github.js`), which only accepts `recipes/<slug>.md`, `images/recipes/<slug>.{jpg,jpeg,png,webp}` and `shopping-list.json`. The server can't change its own code, `build.js`, templates or workflows. The agent never writes a path or raw file anyway: it passes structured fields and the server builds the file.
- **Format.** The input schemas match the `add-recipe` skill:
  - `course` is an enum.
  - `total_mins`, `serves` and `calories` (kcal per serving) must be positive integers.
  - Each ingredient is `{quantity, name, note}`. The server bolds the name, and a missing quantity is rejected unless the note says "to taste"/"to serve".
  - Instructions are numbered by the server, and you get a warning if an ingredient is mentioned without being bolded.
  - Quantities stay in the ingredient list, because the site's servings selector rescales only that list. ASCII fractions ("1/2") are converted to "½" so they scale. You get a warning if a step repeats an amount (e.g. "add 37.5g **sugar**"); the server's instructions tell the agent to write "half the **sugar**" / "the remaining **sugar**" instead.
  - `scalable: false` (optional) hides the servings selector, for recipes whose ingredient list can't be multiplied.
  - New recipes are drafts (`draft: true`) by default, and the server's instructions tell the agent to keep it that way until the family has tried the dish, then call `promote_recipe`, or `remove_draft` if they didn't like it. The site marks a draft only by a line on its recipe page (tiles are labelled by week); being a draft says nothing about the week.
  - The slug is derived from the title.
  - Creating a recipe whose slug already exists is refused.
- **Photos are required and normalised.** Generated photos are centre-cropped to 4:3 (the index tile ratio) first. The server fixes EXIF rotation, downsizes to at most 1600px on the long edge, strips metadata and saves a JPEG at `images/recipes/<slug>.jpg`.
- **Edits are minimal.** Existing recipes round-trip byte-for-byte (see the tests), so editing one field doesn't reformat the rest of the file.

## This week, next week and the shopping list

Two weeks, both independent of `draft`: **this week** (`current: true`, what the family is cooking now) and **next week** (`next: true`, what they're planning and shopping for). A recipe can be in this week, next week, both or neither. The site's home page shows this week at the top and then the rest of the book; next week has its own page (`next-week.html`, linked from a "Next week · n" link above the grid), and a draft that's only in next week is only on that page until the switch. `list_recipes` orders recipes as this week (drafts first), next week, the rest.

`start_next_week` is the switch: every recipe's `current` becomes what its `next` was (plus the `carry_over` slugs, which must be in this week), and `next` is removed everywhere. The agent calls it when the user says the new week has started, and first thing before planning whenever next week already has recipes (handing over recipes always plans a fresh next week). Before the switch, the agent asks about each of this week's drafts: liked → `promote_recipe`, didn't like → `remove_draft` (refused if it's planned for next week: kept, and the user is told), not tried → carried over or back to the book (a draft in no week).

The site has a shopping page (`shopping-list.html`, linked by a button in the index header) covering **next week's** recipes only. The server doesn't merge ingredients: the agent reads each next-week recipe, combines and groups the items itself, and calls `update_shopping_list` with `sections: [{name, items: [{name, quantity?, note?, recipes, amounts?}]}]` and optionally `servings: { slug: n }`.

- Quantities are for 2 servings of every recipe. An item for several recipes carries `amounts` (slug → that recipe's share of `quantity`, same unit, adding up to it), so the page can scale each recipe on its own; the server refuses a multi-recipe item without it, or whose amounts don't add up.
- `servings` is the plan: how many people each recipe is cooked for (1-12). The page opens on it; the user can switch everything to 1/2/4 or change single recipes. Recipes the call doesn't name keep the previous list's plan, else 4. `set_shopping_servings` changes only the plan, keeping the items and the stocktake.

- Each item's `recipes` is the slugs of the next-week recipes it is for; the page shows their photos on the row and names them on a tap. The server refuses a slug that isn't in next week and a next-week recipe that no item is for.
- The server fills in the list's top-level `recipes` (the next-week slugs) itself and the page links to them. It refuses when next week is empty and when an ingredient is listed twice.
- **The page shows the saved list until it is rewritten.** Changing the weeks, the switch included, never alters or deletes it: after the switch it simply still shows the list made for what is now this week. `build.js` blanks the page only when there is no `shopping-list.json`.
- `get_shopping_list` reports `current` (covers exactly next week's recipes), `outdated` (next week changed since, so the agent should rewrite it), `not planned` (next week is empty, e.g. right after the switch) or `none`.
- Changing this week, promoting a draft or removing one (never in next week) doesn't make the list outdated. Editing a next-week recipe's ingredients with `update_recipe` doesn't touch the list, so refresh it after doing that.

The end-to-end agent flow (switch weeks if needed, add recipes to next week, select existing ones, build the list, summarise) ships with the server: `workflows/plan-recipes.md`, served as the `plan-recipes` prompt (pick it from the client's prompt menu, or `/mcp__<server>__plan-recipes` in Claude Code) and by the `get_workflow_guide` tool. The server's instructions tell agents to call `get_workflow_guide` first whenever they're handed recipes to cook, so no skill is needed; the repo's `plan-recipes` skill only points to it. Edit the flow in `workflows/plan-recipes.md` (bundled via `includeFiles` in `vercel.json`) and deploy.

The shopping flows work the same way: `workflows/ocado-shop.md` and `workflows/sainsburys-shop.md` (fill the basket/trolley from `get_shopping_list`'s "To buy" with Claude in Chrome; never check out), served as the `ocado-shop` / `sainsburys-shop` prompts and by `get_workflow_guide`. The repo's skills of the same names only point to them. Rules every shop shares (what to buy, picking rules, non-negotiables, report back) are written once in `workflows/shared/*.md`; a guide pulls one in with a line `<!-- include: shared/<name> -->`, expanded when the server loads it, and adds its shop's own products in an `### At <shop>` section. To serve another flow, add its Markdown to `workflows/` and an entry in `lib/workflows.js`.

## Adding photos

Ranked by how well each one works in practice:

1. **`image: {url}`** when the recipe comes from a website with a photo of the dish: pass the dish photo or `og:image` URL and the server downloads it. A real photo always wins over a generated one.
2. **`image: {generate: true, description?}`** for everything else (screenshots, pasted text, recipes from memory). The server builds a prompt from the title, the ingredient names and the agent's optional one-sentence `description` of the finished dish, inside one fixed style (natural light, 45°, plain table, no text or people) so generated photos look alike. It calls OpenRouter's `/api/v1/images` with `meta/muse-image` (`OPENROUTER_IMAGE_MODEL` to change it) and centre-crops the result to 4:3, because the model takes no aspect-ratio parameter. Generation takes 10-20s, so `batch_changes` starts every `create_recipe` generation before running the operations and they run in parallel (`update_recipe` generates when it runs, from the stored recipe). The function timeout is 300s (`vercel.json`) and each generation gives up after 120s. A failed generation rejects the batch like any other error, and the error tells the agent to retry or fall back to an upload link. `dry_run` doesn't generate anything. There's no review step: the agent carries on, and a photo can be replaced later.
3. **Upload link (fallback, for photos the user has).** Neither claude.ai nor phone apps can pass a chat attachment to an MCP tool, so `create_image_upload_link` returns a signed link that expires after an hour. One link covers every recipe passed in `recipes`: the page lists them all, the user picks or takes a photo for each, and each one uploads as soon as it's picked. The page shrinks every photo in the browser and sends it in its own request, which keeps each request under Vercel's 4.5MB limit and means a failed photo can be retried on its own. The link can only write photos for the recipes it lists. For new recipes the agent then creates them with `image: {uploaded: true}` (in one `batch_changes` call when there are several). For existing recipes the photo is swapped immediately. Passing an existing slug is also how a generated photo is swapped for a real one. Links made before multi-recipe pages (a single `slug`) still work.
4. **`image: {base64}`** is for agents that have the file bytes, such as Claude Code with a local file. Keep it under about 3MB because of the request size limit.

## Stocktake endpoint

`POST /stocktake` is called by the shopping page, not by agents. The signed-in editor sends `Authorization: Bearer <Supabase access token>` and `{ items: [{ name, quantity?, have? }] }`, covering every item on the stored list. The server checks the token with Supabase (`/auth/v1/user`, so any JWT signing setup works) and the email against `EDITORS`. It refuses a list that doesn't match the stored one with 409, then commits `shopping-list.json` with each item's `have` (`true` or an amount in the item's unit) and a `stocktake` timestamp. Without the three Supabase variables it answers 503. The page signs the editor in with a Supabase email + password, or an email code as the fallback (its Magic Link email template must include `{{ .Token }}`) and sends all of their edits in one request when they press Save. See CLAUDE.md → "Stocktake" for the page side.

## Chat endpoint

`POST /chat` is called by the site's chat widget (`templates/chat.js`), not by agents. Body `{ conversation_id?, messages: [{ role, content }], page: { page, slug?, servings?, filter?, search? } }`; the answer is a Server-Sent Events stream (`text`, `status`, `suggestions`, `done`, `error`). Phase 1 is anonymous and read-only: the model only sees the read tools and `suggest_replies`, every call goes through `dispatch()`, history from the client is reduced to plain user/assistant text, and the page is re-resolved on the server. A bearer token is verified if sent: bad or expired is a 401, a valid one whose email is in `EDITORS` is an editor, any other valid one is a visitor. An editor's turn sends `{ conversation_id?, message, page }` (never history: the server stores it in the `conversations` / `messages` tables and loads it only for the owner, else 404), runs on the editor key and model, and is rate limited per user id; in chat it never commits: it stages changes into the household plan tray (`stage_*` tools, `ask_user`), and only `POST /chat/plan/apply` (a button a person taps, token and `EDITORS` checked afresh) commits, once, with the photos. More editor-only routes: `GET /chat/plan`, `DELETE /chat/plan/items/:id`, `POST /chat/plan/items/:id/photo`, `POST /chat/plan/apply { item_id?, conversation_id? }` (`item_id` = Save now, quick fixes only), `GET /chat/status?slugs=a,b` (are the pages live yet) and `POST /chat { action: "finalise" }` (the Finalise list button). The tray is one row in the `trays` table (7 days from its first item) with staged photos in the private `tray-photos` Storage bucket: apply `supabase/migrations/20261108000000_trays.sql` and `20261108000100_tray_photos_bucket.sql`; the image key (`OPENROUTER_API_KEY`) makes the photos. Editor-only routes (rewritten to `/api/chat?route=`): `GET /chat/me`, `GET /chat/conversations`, `GET|DELETE /chat/conversations/:id`, `POST /chat/feedback { conversation_id, turn_id, value: 1 | 0 | null, reasons?, note? }` (the Langfuse score `user-feedback`). Chats are deleted 2 weeks after their last message by `purge_old_chats()` (called when the list is opened; the migration also schedules it daily with pg_cron when that extension is available). Visitors are rate limited per hashed IP (429 with a friendly message). CORS allows only the site's origin. Editors may also attach photos (up to 4 per message, `images: ["data:image/jpeg;base64,..."]` in the JSON body, which the panel downscales to 1600px first): the server sniffs, decodes and re-encodes each one with sharp (no metadata, 40 megapixel cap, 3 MB per photo, 4.3 MB per request), stores it in the private `chat-uploads` bucket (`<conversation id>/<uuid>.jpg`, migration `20261108120000_chat_uploads_bucket.sql`), hands it to the editor model as an image part, and shows it again on reload through signed URLs; anyone else sending `images` gets a 403. Only the latest few photos (4, within the last 8 messages) are replayed to the model on later turns; older ones become "[photo the user sent earlier]". Photos of deleted or expired chats are removed when the chat is deleted and by an hourly sweep. The editor model also has `fetch_url` (public http(s) pages only, through the same SSRF-guarded fetcher as photos from links: public addresses only, the connection pinned to the checked address, redirects re-checked, size and time limits; the result is the page's JSON-LD Recipe, its photo link and its text, fenced as untrusted data); it is not offered to visitors, refused by the dispatcher and the handler for anyone but an editor, and not registered on `/mcp`. Traces never contain photo bytes (the storage path is in the trace metadata; uploading them as Langfuse media is a TODO). Phase 6 extras, all in chat only (none are on `/mcp`): `scale_recipe` (a recipe rescaled to N servings with the page's own rounding), `recipes_from_home` (recipes ranked by what the saved stocktake says is at home), `stage_stocktake` (editors: "we've got 6 eggs and plenty of rice" becomes an "At home" card in the tray, saved by Save / Save now with the same validation as `/stocktake`), and a `balance` object on `GET /chat/plan` (next week as it will be after Save: recipes, dinners, average kcal, total minutes). The design is `docs/chatbot-design.md`.

Run it locally without any real service: `npm run dev` (see the top of `scripts/dev.js`). The tests (`npm test`) use the same fakes from `scripts/fakes.js`.

## Setup

Environment variables, set in Vercel → Project → Settings → Environment Variables:

| Name | Value |
| --- | --- |
| `GITHUB_TOKEN` | Fine-grained PAT, **only** for `petrotiurin/favourite-recipes`, permission **Contents: Read and write** |
| `MCP_AUTH_TOKEN` | A long random string (`openssl rand -hex 32`). Clients must send it. It also signs upload links. |
| `OPENROUTER_API_KEY` | OpenRouter key for generated photos. Set a credit limit on it. Without it, `image: {generate: true}` is refused and agents fall back to upload links |
| `OPENROUTER_IMAGE_MODEL` | Optional; defaults to `meta/muse-image` |
| `PUBLIC_SITE_URL` | Optional; defaults to `https://petrotiurin.github.io/favourite-recipes`. Its origin is the only one allowed to call `/stocktake` (CORS) |
| `SUPABASE_URL` | For `/stocktake`: the Supabase project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_ANON_KEY` | For `/stocktake`: the project's anon / publishable key (public; used to ask Supabase who a token belongs to) |
| `EDITORS` | For `/stocktake`: comma-separated emails allowed to save the stocktake. The old name `SHOPPING_EDITORS` still works as a fallback |
| `SUPABASE_SERVICE_ROLE_KEY` | For `/chat`: the project's service-role key (**server only**, never public). Rate limit counters, and editors' saved chats (`conversations`, `messages`; the browser can't reach them). Without it limiting is skipped with a warning and editors' chat is off (503). Apply `supabase/migrations/*.sql` to the project first (`supabase db push` or the SQL editor) |
| `OPENROUTER_CHAT_PUBLIC_KEY` | For `/chat`: OpenRouter key for visitors' chats, with its own credit limit (when it runs dry the chat says it's resting for everyone). Falls back to `OPENROUTER_API_KEY` if unset, which is only a convenience: use a separate key so chat can't starve photos |
| `CHAT_PUBLIC_MODEL` | Optional; the visitors' chat model, defaults to `google/gemini-2.5-flash`. Needs tool calling and streaming |
| `OPENROUTER_CHAT_EDITOR_KEY` | For signed-in editors' chats: their own OpenRouter key (own credit limit). Falls back to `OPENROUTER_API_KEY` |
| `CHAT_EDITOR_MODEL` | Optional; the editors' chat model, defaults to `anthropic/claude-sonnet-4.5`. Needs tool calling, streaming and (later) vision |
| `CHAT_EDITOR_HOURLY_LIMIT` / `CHAT_EDITOR_DAILY_LIMIT` | Optional; messages per editor (user id) per hour / day, default 200 / 1000 |
| `BUILD_OUT_DIR` (build.js) / `DEV_DIST` (dev harness) | Optional; build or serve the site somewhere other than `../dist`, so tests and one-off builds leave a running dev site alone |
| `CHAT_PANEL_HOURLY_LIMIT` | Optional; the panel's own requests (plan tray, publishing status, dropping an item, new photo) per editor per hour, default 600 |
| `OPENROUTER_BASE_URL` | Optional; defaults to `https://openrouter.ai/api/v1` (the local dev harness points it at a mock) |
| `CHAT_PUBLIC_TOTAL_HOURLY_LIMIT` | Optional; one hourly cap across ALL visitors together, default 300 |
| `AUTH_FAILURE_HOURLY_LIMIT` | Optional; failed sign-in checks per visitor per hour before `/chat` answers 429 without asking Supabase, default 20 |
| `CHAT_PUBLIC_MAX_TOKENS` / `CHAT_EDITOR_MAX_TOKENS` | Optional; longest model reply per request, default 1500 / 4000 |
| `CHAT_PUBLIC_HOURLY_LIMIT` / `CHAT_PUBLIC_DAILY_LIMIT` | Optional; messages per visitor (hashed IP) per hour / day, default 20 / 100 |
| `IP_HASH_SALT` | Optional salt for hashing visitor IPs (rate limits, traces); defaults to the service-role key. Raw IPs are never stored |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | Optional: all three turn on Langfuse tracing of chats (one trace per request, a generation per model call, a span per tool call). Never contains tokens, IPs or emails |

The site build also needs `CHAT_API_URL` (a repo Actions **variable**, e.g. `https://<vercel-domain>/chat`) to show the chat bubble; without it the site has no chat. The chat signs in from any page (through `templates/auth.js`, which the build adds when `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set), so Supabase Auth → URL Configuration → Redirect URLs must allow the whole site, e.g. `https://petrotiurin.github.io/favourite-recipes/**`, not just the shopping page. Apply `supabase/migrations/20261107120000_chat_conversations.sql` before enabling editors' chat.

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
