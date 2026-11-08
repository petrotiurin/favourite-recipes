# Reading several recipe photos at once in the chat: design

Status: **proposal, not built**. Follows on from phase 5 of `docs/chatbot-design.md` (photo attachments in the editor chat).
Decisions are marked **P1, P2…** with a recommendation; open questions are at the end.

## 1. The problem

When planning next week, the family usually hands over about **6 photos** (screenshots of recipes, cookbook pages) in one
go. In the editor chat today that is slow and fragile:

| What happens | Where | Effect with 6 photos |
| --- | --- | --- |
| At most 4 photos per message | `MAX_PHOTOS = 4` in `templates/chat.js`, `MAX_IMAGES = 4` in `mcp-server/lib/chat-uploads.js` | Has to be split over two messages. |
| At most 4 photos re-sent to the model | `REPLAY_MAX_IMAGES = 4` in `lib/chat-store.js` (newest first) | After a 4 + 2 split, the next turn sees the 2 new photos and only 2 of the first 4. Unstaged recipes from the first message are lost or written from memory. |
| The model types each recipe out as tool arguments | `stage_create_recipe` takes the whole recipe | 1–2k output tokens per recipe (plus thinking), so about 10k+ tokens written **one after another** by one model. That is the slow part. |
| Turn limits | `MAX_CALLS_PER_ROUND = 4`, `MAX_TOOL_CALLS_PER_TURN = 10`, `MAX_TOOL_ROUNDS = 6` in `lib/chat.js`; `CHAT_TURN_BUDGET_MS` 200s; `CHAT_EDITOR_MAX_TOKENS` 16k | Six recipes plus reading the catalogue sits right at the edges: "taking longer than expected", or a reply cut off at `max_tokens`. |
| Tool calls run one at a time | the `for (const call of result.toolCalls)` loop in `runChat` | Small cost: staging is a dry run of a few hundred ms. |
| Request size | `MAX_EDITOR_BODY_BYTES = 4_300_000` in `api/chat.js` (Vercel allows 4.5 MB) | 6 photos as base64 in one request only fit when each is small (about 500 KB). |

What is already fine: the recipe's own photo is made in the background after staging (`startPhotoJob` in `lib/tray.js`), so
photo generation never blocks the turn.

### Why "let the model make parallel tool calls" doesn't help much

A model can ask for several tool calls in one reply, and we could run those calls with `Promise.all`. But the time goes
into **writing** the calls, not running them: all six recipes are still written token by token in one stream by one model.
Running the stage calls at the same time would also clash on the tray's optimistic `version` in `mutate()` and retry, so
they would run one after another anyway.

Real parallelism means **several model calls at once**, one per photo, run by the server.

## 2. Proposal

### 2.1 Read photos in parallel on the server (P1)

A new editor-only read tool, **`read_recipe_photos`**:

```js
read_recipe_photos({ photos: [1, 2, [3, 4], 5, 6] })   // numbers among the photos on the user's latest message; an inner list = one recipe over several photos
```

- The server makes one vision call per entry (a photo, or a group of photos of one recipe), **all at the same time**
  (`Promise.all` with a concurrency limit of about 6).
- Each call gets only: its photo(s), the "Writing a recipe that passes first time" section of `workflows/plan-recipes.md`,
  the course list, and a structured response schema (the same zod shape as `stage_create_recipe`, sent as `response_format`
  JSON schema or as a single forced tool). **No tools, no history, no catalogue.**
- Each result is checked with the real validation (a dry run of `create_recipe` through `runOperation`, as staging does),
  and matched against the catalogue by title for possible duplicates.
- The results are kept server-side for the conversation under short ids (`photo-1`, `photo-3+4`, …). See P3.
- The tool returns a **short summary** to the main model, not the recipes:

