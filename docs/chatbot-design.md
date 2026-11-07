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

## 2. Reframing CLAUDE.md (lands in phase 0)

CLAUDE.md still describes the original idea, a lightweight Notion replacement ("Originally migrated
from a Notion database", "Hard constraint: static first", exceptions bolted on one by one). The site
has long outgrown that: an MCP server, an agent workflow, sign-in, a stocktake that writes from the
browser, and now a chat. Rather than adding a third exception, **rewrite the framing** so the rules
describe what the project is now. Proposed shape:

> **Our Favourite Recipes** is the family's cooking app: the recipe book, this week's plan and the
> shopping list. It has three parts:
>
> 1. **The site** (GitHub Pages): static HTML/CSS built from `recipes/*.md` and
>    `shopping-list.json`. Every page is complete and readable with JS off.
> 2. **Enhancements** (`templates/*.js`): hand-written vanilla JS, copied verbatim into `dist/`. No
>    frameworks, no bundler, no npm packages in `dist/` (small pinned CDN libraries only if truly
>    needed). They may call **our own backend** and Supabase Auth, never third-party APIs directly.
>    Pages render from data baked in at build time; runtime calls are only for actions (saving a
>    stocktake, chatting, signing in), never to load what the page shows.
> 3. **The backend** (`mcp-server/` on Vercel): the only place with secrets and the only writer to
>    the repo. It serves the MCP tools for agents, `/stocktake` and `/chat` for the site, and holds
>    the validation rules. Every write is a commit to `main`, and every commit is a deploy, so
>    writes are batched.

The current "Hard constraint" section, its list of allowed scripts and the stocktake exception
fold into points 2 and 3. Sections that stay as they are: recipe schema, shopping list format,
stocktake details, deployment. New sections: "Chat" (a short summary pointing to this doc, later
to the code) and the env vars it needs. The directory layout gains `templates/chat.js`,
`templates/auth.js`, `mcp-server/api/chat.js` and `mcp-server/lib/tools.js`.

What the chat must still respect under the new rules:

- `templates/chat.js` is vanilla JS and talks only to `/chat` (and Supabase Auth via the shared
  `auth.js`). With JS off there's no bubble and nothing else changes; if `/chat` is down, the
  bubble shows an error and the page is unaffected.

## 3. Architecture

```
GitHub Pages (static)                     Vercel (mcp-server/)                    External
┌──────────────────────┐   POST /chat    ┌───────────────────────────────┐
│ every page           │ ─────────────▶  │ api/chat.js                   │ ───▶ OpenRouter (stream;
│                      │                 │                               │      public or editor key)
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
- *Letting a hosted model call our own `/mcp` directly*: least code, but tools are then all-or-
  nothing behind the shared `MCP_AUTH_TOKEN`, the server can't add browser-side tools (show card,
  navigate, suggested replies), and we can't gate tools per user. Rejected.
- *Separate Vercel project*: duplicates config and secrets for no gain.

### D2. One tool registry for MCP and chat (refactor first)

Today the tools are defined inline in `lib/server.js` (`registerTool` with zod schemas). Pull them
into a registry (`lib/tools.js`: name, description, zod schema, handler, `access: "read" | "stage" | "write"`, see 4.1)
that both `server.js` (MCP) and `api/chat.js` (Claude tool definitions via zod → JSON Schema)
consume. Without this, the two tool sets will drift, the same way CLAUDE.md already warns about
for `recipe-format.js` and the add-recipe skill.

### D3. Models and spend → **OpenRouter, two keys, two models** (decided)

The server already uses OpenRouter for photos (`lib/image-generation.js`), so the chat goes through
it as well, via its OpenAI-compatible chat completions API with tool calling and streaming.

| | Public (not signed in) | Editors (signed in) |
| --- | --- | --- |
| Key | `OPENROUTER_CHAT_PUBLIC_KEY` | `OPENROUTER_CHAT_EDITOR_KEY` |
| Spend cap | the key's own credit limit on OpenRouter | the key's own credit limit on OpenRouter |
| Model (env var, swappable without a deploy of the site) | `CHAT_PUBLIC_MODEL`: a cheap, fast model good at tool calls | `CHAT_EDITOR_MODEL`: a strong model, since this is the plan-recipes work an agent does today through the MCP (reading screenshots, combining a shopping list) |

The existing `OPENROUTER_API_KEY` stays for photos. Keeping the keys separate means public traffic
can never spend the editors' budget, and the caps are enforced by OpenRouter, not by our code.

Consequences of going through OpenRouter:

- **The cap is a kill switch, not a limit.** When the public key runs dry, chat stops for every
  visitor until it's topped up. We still need per-IP rate limits (§8) so one person can't burn it
  in an afternoon, and `/chat` should turn OpenRouter's "out of credit" error into a friendly
  "the chat is resting, try later" message.
- **Prompt caching** depends on the model and provider. Anthropic models on OpenRouter take
  `cache_control` breakpoints; others cache automatically or not at all. Keep the prompt
  cache-friendly anyway (stable system prompt + tools + catalogue first, volatile page context
  last).
- **No provider-hosted web fetch.** Reading recipe links (editor mode) becomes our own
  `fetch_url` tool on the server: allowlisted to http(s), size and time limits, HTML reduced to
  text plus the page's `og:image` and any JSON-LD `Recipe` block (most recipe sites have one, which
  also gives us the photo URL). Not offered to the public model.
- **Model-agnostic tools.** No reliance on one provider's special tools or response shapes: tool
  schemas are plain JSON Schema, UI tools (§6) are ordinary function calls.
- **Images** (screenshots in editor mode) go as image content parts, so the editor model must
  support vision.

Streaming is needed for the chat UX anyway.

## 4. Modes and auth

| | Anonymous | Signed-in editor |
| --- | --- | --- |
| Read tools (list, search, get recipe, shopping list) | ✓ | ✓ |
| Navigate / show cards / quick replies | ✓ | ✓ |
| Write tools (create, update, promote, remove draft, set current, shopping list) | – | ✓ |
| Image attachments (recipe screenshots) | – | ✓ |
| `fetch_url` of links | – | ✓ |
| Model / OpenRouter key | public | editor |
| Chat history | this browser only | per user, synced across that user's devices |
| Plan tray | – | shared by the household |

Anonymous visitors can chat (decided, Q1): read-only, rate-limited, on the public model.

**Auth reuses the shopping page's Supabase sign-in** (email + password, code fallback), and adds
Google sign-in (4.2). Extract
the sign-in sheet and session handling from `templates/shopping.js` into a shared
`templates/auth.js`; both pages keep the session under the same `localStorage` key, so signing in
on one signs you in on the other (same origin). Generalise `SHOPPING_EDITORS` to `EDITORS` (keep
the old name as a fallback).

### 4.1 Auth model: checked in layers, failing closed

Auth is enforced on the server, at several independent layers, so that no single mistake (a tool
list built wrong, a model inventing a tool name, a forged request) can lead to a write. The prompt
is never one of the layers.

**1. Who is calling: decided once per request, from a verified token.**
`/chat` builds a `caller` from the request before anything else runs:

| Caller | How it's established | `role` |
| --- | --- | --- |
| Visitor | no `Authorization` header | `public` |
| Editor | Supabase access token, verified with Supabase (`/auth/v1/user`, as `verifyEditor` does today) **and** the email is in `EDITORS` | `editor` |
| Signed in, not an editor | valid token, email not in `EDITORS` | `public` (the panel explains why) |
| Bad or expired token | verification fails | **request refused (401)**, never downgraded to public, so the client knows to refresh or sign in again |
| MCP agent | the existing `MCP_AUTH_TOKEN` on `/mcp` | `agent` (as today) |

The `caller` is frozen (`Object.freeze`) and passed explicitly to everything below. Nothing reads
roles from the request body, the conversation, page context or model output.

**2. What the model is offered.** A public caller's request goes to the public model with only
read and UI tools in its tool list. The editor model and key are used only for `role: editor`.

**3. Every tool checks the caller itself.** This is the layer you asked for: even if layer 2 were
wrong, a write still can't run.

- Each registry entry declares `access: "read" | "stage" | "write"`. (`stage` = changes the plan
  tray, `write` = commits to the repo.)
- **One dispatcher runs every tool call**, MCP and chat alike: look up the tool by name (an
  unknown name is an error), check `access` against `caller.role`, *then* call the handler. A
  public caller calling a `stage`/`write` tool gets an error result and the attempt is logged.
- **Defence in depth inside the handlers:** the functions that commit (`ChangeSet` commit in
  `lib/github.js`, `saveStocktake`, tray writes) take the `caller` as a required argument and
  assert `role ∈ {editor, agent}` themselves. A handler that forgets the check, or a future
  code path that skips the dispatcher, still can't commit.
- **Default deny:** a tool with no `access` declared is treated as `write`. A new tool can't be
  public by accident.

**4. Saving re-checks.** "Save to site" is its own request (`POST /chat/plan/apply`), not a model
tool call. It verifies the token afresh and re-checks `EDITORS`, so removing someone from the list
takes effect at once, even mid-session. A token that expired during a long chat means signing in
again before Save, not a silent failure.

**5. Data ownership.**

- A conversation is loaded only if `conversation.user_email === caller.email`; otherwise 404 (not
  403, so ids can't be probed). Conversation ids are random UUIDs.
- The tray is household-wide but editor-only: public callers can't read it.
- Supabase tables have Row Level Security on with **no** policies for the `anon` and
  `authenticated` roles, so the browser can't read or write them directly with the public anon
  key. Only `/chat` (service-role key, server-side) touches them.

**6. Transport and browser.**

- Tokens go in the `Authorization` header, never in cookies, so CSRF doesn't apply. CORS on
  `/chat` allows only the site's origin (as `/stocktake` does).
- The session lives in `localStorage` (as on the shopping page), so XSS would leak it: the safe
  renderer (§8) and building cards from server data, not model HTML, are part of the auth story.
- Tokens are short-lived (Supabase default 1 hour) with refresh in `auth.js`; sign-out clears
  the session and the panel's cached history.

**7. Tested, not assumed.** A test walks the whole tool registry and calls every `stage`/`write`
tool with a public caller, an expired token and a non-editor email, and expects refusal each
time. It runs over the registry, so a newly added tool is covered automatically. Also tested:
loading another user's conversation (404), applying the tray without a token (401), and a forged
`role` in the request body (ignored).

**Logging:** refused tool calls and failed token checks are logged with the caller's email or
IP, but never the token.

### 4.2 Sign in with Google

Added next to the existing email + password and email code, through Supabase Auth's Google
provider. The result is the same Supabase session (access + refresh token), so everything on the
server (`verifyEditor`, the `EDITORS` check, 4.1) stays exactly as it is. **Signing in with Google
proves who you are. It doesn't make you an editor; only `EDITORS` does that.**

Sign in with Apple is **out**: it needs the Apple Developer Program ($99/year) and a client secret
regenerated at least every 6 months. Email + password and the email code cover Apple users.

**The flow (PKCE)**

1. The sheet's "Continue with Google" sends the browser to Supabase's
   `/auth/v1/authorize?provider=google&redirect_to=<this page>` with a PKCE challenge. The secret
   half (the code verifier) stays in this browser's `localStorage`.
2. Supabase hands over to Google, the person approves, and Supabase redirects back to the page
   with a one-time `?code=` in the URL.
3. `auth.js` swaps the code plus the verifier for the session (`/auth/v1/token?grant_type=pkce`),
   then removes the code from the URL.

PKCE rather than the older implicit flow the magic link uses today (tokens in the URL fragment):
the tokens never appear in the URL or browser history, and a stolen code is useless without the
verifier. It's a few lines of vanilla JS (`crypto.subtle` for the SHA-256), no library. The magic
link could move to PKCE at the same time.

**Coming back to the right place.** Sign-in leaves the page, so `auth.js` remembers where you were
(page, open chat, conversation id, an unsent message) in `sessionStorage` and restores it after the
redirect. That's the same mechanism as navigation (§7.3).

**Accounts and the editors list (the main gap)**

- **Sign-ups stay off.** Visitors don't need an account to chat, so only invited editors have one.
  Supabase then refuses a Google sign-in that doesn't match an existing user, which is what we want.
- **Matching by email.** Supabase links a Google identity to the existing invited user when Google
  vouches for the same, verified email (it does for Gmail addresses). If an editor was invited with
  a different address than their Google account, it won't match: invite them by their Google email,
  or add both. The sheet's error should say this rather than a bare "sign-in failed".
- The server keeps checking the **email on the Supabase user**, never a name or display field
  from Google.

**Setup and upkeep** (all free)

- Google Cloud project → OAuth client (type Web), consent screen asking only for `email` +
  `profile`, authorised redirect URI `https://<project>.supabase.co/auth/v1/callback`.
- Publish the consent screen (these basic scopes need no Google review), or keep it in testing
  and list the editors as test users.
- Client ID + secret go into Supabase → Auth → Providers → Google. They don't expire.

In Supabase: enable the Google provider, keep sign-ups off, and widen Auth → URL Configuration →
Redirect URLs from the shopping page to the whole site (`https://petrotiurin.github.io/favourite-recipes/**`),
since the chat lets you sign in from any page.

Cosmetic: the Google consent screen says "continue to `<project>.supabase.co`" unless the Supabase
project has a custom domain (a paid add-on). Fine for a family site.

**UI (sheet order)**

1. **Continue with Google**: a full-width button at the top.
2. "or", then email + password, as today.
3. "No password? Email me a code", as today.

After a Google sign-in the sheet doesn't offer "Set a password" (no need). The avatar menu shows
which method you used.

**design.md exception:** Google's branding rules require its own button style: white (or dark)
with the standard multicolour "G". That breaks "one accent, no other hues", so design.md should
list it as a deliberate exception, limited to that one button on the sign-in sheet.

**Edge cases**

- **In-app browsers** (opening the site from inside Instagram, WhatsApp etc.): Google blocks
  sign-in in embedded webviews. Detect it where possible and suggest "Open in Safari/Chrome"; email
  sign-in still works there.
- **Added to the home screen on iOS:** the redirect may finish in Safari instead of the home-screen
  app, leaving the app signed out. Email code sign-in works inside it.
- **Signing out** signs you out of the site only, not of your Google account.

This is also a change to the shopping page's sign-in (it moves into the shared `auth.js`), so the
CLAUDE.md stocktake section and the Setup paragraph need updating with it.

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

**History is per user** (decided, Q4): each editor sees only their own chats, on any of their
devices. The shared thing between editors is the plan tray (D5), not the conversations, so a tray
item records who added it and shows a one-line reason ("added by Petro: from the chat about quick
dinners") instead of linking into a chat the other person can't open.

Gaps to settle: retention (suggest: auto-archive after 30 days idle, delete after 180); a very long
chat (summarise older turns on the server once a chat passes a size limit, instead of dropping
them).

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
| `suggest_replies({ replies[] })` | Tappable suggested replies under the bot's message (see 6.1). |
| `ask_user({ question, options[], multi? })` | A question that needs an answer before going on; the chat version of `AskUserQuestion`, which the plan-recipes guide relies on ("Did you like the harissa pitta? Liked / Not for us / Not cooked yet"). |

These return immediately with `{ shown: true }`, and the tapped reply arrives as the next user
message, so the loop never waits on the browser in the middle of a turn.

### 6.1 Suggested replies (on most turns)

Tappable answers are the main way to drive the chat on a phone; typing is the fallback, always
available.

- **Almost every bot message ends with 2–4 suggested replies.** The system prompt asks for them
  whenever there's a likely next step, and the server nudges with a reminder on turns that end
  without any. They're skipped only when the reply is a plain fact with no obvious follow-up.
- **Two kinds, drawn differently.** *Suggestions* (`suggest_replies`) are optional next steps,
  shown as outline chips: "Show me more like this", "Under 20 minutes", "Add to this week".
  *Questions* (`ask_user`) need an answer: solid chips, and the input placeholder reads "Or type
  an answer". `multi: true` allows several choices plus "Done" (e.g. picking which of five
  recommendations to add).
- **A reply is short words, never a sentence**: at most ~30 characters, sentence case, no emoji
  (design.md). The tapped text is sent as the user's message, so the transcript reads naturally.
- **Chips that act** can carry a hidden action instead of text, for things the UI does itself:
  `{ label: "Open Steamed rice", action: { navigate: "steamed-rice" } }`, `{ label: "Save to site",
  action: "apply_plan" }`. Save is still a tap by a person (§7.1): the chip just puts the button
  where the thumb is.
- **Only the last message's chips are live.** Older ones fade and stop responding once the chat
  moves on, so an old "Yes, remove it" can't be tapped by mistake.
- **Empty chat:** page-aware starter chips (§11) use the same component.
- **Repeated decisions** in plan-recipes (liked / not liked for each leftover draft) are one
  `ask_user` per draft in sequence, each with the recipe's card above the chips, rather than a long
  typed answer.

## 7. Advanced features

### 7.1 The plan tray ("what we've added so far")

This is the core of the editor experience, and it fits how the server already works: every commit
redeploys, so changes should be collected and saved once.

- A **plan** is a list of staged changes: new recipe drafts (full structured fields), edits,
  promotions, removals, current/not-current, servings, and finally the shopping list.
- **D5. One plan per household, not per chat** (decided, Q3). "What have we added for next
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

- **Spend caps** are the credit limits on the two OpenRouter keys (D3): public traffic can't touch
  the editors' budget.
- **Rate limits** on `/chat` on top, so the public cap isn't burned by one visitor: per IP for
  anonymous (e.g. 20 messages/hour, 100/day), plus a cap on message length and turns per chat.
  Editors get generous limits. Counters in Supabase (no new service).
- **Public chat is read-only**: it gets the public key, the public model, the read and UI tools,
  no attachments and no `fetch_url`.
- **Prompt injection** from fetched recipe pages and screenshots: content is data; writes only
  stage; only a human tap on Save commits; regular recipes still can't be deleted (server rule).
- **Rendering model output:** `chat.js` never puts model text into `innerHTML`. A tiny renderer
  supports paragraphs, bold, lists and links, and allows only links to the site's own origin
  (anything else is shown as plain text). Cards are built from server data, not model text.
- **Secrets:** nothing secret in the prompt; the Supabase service key and both OpenRouter keys live
  only in Vercel env.
- **`fetch_url`** only fetches public http(s) URLs (no private IPs or localhost), with size and
  time limits, so it can't be used to probe Vercel's network.
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

1. **CLAUDE.md's framing** (Notion replacement, static-first with exceptions) no longer fits;
   rewrite it (§2).
2. **Tool drift** between MCP and chat unless they share one registry (D2).
3. **Trusting client history** would let anyone forge tool results; editors' history must be
   server-owned (D4).
4. **Abuse and cost** of a public endpoint calling a paid model (§8).
5. **"Current" vs "add"**: "add this recipe" on an existing recipe's page (§7.2).
6. **Deploy lag**: saved recipes aren't on the site for a minute or two (§7.3).
7. **Full page loads** on navigation close the chat unless it's restored (§7.3).
8. **Inputs the editor flow depends on**: today you hand over screenshots and links. The chat needs
   image attachments (camera / photo library) and our own `fetch_url` (D3: no hosted web fetch
   through OpenRouter). The recipe's own photo (source-link image, else generated, else the upload
   link) still needs to work from chat.
