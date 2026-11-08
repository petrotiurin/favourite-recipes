# Symptoms -> causes

What the user saw or a log line said, what it usually means, where to look, and where it lives in the code. Grep the code for the
exact text when a line isn't here; these are the ones that come up.

## What the user sees in the chat

| The panel says | Usually | Look at | Code |
| --- | --- | --- | --- |
| "That is taking longer than expected, so I've stopped here…" | The turn hit `CHAT_TURN_BUDGET_MS` (200s, checked between model calls) or a model call was still running at `CHAT_TURN_DEADLINE_MS` (250s, aborted). Typical cause: the model looping on a tool that keeps failing (e.g. `stage_update_shopping_list` rejected again and again), or a slow thinking model writing a whole shopping list | Vercel warn `Chat turn stopped after Ns`; the turn's `role='tool'` rows (repeated `Error:` / `PROBLEM on the card`); Langfuse: count of `generate-response`, their durations and `finishReason` | `lib/chat.js` (`stoppedLong`, `chatTurnBudgetMs`), `lib/config.js` |
| "Sorry, the model stopped before it finished: it ran out of room…" | `finish_reason: length`: the answer (often a big tool call) didn't fit `max_tokens` (`CHAT_EDITOR_MAX_TOKENS` / `CHAT_PUBLIC_MAX_TOKENS`) | Langfuse generation WARNING "cut off at max_tokens", its output tokens; Vercel `Chat round N was cut off` | `cutOffLine`, `logRound` in `lib/chat.js` |
| "…the connection to it ended early (most likely it took too long)" | The provider stream ended with no finish reason (timeout / provider dropped it), a half-written tool call is lost | Vercel `was cut off (dropped)`, the generation's duration in Langfuse | `streamCompletion` in `lib/chat.js` |
| "Sorry, I didn't manage to answer that. Could you try again?" | The model returned nothing at all, and nothing was cut | Vercel `Chat turn ended with no text and nothing shown`; the generation output in Langfuse | `lib/chat.js` |
| "The chat is resting, try again later." | OpenRouter 402/401/403: out of credit or a dead/revoked key | Vercel `OpenRouter answered 402 (model …)`; Langfuse event `out-of-credit`; OpenRouter credit for that key | `friendlyOpenRouterError` in `lib/chat.js` |
| "The chat is busy right now…" | OpenRouter 429 (provider rate limit) | Vercel `OpenRouter answered 429` | same |
| "This chat model can't read photos…" | The configured model has no vision; `CHAT_EDITOR_MODEL` must accept images for photo turns | Vercel `OpenRouter answered 400 … image` ; the env var on Vercel | same |
| "Something went wrong with the chat…" | Any other upstream failure, or an unexpected exception | Vercel `level:error` for `/chat` (`OpenRouter request failed`, `OpenRouter stream error`, a stack trace) | `lib/chat.js`, `api/chat.js` |
| A friendly rate-limit message (HTTP 429) | Visitor over `CHAT_PUBLIC_HOURLY_LIMIT` (20) / daily (100) / site-wide 300 an hour, or an editor over 200 an hour | Vercel `Chat rate limit (hour) hit by …`; `rate_limits` table | `lib/rate-limit.js` |
| Locked panel ("switched off" / "editors only") | `CHAT_ENABLED=false` or `CHAT_PUBLIC_ENABLED=false` on Vercel (needs a redeploy to change) | Vercel env vars | `lib/chat-switch.js` |
| Signed-in editor treated as a visitor | Their email isn't in `EDITORS` (or `SHOPPING_EDITORS`) for that environment | Vercel env vars per target (Preview vs Production differ) | `lib/auth.js`, `lib/config.js` |

## Tool results the model got (in `messages` rows with `role = 'tool'`, and the tool observations in Langfuse)

| Result | Means |
| --- | --- |
| `Error: Invalid arguments for "<tool>": <path>: Required` | The model's arguments failed the zod schema (a required field missing, wrong type). Repeated, it is what burns a turn's time budget. Check the generation's output: often the model was cut off mid-arguments or "forgot" a big field like `sections` |
| `PROBLEM on the card: …` | Staged, but the dry run found a problem (e.g. a multi-recipe shopping item without `amounts`, a kitchen measure in a quantity); the card shows it and Save refuses until it's fixed (`lib/tools.js`, `lib/operations.js`, `lib/shopping-list.js` rules) |
| `Error: "<tool>" is not available here.` / Vercel `Model asked for a tool it was not offered` | The model called a tool its role isn't offered (a visitor asking to add a recipe). Expected and harmless; WARNING "refused" in Langfuse |
| `Not allowed…` / Vercel `Refused tool …` | `dispatch()` refused by role (`lib/tools.js`); should only happen if the offered list and the registry disagree: a bug |
| `Error: too many tool calls…` / `…already read as much as it can` | Per-reply (4) / per-turn (10) / 80k-character caps in `lib/chat.js` |

## Log lines (Vercel) worth knowing

| Line | Means |
| --- | --- |
| `Chat rate limiting is on its in-memory fallback because Supabase failed.` / `Rate limit check failed, using the in-memory limiter` | Supabase RPC `rate_limit_hit` failed (Supabase down, wrong `SUPABASE_SERVICE_ROLE_KEY`, migration missing); limits still apply per instance. Check Supabase `query_logs` |
| `Editor chat is not set up: …` | Missing `OPENROUTER_CHAT_EDITOR_KEY`/`OPENROUTER_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` in that environment |
| `Saving the answer failed:` / `Saving the chat failed:` / `Loading the tray failed:` / `Saving the tray failed:` | A Supabase write/read from `lib/chat-store.js` / `lib/tray-store.js` failed; the turn may have run but not been stored. Supabase API logs at that time |
| `Photo for a staged item failed:` / `Remaking a photo failed:` | Photo from the source link or the image model failed (`lib/tray-photos.js`, `lib/image-generation.js`); Langfuse `generate-recipe-photo` with ERROR has the model's message |
| `Langfuse … failed (further failures are not logged)` | Tracing failed once (bad keys, Langfuse down); the chat is unaffected. Check the three `LANGFUSE_*` vars |
| `The … and the … are the same OpenRouter key` | Public and editor chat share a key: public traffic can spend the editor budget. Config warning, not an error |
| `Failed sign-in check (bad token) from visitor …` | An expired/invalid Supabase token was sent; the panel refreshes or asks to sign in again. Many in a row = auth misconfigured (`SUPABASE_URL`/`SUPABASE_ANON_KEY` mismatch between site build and Vercel) |
| `Purging old chats failed:` | `purge_old_chats()` RPC failed (migration missing or permissions) |

## The tray

- `status = 'finalising'` that never ends: a Finalise turn was killed (function timeout). It counts as collecting again after 6
  minutes (`FINALISE_STALE_MS` in `lib/tray.js`).
- Save answers 409: the tray changed since the panel loaded (optimistic `version`), the shopping list changed since a stocktake
  was staged, or a clash with the repo (Langfuse `tray-clash` event). `lib/plan-apply.js`.
- `expires_at` passed: the tray is 7 days old and is treated as empty.

## Deploys

- Vercel deployment CANCELED "Ignored Build Step command returned exit code 0": the commit didn't touch `mcp-server/`. Normal.
- Vercel ERROR: read the build events (`/v3/deployments/<uid>/events`).
- The site (GitHub Pages) didn't update: the Actions "deploy" run for that commit on `main`; Save's commit link is in the
  `tray-save` event in Langfuse.
