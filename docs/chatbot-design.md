# Recipe chat assistant: design

Status: **draft, iterating**. No code yet. Each phase at the end is meant to ship on its own.
Decisions are marked **D1, D2…** with a recommendation; open questions are collected at the end.

## 1. Desired outcome

A small chat bubble in the bottom-right corner of every page. Tapped, it expands into a chat panel
where anyone can ask about our recipes ("something with chicken under 300 kcal", "what can I swap
for crème fraîche here?") and get answers grounded in **our** recipe book, with links to the pages.
A signed-in editor can do in chat everything the agent does today through the MCP server: add
recipes (as drafts), edit them, promote/remove drafts, plan next week, switch weeks, and build the
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

> **Our Favourite Recipes** is the family's cooking app: the recipe book, this week's and next week's plans and the
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
| Write tools (create, update, promote, remove draft, set weeks, switch weeks, shopping list) | – | ✓ |
| Image attachments (recipe screenshots) | – | ✓ |
| `fetch_url` of links | – | ✓ |
| Model / OpenRouter key | public | editor |
| Chat history | this browser only | per user, synced across that user's devices |
| Plan tray | – | shared by the household |

Anonymous visitors can chat (decided, Q1): read-only, rate-limited, on the public model.

**Auth reuses the shopping page's Supabase sign-in** (email + password, code fallback; see 4.2). Extract
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

- A conversation is loaded only if `conversation.user_id === caller.userId` (the Supabase user id, which never changes, unlike an email); otherwise 404 (not
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

### 4.2 Sign-in methods: unchanged

The chat uses the sign-in the shopping page has today: **email + password**, with the 6-digit
email code (and its magic link) as the fallback. No new providers. What the chat does need:

- The sign-in sheet and session code move from `templates/shopping.js` into the shared
  `templates/auth.js` (no behaviour change), so every page can sign in.
- The chat lets you sign in from any page, and the magic link returns to the page it was sent
  from, so Supabase's Auth → Redirect URLs must allow the whole site
  (`https://petrotiurin.github.io/favourite-recipes/**`), not just the shopping page.
- Signing in restores the open chat, conversation and unsent message (the same `sessionStorage`
  restore as navigation, §7.3).

Considered and deferred: Google sign-in (free; it would match accounts by verified email, and
needs a design.md exception for Google's button style) and Apple sign-in (needs the $99/year Apple
Developer Program and a secret renewed every 6 months). Either can be added later without
server changes: they produce the same Supabase session, and the `EDITORS` check stays the gate.

## 5. Conversations and persistence

### D4. Where chats live → **Supabase Postgres, server-owned** (recommended for editors)

Git is out: every commit is a site deploy. We already have a Supabase project.

- **Editors:** `conversations` (id, Supabase user id, title, created/updated, archived) and `messages`
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
| `search_recipes` | **New.** Filters: text, ingredients (include/exclude, matched on the bolded ingredient names), course, tags, max calories, max minutes, status (draft) and week (this week / next week / neither). Returns compact rows. "Chicken under 300 kcal" needs ingredient matching, which `list_recipes` doesn't have. |
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
`remove_draft`, `set_week_recipes`, `start_next_week`, `update_shopping_list`, `set_shopping_servings`,
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
  shown as outline chips: "Show me more like this", "Under 20 minutes", "Add to next week".
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

The tray is the chat's basket of changes to the site. While you chat nothing is saved; changes
collect in the tray and go live together with one **Save to site**: one commit, one deploy. Same
idea as `batch_changes` in plan-recipes and the stocktake's "Save (n)" (`design.md`, "Batch
writes").

**Weeks.** Planning always starts in **next week**: everything the chat adds to the plan goes
there. This week is never edited directly: it's next week *promoted* by the week switch
(`start_next_week`), which is its own tray item (Switch) and goes first in a batch.

**What's in it.** Staged changes: new recipes (drafts, full structured fields + photo), edits,
promotions, removals, next week / not next week, the week switch, servings, and the shopping list.
Each is a small card with a kicker (New, Edit, Promote, Remove, Next week, Switch, List), "added by" and × to drop it.
Tapping a new recipe's card opens its staged ingredients and steps (it has no page yet).

**D5. One tray per household** (decided, Q3): both editors, any device, any chat, see and add to
the same tray. Stored in Supabase (`trays`: status, items JSON, list version, created at, updated
at/by). Public callers can't see it (4.1). The panel loads the tray from `/chat` when it opens,
like the chat itself; the site's pages still never load what they show at runtime.

#### Photos are generated when a recipe is staged (decided)

Generating is cheap, and the cards are the point of the tray, so a new recipe gets its photo as
soon as it's staged, not at Save:

- Order as today: the source page's photo (`og:image` / JSON-LD), else generated with OpenRouter.
- The card shows "Making the photo…" until it's ready (generation runs in the background; the
  chat goes on).
- Staged photos live in a private **Supabase Storage** bucket (`tray-photos/<tray>/<slug>.jpg`),
  shown to editors through short-lived signed URLs. Not in git: committing them would deploy
  (the upload page uses `[skip ci]` for this today) and leave orphans when an item is dropped.
- Don't like it? "New photo" on the card regenerates; an upload link stays the fallback.
- At Save the photo bytes go into the same commit as the recipe (`images/recipes/<slug>.jpg`),
  then the staged copy is deleted. Dropping an item or the tray expiring deletes its photo too.

#### Finalise, then Save (decided)

The shopping list is written by the model (it combines and converts ingredients), while Save is a
plain button with no model in it. So the list is built **before** Save becomes available:

```
 collecting ──"Finalise list"──▶ finalising ──list staged──▶ ready ──"Save to site"──▶ saved
     ▲                              (agent)                    │
     └──────────── any change to the tray (add, drop, edit) ───┘   list marked out of date
```

- **Collecting:** the tray strip's button is **Finalise list**. There's no Save button yet.
- **Finalise list** sends a fixed request to the agent, which first says what it's doing ("I'll
  switch weeks first, then build the shopping list for next week's 5 recipes"), then:
  1. **promotes next week if needed**, as plan-recipes does: when next week already had recipes
     before this tray (the old plan, now being cooked), it stages `start_next_week` (first in the batch, so the tray's additions land in
     the new next week) and asks one `ask_user` per draft in this week (*Liked* · *Not for us* ·
     *Not tried yet*, with the recipe's card; not tried → *Keep it this week* · *Back to the book*),
     staging the answers;
  2. reads every recipe that will be in next week after Save, staged new ones included (reads inside
     a `ChangeSet` already see staged changes), and stages `update_shopping_list` (with servings).
  The tray shows "Building the list…" meanwhile.
- **Ready:** a **List** card ("86 items for 5 recipes", tap to preview by aisle) appears and the
  button becomes **Save to site (n)**.
- **Any later change** to the tray (adding, dropping or editing an item) marks the list out of
  date: the List card says so, Save goes away and **Finalise list** comes back. The list stores a
  hash of the tray items it was built from, so "out of date" is exact, not guessed.
- **Asking to save in chat** ("ok save it") while collecting: the agent explains the shopping list
  has to be made first and offers chips *Finalise list* · *Not yet*. It never saves itself; Save
  stays a tap by a person (below).
- **No list needed** when the tray doesn't change next week or the servings (e.g. only a typo fix
  or promoting a draft): Save is available straight away, no Finalise step.

#### Save

- Re-validates everything against the repo as it is now (things may have changed since staging,
  e.g. an edit through the MCP), then commits once, with the photos, and empties the tray. The
  chat gets a summary with the new cards, shown as "Publishing…" until the pages are live (§7.3).
- If a staged item clashes (its recipe was changed or removed elsewhere), Save stops and that
  card says what clashed, with *Drop it* · *Re-check*. Nothing is committed until it's resolved.
- Save is a **button press by a person**, never a model tool call. The model can suggest it; only
  the user commits. That's also the main defence against instructions hidden in fetched pages or
  screenshots: at worst they put something odd in the tray, where you see it before saving.

#### 7 days, then it expires (decided)

We shop for a week, so a tray lives **7 days from its first item**:

- The tray strip shows when it expires ("until Fri"). From a day before, opening the chat says
  "The tray expires tomorrow" with *Finalise list* / *Save to site* chips.
- On expiry the items and their staged photos are deleted. The chats that added them keep their
  history, so it can be rebuilt by asking.
- Saving empties the tray; the next item starts a new 7-day tray.
- Errors found while staging (dry-run of each change) show on the card straight away, so an
  expiring tray isn't full of surprises.

#### Quick fixes: "Save now" (decided, Q5)

A fix like "it's 35 minutes, not 25" goes into the tray as a card like everything else. If it
doesn't touch the week's plan, its card has its own **Save now**, which commits just that item (one
commit, one deploy; same re-check and same human tap as Save). The rest of the tray waits. This
stops quick fixes getting stuck behind an unfinished week or lost when a tray expires. The agent
never commits directly.

The server decides what qualifies, from the change itself:

- **Can be saved alone:** title, steps, notes, time, calories, tags, course, photo, promoting a
  draft, and ingredient edits to a recipe that isn't in next week.
- **Waits for Finalise:** new recipes, removals, adding to or taking off next week, the week switch,
  servings, and ingredient edits to a recipe in next week (they change the shopping list, so they
  mark it out of date).

### 7.2 Page context

Every page embeds a small JSON literal at build time (allowed by the static rules):
`{ "page": "recipe", "slug": "steamed-rice", "title": "Steamed rice" }`, `{ "page": "index" }`,
`{ "page": "shopping" }`. `chat.js` adds live UI state that matters (recipe page: selected servings;
index: active filter and search text) and sends it with every message.

- The server **re-resolves** the slug itself (`get_recipe`) instead of trusting page text, and
  injects it as a short system note on that turn ("The user is viewing: Steamed rice
  (steamed-rice), serves 4, a regular recipe, in this week, not in next week").
- **Vocabulary clash to settle in the prompt:** on a recipe page, "add this recipe" can't mean
  create (it exists). It should mean "add it to next week" (stage `set_week_recipes`), since
  planning is always for next week, the same as plan-recipes. The bot says "this week" and "next
  week" to users; `current` / `next` stay tool words.
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
5. **"Add" on an existing recipe**: "add this recipe" on its own page means "add to next week" (§7.2).
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
5. **Switch weeks by chat**: on the day next week starts, ask_user chips for each of this week's
   drafts (liked / not for us / not tried), the same decisions plan-recipes asks today, staged as a
   `start_next_week` on its own.
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
| 3 | Sign-in + per-user chats | Shared `auth.js` (4.2), editor key + model, Supabase tables, chats list, server-owned history | 1 |
| 4 | Editor writes via the tray | Staging with dry-run validation, `ask_user` chips (Finalise needs them), "Save now" for quick fixes, household tray UI ("added by", 7-day expiry), photos generated on staging (Supabase Storage), Finalise list → Save → one `batch_changes`, clash handling, publishing state | 2, 3 |
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
- Tray: photos generated when a recipe is staged; the shopping list is built by "Finalise list" before Save appears; a tray expires 7 days after its first item; quick fixes that don't touch the week get their own "Save now" (7.1, Q5).
- Sign-in stays email + password + email code; no Google or Apple for now (4.2).
- Planning always starts in next week; this week is only ever next week promoted by the switch (7.1).

Open:

- **Q9.** Which models to start with for `CHAT_PUBLIC_MODEL` and `CHAT_EDITOR_MODEL`. Suggest a
  short trial in phase 1/4: a handful of real questions and one full plan-recipes run, comparing
  tool-calling reliability and cost per chat.
- **Q10.** Credit limits for the two keys (sets how tight the public rate limits need to be).
- **Q6.** Who's an editor: the existing `SHOPPING_EDITORS` list, or a separate list for recipe
  writes?
- **Q8.** Retention for stored chats.
- **Q13.** This week is only ever next week promoted (decided). Open: *when* the promotion
  happens. When the tray's first item goes in and next week already has recipes, the agent can't
  tell whether that week has started (promote first, then plan a fresh next week) or is still being
  planned (add to it). Suggest it asks once per tray: *Next week has started* · *Still planning
  it*.
- **Q14.** Next week is now visible on the site, so "what have we added so far" partly exists there.
  The tray still earns its place (one deploy, previews before anything is public, Finalise), but
  should Save be offered per item for next-week additions too, or keep one Save for the week?