9. **The plan-recipes guide assumes an MCP client** (`AskUserQuestion`, one `batch_changes`). In
   chat, `ask_user` chips and the tray replace those; the guide needs a short "in chat" section
   or a chat-specific variant, kept in `mcp-server/workflows/`. It was also written for a strong
   Claude model: check that the editor model follows it, and tighten the guide where it doesn't.
10. **Two editors at once**: a shared tray (D5) with per-user chats means each tray item records
    who added it and why, and a conflict rule (the server re-validates on Save; the second Save
    sees the first's result).
11. **Undo after save**: today nothing reverts a commit. At least show what was committed with a
    link; a revert tool is a later phase.
12. **Observability**: log tool calls, errors and token usage per chat (Vercel logs are enough for
    v1) so cost and failures are visible.

## 11. Suggested additional features

Ranked roughly by value for effort:

1. **Cooking help on recipe pages** (read-only, high value): substitutions, "what's step 4
   again?", unit conversions, scaling to 6, using the page context and the selected servings.
2. **Page-aware starter prompts** as chips (the suggested-reply component, 6.1) when a chat is empty: on a recipe page "Add to this
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
| 0 | Groundwork | CLAUDE.md rewrite (§2), tool registry refactor (D2) with the dispatcher, `access` levels and the registry-wide auth test (4.1), `search_recipes`, page-context JSON in the build | – |
| 1 | Read-only chat | Bubble + panel, `/chat` streaming through OpenRouter (public key + model), catalogue prompt, anonymous mode, local history, rate limits, safe renderer, suggested replies (6.1) | 0 |
| 2 | Cards + navigation | `show_recipes`, `offer_navigation` and action chips, panel restore across page loads, starter chips | 1 |
| 3 | Sign-in + per-user chats | Shared `auth.js` (PKCE), Google sign-in (4.2), editor key + model, Supabase tables, chats list, server-owned history | 1 |
| 4 | Editor writes via the tray | Staging, dry-run validation, household tray UI ("added by"), Save → one `batch_changes`, publishing state | 2, 3 |
| 5 | Full plan-recipes in chat | Image attachments, `fetch_url`, `ask_user` chips, photo handling, chat section in the workflow guide | 4 |
| 6 | Extras | §11, picked by value | 4 |

## 13. Decisions and open questions

Decided:

- **Q1.** Anyone can chat; visitors who aren't signed in get read-only chat.
- **Q2.** Public and editor chats use different models, both through OpenRouter, each on its own
  key with its own spend cap (D3).
- **Q3.** One plan tray per household (D5).
- **Q4.** Chat history is per user (§5).
- Suggested replies on most turns (6.1).
- CLAUDE.md gets reframed rather than patched (§2).
- Sign-in: Google, email + password, email code. No Apple (4.2).

Open:

- **Q5.** Any single edits allowed to skip the tray? (rec: no, in v1)
- **Q9.** Which models to start with for `CHAT_PUBLIC_MODEL` and `CHAT_EDITOR_MODEL`. Suggest a
  short trial in phase 1/4: a handful of real questions and one full plan-recipes run, comparing
  tool-calling reliability and cost per chat.
- **Q10.** Credit limits for the two keys (sets how tight the public rate limits need to be).
- **Q6.** Who's an editor: the existing `SHOPPING_EDITORS` list, or a separate list for recipe
  writes?
- **Q8.** Retention for stored chats.
- **Q12.** Which email each editor will use with Google, so the invites in Supabase and the
  `EDITORS` list match.
