# Recipe chat assistant: design

Status: **draft, iterating**. No code yet. Each phase at the end is meant to ship on its own.
Decisions are marked **D1, D2…** with a recommendation; open questions are collected at the end.

## 1. Desired outcome

A small chat bubble in the bottom-right corner of every page. Tapped, it expands into a chat panel
where anyone can ask about our recipes ("something with chicken under 300 kcal", "what can I swap
for crème fraîche here?") and get answers grounded in **our** recipe book, with links to the pages.
A signed-in editor can do in chat everything the agent does today through the MCP server: add
recipes (as drafts), edit them, promote/remove drafts, mark recipes current, and build the
shopping list.

Must-haves from the brief:

1. **Bubble → panel** UI, on every page.
2. **Read tools for everyone**: list, filter, search and recommend recipes.
3. **Authenticated mode**: the MCP write tools, for signed-in editors only.
4. **Persistent chats**: come back to an unfinished conversation, or start a new one.
5. **Recipe cards in chat**, including a running "what we've added so far" view, so the week's
   recipes can be collected over several messages (or days) and saved together.
6. **Page context**: on the Steamed rice page, "add this recipe" means Steamed rice.
7. **Navigation**: the bot names a recipe and offers to take you there; it never jumps on its own.

Non-goals (for now): shopping at Ocado/Sainsbury's from chat (those flows need Claude in Chrome on
the user's machine), voice output, multi-household accounts.

## 2. How it fits the site's constraints

CLAUDE.md's hard rule is "static first: no client-side data fetching", with the stocktake as the one
deliberate network exception. **The chat is a second, much bigger exception** and needs to be
written into CLAUDE.md before any code lands. Proposed wording of the exception:

- `templates/chat.js` is hand-written vanilla JS (no framework, no bundler, no npm in `dist/`),
  copied verbatim like the others.
- It talks to **one** endpoint, the MCP server's `/chat` (plus Supabase Auth, shared with the
  shopping page). It never loads recipe data to render the site; pages stay fully static.
- It is pure enhancement: with JS off there is no bubble and nothing else changes. If `/chat` is
  down, the bubble shows an error state; the page is unaffected.

## 3. Architecture

```
GitHub Pages (static)                     Vercel (mcp-server/)                    External
┌──────────────────────┐   POST /chat    ┌───────────────────────────────┐
│ every page           │ ─────────────▶  │ api/chat.js                   │ ───▶ Claude API (stream)
│  templates/chat.js   │ ◀── SSE stream ─│  - verify Supabase token       │
│  + page context JSON │                 │  - load/save conversation      │ ───▶ Supabase Postgres
│  + shared auth.js    │                 │  - agent loop over tool registry│     (chats, plan tray)
└──────────────────────┘                 │  - same lib/ as the MCP tools  │ ───▶ GitHub (commits)
                                         └───────────────────────────────┘
```

### D1. Where the agent loop runs → **new `/chat` endpoint in `mcp-server/`** (recommended)

It already holds the GitHub token, the Supabase verification (`verifyEditor`), the CORS pattern
(`api/stocktake.js`) and all the validated write logic (`lib/recipes.js`, `lib/shopping-list.js`).

Alternatives considered:
- *Claude API's MCP connector pointed at our own `/mcp`*: least code, but tools are then all-or-
  nothing behind the shared `MCP_AUTH_TOKEN`, the server can't add browser-side tools (show card,
  navigate, ask), and we can't gate tools per user. Rejected.
- *Separate Vercel project*: duplicates config and secrets for no gain.

### D2. One tool registry for MCP and chat (refactor first)

Today the tools are defined inline in `lib/server.js` (`registerTool` with zod schemas). Pull them
into a registry (`lib/tools.js`: name, description, zod schema, handler, `access: "read" | "write"`)
that both `server.js` (MCP) and `api/chat.js` (Claude tool definitions via zod → JSON Schema)
consume. Without this, the two tool sets will drift, the same way CLAUDE.md already warns about
for `recipe-format.js` and the add-recipe skill.

### D3. Model and cost

Current options (per million tokens, input / output): Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10,
Haiku 5.5 $0.10 / $0.50. Prompt caching cuts the repeated prefix (system prompt + tools +
catalogue, see D6) to roughly a tenth of the input price.

The editor flow (reading screenshots, combining a shopping list, following the 190-line
`plan-recipes` guide) is the work Claude does today through the MCP, so it needs a strong model:
**Opus 5.5** (recommended). Anonymous Q&A is lighter. **To decide:** run it on the same model too
(one prompt, one cache, simplest), or on a cheaper model to keep public traffic cheap. A rough
plan-recipes run is ~10–20 model calls with a cached prefix: cents, not dollars, but with no limits
public traffic has no upper bound (see §8).

