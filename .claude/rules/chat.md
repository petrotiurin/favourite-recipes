---
paths:
  - "templates/chat.js"
  - "templates/auth.js"
  - "mcp-server/**"
  - "supabase/**"
  - "docs/chatbot-design.md"
  - "docs/parallel-photo-reading.md"
---

# The chat

A recipe chat assistant: a bubble on every page, read-only for visitors, the full MCP toolset through a plan tray for signed-in
editors. `docs/chatbot-design.md` is its design and the source of truth: read it before working on any of it, and update it in the
same change when the design moves (this file too, when a rule or a file's job below changes).

**The rules it must keep:** `templates/chat.js` is vanilla JS that talks only to `/chat` (and Supabase Auth through the shared
`auth.js`); auth is enforced on the server by the dispatcher (`mcp-server/lib/tools.js`), never by the prompt; a role is never read
from the request body; in chat an editor's writes never commit until Save.

## Anonymous chat (read-only)

`POST /chat` (`mcp-server/api/chat.js`, agent loop in `lib/chat.js`, prompt in `lib/chat-prompt.js`) streams Server-Sent Events from
an OpenRouter model (`OPENROUTER_CHAT_PUBLIC_KEY`, `CHAT_PUBLIC_MODEL`) that may only call read tools (`search_recipes` and the
catalogue helper `catalogue()` in `lib/recipes.js` among them) plus the UI tool `suggest_replies`. A visitor's caller is a frozen
`{ role: "public", ip }`; client history is reduced to plain user/assistant text, the page is re-resolved server-side (the browser
sends it from the `#page-context` JSON every page has), and per-IP rate limits (hashed IP, counters in Supabase:
`supabase/migrations/`, needs `SUPABASE_SERVICE_ROLE_KEY`) and optional Langfuse tracing apply (`lib/langfuse.js`, Langfuse JS SDK v6
over OpenTelemetry: one `agent` trace per turn with a generation per model call and a `retriever` / `tool` observation per tool
call; see design 8.1; change tracing with the `langfuse` skill, `.claude/skills/langfuse/`, installed from github.com/langfuse/skills;
`npx skills update` refreshes it). The widget is `templates/chat.js` (safe renderer, history in `localStorage`); it only exists on
builds that set the build env var `CHAT_API_URL` (a repo Actions variable, like `STOCKTAKE_API_URL`), otherwise no bubble and no script.

## Sign-in and per-user chats

`templates/auth.js` is the one sign-in (sheet, session in `localStorage`, token refresh, `window.RecipeAuth`) for the shopping page
and the chat; it is added to every page (head, deferred) only when the build has `SUPABASE_URL` + `SUPABASE_ANON_KEY`, and the magic
link returns to the page it was sent from. `/chat` decides the caller from a verified token: none = `public`; valid and in `EDITORS`
= `editor` (editor key `OPENROUTER_CHAT_EDITOR_KEY`, model `CHAT_EDITOR_MODEL`, 200/hour per user id); valid but not an editor =
`public` (the panel says the account can't edit); bad or expired = 401. Editors' chats are server-owned (`conversations` /
`messages` tables, service-role key only, RLS with no policies; `lib/chat-store.js`): the client sends
`{ conversation_id?, message, page }`, never history; another user's conversation is a 404; chats are deleted 2 weeks after the last
message (`purge_old_chats()`, run when the chats list is opened, plus pg_cron where available). Editor-only routes under `/chat`:
`GET /chat/me`, `GET /chat/conversations`, `GET|DELETE /chat/conversations/:id`, `POST /chat/feedback` (thumbs up / down become the
Langfuse score `user-feedback`).

## Editor writes: the household plan tray

`offeredTools` gives editors the `stage_*` tools (registry entries with `access: "stage"`, not registered on `/mcp`, which keeps its
committing write tools unchanged), `get_tray`, `drop_tray_item`, `resolve_clash` and the UI tool `ask_user`; the write tools never go
into chat. Staging validates by a dry run of the real write logic (`lib/operations.js` `runOperation`, shared with `batch_changes`)
over a throwaway `ChangeSet` of the repo plus the tray's earlier items (`lib/tray.js` `replay`), so problems show on the card at
once; it never commits. Dry runs (staging, the tray view, `get_tray`) read the branch through a head-SHA snapshot (`branchSnapshot()`
in `lib/github.js`); Save reads fresh. The tray is ONE row in Supabase `trays` (items jsonb, 7-day expiry, optimistic `version`) with
staged photos in the private `tray-photos` bucket (`lib/tray-store.js`), RLS on with no policies. A new recipe's photo is made in the
background (`lib/tray-photos.js`: the source page's og:image / JSON-LD image, fetched with an SSRF guard, else generated). The tray
reports `balance` (recipes, dinners, average kcal, total minutes of next week after Save, `weekBalance`).

**The list in the tray** is the server's: whenever the tray changes next week a List card is added and rebuilt with every tray write
(`withList` / `checkItems` / `listState` in `lib/tray.js`), so it is never out of date. Planned servings can be staged at any time.

**Finalise list** (`POST /chat { action: "finalise" }`) is a review: the promote question only if next week on the site has recipes;
the model only when the server flags something (`reviewFlags`), answering with ONE `stage_shopping_list_edits` (patches, stored on the
List card and re-applied by item id; `remember: true` on a merge / move / rename stages an `update_catalogue` change on one Catalogue
card); then the **optional items card** (`lib/optional-review.js`, `POST /chat { action: "review_optional", answers: { item: "keep" | "drop" } }`,
once only, no model call; the model's UI tool `review_optional` shows it again; drops are this week's patches only; the panel draws it
in `templates/chat.js`, `optionalEl`, `.chat-optional` in `design.md`); then Save. A later change keeps Save unless it brings a new
flag or optional item. "Not yet" to the promote question is answered by the server without a model call (`lib/shortcuts.js`), and so
is "Promote it": it stages the switch and shows the **drafts review card** (`lib/draft-review.js`, `.chat-review` in
`templates/chat.js`), every draft of this week in one card with a thumbs up (promote) / down (remove), no thumb = kept for the coming
week (carried over); its Done (`POST /chat { action: "review_drafts", answers }`, once only, while the card is the open question)
stages every answer in one tray write (`stageMany` in `lib/tray.js`), then the site carries on with the list's review (or Save is
offered). The model's own `review_drafts` UI tool shows the same card; drafts are never asked about one by one.

**Save is `POST /chat/plan/apply`, never a model tool**: fresh token + `EDITORS`, re-validation, clash detection, ONE commit
(`lib/plan-apply.js`) with the photos, then the tray is emptied and a summary is posted into the chat (written by `chatLine` in
`lib/plan-apply.js`: titles, plain words; `/mcp`'s batch_changes text is separate; new recipes "Publishing…" until `GET /chat/status`
sees their page). "Save now" (`{ item_id }`) is for quick fixes only (`saveNowRule`). Action chips that commit have fixed labels;
plain "Save to site" / "Finalise list" reply chips become the real action chips when the tray allows them (`trayAction`), and answers
of earlier questions are never suggestions. Other routes: `GET /chat/plan`, `DELETE /chat/plan/items/:id`,
`POST /chat/plan/items/:id/photo`.

## The plan-recipes flow in chat

The editor system prompt loads the chat-relevant parts of `workflows/plan-recipes.md` (`chatGuide()` in `lib/workflows.js`), whose
"In chat" section is the full flow. The editor model has the editor-only read tool `fetch_url` (`lib/page-reader.js`: JSON-LD Recipe +
og:image + readable text, fenced as untrusted; `editorOnly` in the registry, enforced by `offeredTools`, `dispatch` and the handler,
not on `/mcp`) on the SSRF-guarded fetcher in `lib/tray-photos.js` (connection pinned to the checked address). Chat-only read tools
(not on `/mcp`): `scale_recipe` (the recipe's structured amounts with the recipe page's rounding, `lib/scaling.js`) and
`recipes_from_home` (`lib/at-home.js`: ranks recipes by the shopping list's stocktake). The stage tool `stage_stocktake` records
what's at home as one "At home" tray card (`update_stocktake` operation, same validation as `/stocktake` via `applyStocktake`, a list
that changed since staging refuses Save with a 409, Save now eligible; with a list in the tray it is checked against the rebuilt list
by item name). Voice input, diff view and revert are deferred.

## Photos

Editors attach up to 8 photos per message, each uploaded on pick (`POST /chat/uploads`; `templates/chat.js` downscales to 1600px
JPEG; `lib/chat-uploads.js` validates and re-encodes with sharp and stores them in the private `chat-uploads` bucket; public requests
with `images` get a 403) and numbered on through the chat (badges in the panel; `photoList()` in `lib/chat-store.js`). The main chat
model never sees photos (`docs/parallel-photo-reading.md`). It calls the editor-only read tool `read_recipe_photos`, which queues them
in Supabase `photo_reads` and returns at once; drainers (`lib/photo-queue.js`, under `background()`) read them in parallel with a
separate vision model (`CHAT_VISION_MODEL`, required, no fallback; its own prompt in `lib/photo-reader-prompt.js` with the recipe rules
cut from `workflows/plan-recipes.md`, no tools, nothing from the chat), join neighbouring screenshots of one recipe (`groupPhotos` in
`lib/photo-reader.js`) and read joined groups again together, check each recipe (dry run, duplicates in the household tray and the
book) and store a report as an `event` message (a note from the site). A follow-up turn (`lib/follow-up.js`, run through
`POST /chat/internal/continue` with `CHAT_INTERNAL_SECRET`) hands it to the model, which stages with
`stage_create_recipe({ from_photo: "photo-3+4" })`; whoever claims the note first (the follow-up or the user's next turn) hands it
over, exactly once. Corrections go through `read_recipe_photos` (`join`, `split`, `skip`). `stage_create_recipe` /
`stage_update_recipe` take `photo_from_attachment` to use the editor's own photo, honoured only when the user's message asks to use
their photo as the recipe's photo (`asksToUsePhoto`). The panel polls the conversation while photos are read, shows "Reading photos…
4 of 6" and the note as a status line, and the tray shows "Reading 3 photos · Sam" for the household. Try it with `npm run dev` (the
fake reader reads every photo as one of a few recipes).

## Turns, limits and failures

Every turn holds the conversation's turn lock (409 `{ busy }` otherwise). The chat loop caps tool calls (4 per reply, 10 per turn,
80k result characters) and sets `max_tokens`; read tools are served from the cached recipe index (`listRecipes()` / `getRecipe()` /
`getShoppingList()` without a ChangeSet are reads; with one they read fresh), and the rate limit falls back to an in-memory limiter
instead of failing open. A turn over `CHAT_TURN_BUDGET_MS` (200s) stops with a clear line, and a model call still running at
`CHAT_TURN_DEADLINE_MS` (250s) is aborted the same way so Vercel's 300s limit never kills a turn mid-stream (a "finalising" tray flag
older than 6 minutes counts as collecting again). An editor's turn isn't tied to the connection (a phone switching apps drops the
stream): it runs to the end on the server under `waitUntil`, is stored (a failed one as a marker row), `GET /chat/conversations/:id`
reports `ended_turns`, and the panel waits for that turn and shows the stored answer; with the panel closed the bubble shows a turning
ring while an answer or a Save is on its way and an unread dot when it arrives, kept for the tab across pages (an editor's turn left
mid-answer is picked up on the next page). A model call cut off before it finished (`finish_reason: length`, or a stream that ends
with no finish reason, e.g. a provider timeout: a half-written tool call is then usually dropped, so it looks empty) is logged with
its finish reason, time and tokens, and an empty turn says so instead of the generic "try again" line (`cutOffLine` in `lib/chat.js`).
An answer without chips gets one cheap `suggest_replies`-only follow-up (else safe page chips).

## Off switches

Three (`mcp-server/README.md`): `CHAT_ENABLED=false` (Vercel; every `/chat` route answers 503 `{ disabled: true }`, read per request,
needs a redeploy to change), `CHAT_PUBLIC_ENABLED=false` (editors only; 403 `{ signin: true }` for everyone else; `/chat/me` reports
`public_enabled`) with the site build variable `CHAT_PUBLIC=false` (`data-public="false"` on the script: bubble only for signed-in
visitors), and no `CHAT_API_URL` at build time (no chat at all). The panel shows a calm locked state (switched off / editors only /
this account can't use it) with no input, and remembers "switched off" in `sessionStorage` so later pages in the tab have no bubble.
Try it all locally with `cd mcp-server && npm run dev`.