```
photo-1: "Miso aubergine" · serves 2 · 540 kcal (estimated) · 35 min · ok
photo-2: "Lemon chicken orzo" · serves 4 · 610 kcal · 40 min · ok · looks like "lemon-chicken-orzo" already in the book
photo-3+4: "Dal makhani" · serves 4 · kcal missing (estimated 480) · 60 min · ok
photo-5: unreadable: no amounts visible, ask for a better photo
photo-6: "Crispy gnocchi traybake" · serves 2 · 590 kcal · 30 min · warning: "Parmesan" has no quantity
```

With 6 photos the whole read takes about as long as the slowest photo (about 15–30s) instead of the sum of all six.

Recommended: **a tool the main model calls** (not something the server does by itself on every message), so the main model
still decides how photos group into recipes, can skip a photo that is a dish photo for `photo_from_attachment`, and can
ask with `ask_user` first when it isn't clear.

Alternative considered: the server starts reading by itself as soon as an editor's message carries 2+ photos, in parallel
with the first model call, and puts the summary in the prompt. That saves one round, but it guesses the grouping and wastes
calls on photos that aren't recipes. It could be added later as a warm-up (start reading, let the tool pick up the
results already running).

### 2.2 Stage from what was read (P2)

`stage_create_recipe` gets a new optional field **`from_photo: "photo-3+4"`**. The server takes the recipe it read and
lets any other passed fields override it (`course`, `tags`, `serves`, a corrected title, …). The main model then writes
about 30 tokens per recipe instead of 1–2k:

```js
stage_create_recipe({ from_photo: "photo-1" })
stage_create_recipe({ from_photo: "photo-3+4", course: ["Dinner"] })
```

- Staging still goes through the same dry run, so problems still show on the card at once.
- `photo_from_attachment` and `image_url` work as today. A screenshot of a recipe's text is never the recipe's photo
  (`asksToUsePhoto` stays the gate).
- Because each call is now tiny, `MAX_CALLS_PER_ROUND` can allow up to 8 calls when they are all `from_photo` stage calls,
  so six recipes are staged in one round. The stage calls still run one after another (the tray is one row with an
  optimistic version), which takes a few seconds in total.

Alternative considered: one `stage_many([...])` tool. Not needed once each call is small, and one card per call keeps
errors attached to the right recipe.

### 2.3 Where read recipes are kept (P3)

Options:

1. **In the conversation's messages** (recommended): stored as a hidden `tool`-style row in `messages` for that
   conversation (`lib/chat-store.js`), with the uploaded photo paths. Survives a second turn ("use photo-2 but make it
   serve 4"), is deleted with the chat, and is only for the editor who owns the conversation.
2. In memory for the turn only. Simpler, but a follow-up turn would have to read the photo again.

Read recipes expire with the chat (two weeks) and never go to the site until staged and saved.

### 2.4 More photos per message (P4)

- Raise `MAX_PHOTOS` (client), `MAX_IMAGES` (server) and `REPLAY_MAX_IMAGES` to **8**.
- Request size: 8 photos don't reliably fit in one 4.3 MB request. Recommended: **upload each photo on its own** as soon
  as it is picked: `POST /chat/uploads` (editor only, same `sanitizeUploads` checks, stored in `chat-uploads`), which
  returns a path. The message then sends `image_paths` instead of data URLs. The uploads also run in parallel while the
  editor types, so sending is instant. The data URL route stays for older pages until they reload.
- Once photos are read by `read_recipe_photos`, the main model mostly needs the summaries, not the pixels, so replay can
  stay modest: only the newest 4 photos as image parts, the rest as `[photo-3, read: "Dal makhani"]` text notes.

## 3. Models, cost and limits

- The per-photo reader uses its own model and key settings: `CHAT_EXTRACT_MODEL` (a cheap, good vision model), falling back
  to `CHAT_EDITOR_MODEL`, on the editor key (`OPENROUTER_CHAT_EDITOR_KEY`). Its own `max_tokens` (about 4k; it writes one
  recipe and doesn't need long thinking).
- Each photo read counts toward the editor's rate limit (200 per hour per user) as one call, so a message with 6 photos
  costs 6. At most 8 photos per `read_recipe_photos` call, and at most one such call per turn (counted in
  `MAX_TOOL_CALLS_PER_TURN` as one).
- One photo failing (timeout, refusal, unreadable) doesn't fail the others: its line in the summary says why.
- The turn time limit (`CHAT_TURN_BUDGET_MS`) also covers the parallel reads. The reader gives each call its own timeout
  (about 60s) so one slow photo can't use up the turn.
- Langfuse: each photo read is its own generation under the turn's trace (`photo read 3+4`), with the image redacted as
  today (`redactImages`).

## 4. Safety

- Text in a photo is untrusted source material. The reader has **no tools** and can only return the response schema, so
  instructions written in an image can't do anything. Its output is checked by the same validation as any staged recipe.
- `read_recipe_photos` is `access: "read"` with `editorOnly: true`, enforced in `offeredTools`, `dispatch` and the handler,
  like `fetch_url`. Not registered on `/mcp`. The registry test (`test/tools.test.js`) covers it automatically.
- `from_photo` only resolves ids from the caller's own conversation. Another conversation's id is "not found".
- Nothing commits: reading and staging both stay in the tray until Save, as today.

## 5. Changes

| File | Change |
| --- | --- |
| `mcp-server/lib/photo-reader.js` (new) | the parallel reader: one vision call per photo/group, concurrency limit, per-call timeout, schema, validation, duplicate check |
| `mcp-server/lib/tools.js` | `read_recipe_photos` (read, editor only); `from_photo` on `stage_create_recipe` |
| `mcp-server/lib/chat.js` | per-round limit allowing up to 8 `from_photo` stage calls; status line "Reading 6 photos…" with progress per photo |
| `mcp-server/lib/chat-store.js` | keep read recipes with the conversation; replay notes for read photos; `REPLAY_MAX_IMAGES` |
| `mcp-server/lib/chat-uploads.js`, `api/chat.js` | `MAX_IMAGES` 8; `POST /chat/uploads`; `image_paths` on the message |
| `templates/chat.js` | `MAX_PHOTOS` 8; upload each photo on pick, with a per-photo progress state on its chip |
| `mcp-server/lib/config.js` | `CHAT_EXTRACT_MODEL`, `CHAT_EXTRACT_MAX_TOKENS` |
| `mcp-server/workflows/plan-recipes.md` ("In chat") | with 2+ photos: call `read_recipe_photos` once, ask about anything unreadable or doubtful, then stage with `from_photo` |
| `mcp-server/scripts/fakes.js` | fake reader responses for `npm run dev` |
| `docs/chatbot-design.md`, `CLAUDE.md`, `mcp-server/README.md`, `design.md` (upload progress on chips) | updated in the same change |
| tests | reader runs in parallel (fake model with delays), one failure doesn't sink the rest, `from_photo` overrides, cross-conversation ids refused, limits |

## 6. Phasing

1. **Quick relief (no new tool):** photo limits to 6 everywhere (with a smaller per-photo size so 6 fit in one request),
   `REPLAY_MAX_IMAGES` to 6, and a workflow line "stage each recipe as soon as you've read it, at most 2 per reply". More
   reliable, not faster.
2. **Parallel reading:** P1 + P2 + P3. This is the speed-up.
3. **Separate uploads:** P4, up to 8 photos, instant send.

## 7. Open questions

- **PQ1.** Which vision model for `CHAT_EXTRACT_MODEL`? Try a few on a set of real screenshots and cookbook pages and
  compare accuracy (amounts, steps) and cost per photo.
- **PQ2.** 6 or 8 photos per message?
- **PQ3.** Should the server start reading photos by itself as soon as they arrive (the warm-up in 2.1), or wait for the
  model to ask?