Use streaming (needed for the chat UX anyway), adaptive thinking with effort set per mode, and the
`web_fetch` server tool for recipe links in editor mode.

## 4. Modes and auth

| | Anonymous | Signed-in editor |
| --- | --- | --- |
| Read tools (list, search, get recipe, shopping list) | ✓ | ✓ |
| Navigate / show cards / quick replies | ✓ | ✓ |
| Write tools (create, update, promote, remove draft, set current, shopping list) | – | ✓ |
| Image attachments (recipe screenshots) | – (D9) | ✓ |
| `web_fetch` of links | – | ✓ |
| Chat history | this browser only | synced across devices |

**Auth reuses the shopping page's Supabase sign-in** (email + password, code fallback). Extract
the sign-in sheet and session handling from `templates/shopping.js` into a shared
`templates/auth.js`; both pages keep the session under the same `localStorage` key, so signing in
on one signs you in on the other (same origin). Generalise `SHOPPING_EDITORS` to `EDITORS` (keep
the old name as a fallback).

**Tools are gated on the server, never in the prompt.** `/chat` verifies the token on every
request, and an anonymous request is sent to Claude **without** the write tools in `tools`. A
jailbreak can't call a tool that isn't there.

## 5. Conversations and persistence

### D4. Where chats live → **Supabase Postgres, server-owned** (recommended for editors)

Git is out: every commit is a site deploy. We already have a Supabase project.

- **Editors:** `conversations` (id, user email, title, created/updated, archived) and `messages`
  (conversation id, role, content JSON incl. tool calls/results, created). Only `/chat` touches
  them, with the service-role key. The client sends `{ conversation_id, message, page }`, never the
  history. **This matters for safety**: if the client sent the history, anyone could fabricate an
  earlier "tool result" or assistant turn and steer a write-capable agent.
- **Anonymous:** transcript in `localStorage` only; the client sends the history and the server
  treats it as untrusted (read tools only, so the worst case is a strange answer). Cap the size
  (last ~20 turns).

UI: the panel header has a "Chats" list (title, last updated) and "New chat". The server titles a
chat after its first exchange. A chat open in the panel stays open across page loads (see §7).

Gaps to settle: retention (suggest: auto-archive after 30 days idle, delete after 180); a very long
chat (use server-side compaction instead of truncating); whether both editors see each other's
chats (suggest **yes**: it's one family's kitchen, see D5).

## 6. Tools

### Read (everyone)

| Tool | Notes |
| --- | --- |
| `search_recipes` | **New.** Filters: text, ingredients (include/exclude, matched on the bolded ingredient names), course, tags, max calories, max minutes, status (draft/current/other). Returns compact rows. "Chicken under 300 kcal" needs ingredient matching, which `list_recipes` doesn't have. |
| `get_recipe` | Existing. |
| `get_shopping_list` | Existing ("do we need eggs?"). |

### D6. Catalogue in the prompt vs. search tool → **both** (recommended)

58 recipes as a compact catalogue (slug, title, course, tags, mins, kcal, status, key ingredients)
is ~8–10k tokens. Putting it in the cached system prompt lets the model recommend from the whole
book ("something light and warming") without a tool call; `search_recipes` stays for exact filters
and stays correct as the book grows. The catalogue comes from GitHub (like `listRecipes` does)
with a short in-memory cache, so the bot already knows a recipe minutes before the site redeploys
(see §9, "deploy lag").

### Write (editors)

The existing tools, unchanged in behaviour: `create_recipe`, `update_recipe`, `promote_recipe`,
`remove_draft`, `set_current_recipes`, `update_shopping_list`, `set_shopping_servings`,
`create_image_upload_link`. In chat they don't commit right away; they **stage** into the plan
tray (§7). One `apply_plan` turns the tray into a single `batch_changes` commit.

### UI tools (the server forwards these to the browser)

| Tool | Renders |
| --- | --- |
| `show_recipes({ slugs, reason? })` | A row of recipe cards (photo, kicker, name, "20 min · 412 kcal"), each linking to its page. |
| `offer_navigation({ slug \| page, label })` | A button "Open Steamed rice". Never navigates by itself. |
| `ask_user({ question, options[] })` | Quick-reply chips; the chat equivalent of `AskUserQuestion` the plan-recipes guide relies on ("Did you like the harissa pitta? Liked / Not for us / Not cooked yet"). |

These return immediately with `{ shown: true }` (or the chosen chip as the next user message), so
the loop never waits on the browser in the middle of a turn.

## 7. Advanced features

### 7.1 The plan tray ("what we've added so far")

This is the core of the editor experience, and it fits how the server already works: every commit
redeploys, so changes should be collected and saved once.

- A **plan** is a list of staged changes: new recipe drafts (full structured fields), edits,
  promotions, removals, current/not-current, servings, and finally the shopping list.
- **D5. One plan per household, not per chat** (recommended). "What have we added for next
  week" is about the week, not about a conversation; both editors, on any device, any chat, see
  and add to the same tray. Stored in Supabase (`plans`: status `open | applied`, items JSON,
  updated by, updated at).
- The panel shows a **tray strip** above the input while the plan is non-empty: small cards for
  each staged item with a status kicker (New, Edit, Promote, Remove, This week), × to drop one,
  and **Save to site (n)**. That's the same pattern as the stocktake's sticky "Save (n)" bar
  (`design.md`, "Batch writes").
- Cards for **new** recipes are previews built from the staged fields (there's no page yet): the
  source photo if we have its URL, else a placeholder until generation runs. Tapping one opens a
  read-only preview of the staged recipe (ingredients + steps) in the panel.
- Staging runs the change through `batch_changes` with `dry_run: true`, so validation errors (bad
  slug, missing calories, unknown recipe on the list) show up while chatting, not at save time.
- **Save** re-validates against the current repo (things may have changed since staging), commits
  once, empties the tray and posts a summary in the chat. The shopping list is rebuilt as the
  last step of every save that changes the current set, as `plan-recipes` already requires.
- Confirmation: Save is a **button press by the human**, not a model tool call. The model can
  suggest saving; only the user commits. That's also our main defence against prompt injection
  from fetched pages and screenshots.

Open: should single, obviously-safe edits ("fix the typo in step 3") skip the tray? Suggest no in
v1: one rule is easier to trust.

### 7.2 Page context

Every page embeds a small JSON literal at build time (allowed by the static rules):
`{ "page": "recipe", "slug": "steamed-rice", "title": "Steamed rice" }`, `{ "page": "index" }`,
`{ "page": "shopping" }`. `chat.js` adds live UI state that matters (recipe page: selected servings;
index: active filter and search text) and sends it with every message.

- The server **re-resolves** the slug itself (`get_recipe`) instead of trusting page text, and
  injects it as a short system note on that turn ("The user is viewing: Steamed rice
  (steamed-rice), serves 4, a regular recipe, not current").
- **Vocabulary clash to settle in the prompt:** on a recipe page, "add this recipe" can't mean
  create (it exists). It should mean "add it to this week" (stage `set_current_recipes`). The site
  already overloads "current"; the bot should say "this week" to users and keep "current" for
  tools.
- The panel shows the context as a dismissable chip above the input ("On: Steamed rice") so the
  user knows what "this" refers to and can drop it.

### 7.3 Navigation

- The bot only offers (`offer_navigation`); the user taps.
- It's a static site, so navigating is a full page load. `chat.js` has to restore the panel: open
  state and the active conversation id in `sessionStorage`, history re-fetched (editor) or read
  from `localStorage` (anonymous). The new page's context is picked up on the next message.
- Don't offer to navigate while a reply is still streaming; it would cut the stream.
- **Deploy lag:** a recipe saved a minute ago has no page yet. Cards and links for just-saved
  recipes show "Publishing…" and stay disabled until the page exists (the server can check with a
  HEAD request to the Pages URL; the client asks `/chat/status`, not the Pages URL directly).

## 8. Safety, abuse and cost

- **Rate limits** on `/chat`: per IP for anonymous (e.g. 20 messages/hour), per editor more
  generous. Store counters in Supabase (no new service). A daily global spend cap on top, plus
  the spend limit in the Anthropic console.
- **Anonymous at all?** (open question Q1). The site is public; if visitors are only family, the
  simplest safe option is "sign in to chat". Recommendation: allow anonymous read-only chat with
  tight limits, since recommending recipes to guests is part of the charm, and close it if abuse
  shows up.
- **Prompt injection** from fetched recipe pages and screenshots: content is data; writes only
  stage; only a human tap on Save commits; regular recipes still can't be deleted (server rule).
- **Rendering model output:** `chat.js` never puts model text into `innerHTML`. A tiny renderer
  supports paragraphs, bold, lists and links, and allows only links to the site's own origin
  (anything else is shown as plain text). Cards are built from server data, not model text.
- **Secrets:** nothing secret in the prompt; the Supabase service key and Anthropic key live only
  in Vercel env.
- **Privacy:** chats are stored. Say so in the panel's first-run line.

## 9. UI (to add to design.md when built)

Follow `design.md`: stroke icons (a speech-bubble icon, no emoji), orange accent, purple only for
draft kickers, calm states.

- **Bubble:** 56px round, `--accent-strong`, bottom-right with 16px + safe-area inset. Unread dot
  when a reply finished while the panel was closed.
- **Panel:** on a phone, a full-height bottom sheet (reusing `.sheet`); from 720px, a 400×640
  floating panel anchored to the bubble. Header: chat title, Chats list, New chat, close.
- **Collisions:** the shopping page has a sticky Save bar and its own bottom sheets; the recipe
  page has the cook bar. The bubble moves up above sticky bars and hides while another sheet is
  open. The recipe page's two scroll panes from 720px must not be covered.
- **Mobile keyboard:** size the panel with `visualViewport`, so the input stays above the keyboard.
- **Streaming:** text streams in; tool activity shows as one quiet status line ("Looking through
  the recipes…"), not raw tool names.
- **Wake lock:** the recipe page's "Keep screen on" keeps working while the panel is open.

## 10. Gaps found in the brief

1. **The static-site rule** needs an explicit exception for the chat (§2).
2. **Tool drift** between MCP and chat unless they share one registry (D2).
3. **Trusting client history** would let anyone forge tool results; editors' history must be
   server-owned (D4).
4. **Abuse and cost** of a public endpoint calling a paid model (§8).
5. **"Current" vs "add"**: "add this recipe" on an existing recipe's page (§7.2).
6. **Deploy lag**: saved recipes aren't on the site for a minute or two (§7.3).
7. **Full page loads** on navigation close the chat unless it's restored (§7.3).
8. **Inputs the editor flow depends on**: today you hand over screenshots and links. The chat needs
   image attachments (camera / photo library) and `web_fetch`. The recipe's own photo
   (source-link image, else generated, else the upload link) still needs to work from chat.
9. **The plan-recipes guide assumes an MCP client** (`AskUserQuestion`, one `batch_changes`). In
   chat, `ask_user` chips and the tray replace those; the guide needs a short "in chat" section
   or a chat-specific variant, kept in `mcp-server/workflows/`.
10. **Two editors at once**: a shared tray (D5) needs "last updated by" and a conflict rule (the
    server re-validates on Save; the second Save sees the first's result).
11. **Undo after save**: today nothing reverts a commit. At least show what was committed with a
    link; a revert tool is a later phase.
12. **Observability**: log tool calls, errors and token usage per chat (Vercel logs are enough for
    v1) so cost and failures are visible.

## 11. Suggested additional features

Ranked roughly by value for effort:

1. **Cooking help on recipe pages** (read-only, high value): substitutions, "what's step 4
   again?", unit conversions, scaling to 6, using the page context and the selected servings.
2. **Page-aware starter prompts** as chips when a chat is empty: on a recipe page "Add to this
   week", "Swap an ingredient"; on the index "Something quick tonight"; on the shopping page "What's
   left to buy?".
3. **"What can I make with what's at home?"** using the stocktake on `shopping-list.json`.
4. **Stocktake by chat** for editors: "we've got 6 eggs and plenty of rice" → stages the
   `/stocktake` update.
5. **Close out the week by chat**: on Sunday, ask_user chips for each draft (liked / not for us /
   not cooked), the same decisions plan-recipes asks today.
6. **Week balance**: totals for the planned week (calories, protein, how many fish/veg dinners)
   shown on the tray.
7. **Voice input** (Web Speech API, progressive) for hands-busy cooking.
8. **Diff view** for staged edits (before/after of the changed lines) on the tray card.
9. **Revert last save** (a server tool that reverts the chat's last commit).

## 12. Phases

Each phase ships and is useful on its own.

| # | Phase | Contents | Depends on |
| --- | --- | --- | --- |
| 0 | Groundwork | CLAUDE.md exception, tool registry refactor (D2), `search_recipes`, page-context JSON in the build | – |
| 1 | Read-only chat | Bubble + panel, `/chat` with streaming, catalogue prompt, anonymous mode, local history, rate limits, safe renderer | 0 |
| 2 | Cards + navigation | `show_recipes`, `offer_navigation`, panel restore across page loads, starter chips | 1 |
| 3 | Sign-in + synced chats | Shared `auth.js`, Supabase tables, chats list, server-owned history | 1 |
| 4 | Editor writes via the tray | Staging, dry-run validation, tray UI, Save → one `batch_changes`, publishing state | 2, 3 |
| 5 | Full plan-recipes in chat | Image attachments, `web_fetch`, `ask_user` chips, photo handling, chat section in the workflow guide | 4 |
| 6 | Extras | §11, picked by value | 4 |

## 13. Open questions

- **Q1.** Anonymous chat for anyone, or sign-in required? (rec: anonymous read-only, rate-limited)
- **Q2.** Model for anonymous mode: the same as editors (Opus 5.5), or a cheaper one?
- **Q3.** Plan tray per household (rec.) or per conversation?
- **Q4.** Do both editors share chat history, or is each person's history their own?
- **Q5.** Any single edits allowed to skip the tray? (rec: no, in v1)
- **Q6.** Who's an editor: the existing `SHOPPING_EDITORS` list, or a separate list for recipe
  writes?
- **Q7.** Monthly spend ceiling we're comfortable with (sets rate limits and the global cap).
- **Q8.** Retention for stored chats.
