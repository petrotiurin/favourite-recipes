# The backend (`mcp-server/`)

The recipe site's backend on Vercel, **not part of the site**: the only place with secrets and the only writer to the repo.
Settings, routes and deploys are in `README.md`; the chat's design is in `../docs/chatbot-design.md` and its working notes in
`../.claude/rules/chat.md`; the shopping list's format in `../.claude/rules/shopping-list.md`.

- It serves the MCP tools for agents (`/mcp`: add/edit recipes by committing `recipes/*.md` and `images/recipes/*` to `main`),
  `/stocktake` and `/chat` for the site. It never ships anything into `dist/`.
- Every write is a commit to `main` and every commit is a site deploy, so writes are batched (`batch_changes`, one Save per tray).
- It holds the validation rules. A recipe's fields and ingredient rules are the zod schemas in `../shared/recipe.ts` (the site's build
  validates every recipe with the same ones): the tools take their ingredient fields from there and `lib/catalogue.ts` reports its problems
  with their messages. `lib/recipe-format.ts` is how the file is written. The `add-recipe` skill's prose is the part kept in step by hand.
- **One tool registry, one dispatcher**: every tool is defined once in `lib/tools.ts` (name, description, zod schema,
  `access: "read" | "stage" | "write"`, handler) and every call, MCP or chat, goes through `dispatch(name, args, caller)`, which
  checks `caller.role` (`public` may only run `read`; `editor` and `agent` run all; a tool with no `access` counts as `write`).
  `lib/server.ts` registers the MCP tools from the registry with a frozen `{ role: "agent" }` caller. The functions that commit
  (`ChangeSet.commit` / `commitChanges` in `lib/github.ts`, `saveStocktake`, the recipe and shopping-list writers) take the caller
  and assert the role themselves. A new tool goes in the registry with its access level, and the registry test
  (`test/tools.test.ts`) covers it automatically. `toolDefinitions(role)` turns the zod schemas into OpenAI-style function tools.
- `lib/cache.ts`: a short in-memory cache (60s, cleared on commit) behind `search_recipes` and the chat catalogue.
- `lib/catalogue.ts`: the ingredient catalogue (`../data/ingredients.json`): name resolution, conversions, the write-time ingredient
  checks, `applyCatalogueChange`.
- `workflows/`: the agent workflows the server serves (`plan-recipes.md`, `ocado-shop.md`, `sainsburys-shop.md`) as MCP prompts and
  through `get_workflow_guide`; `shared/` holds the rules every shop flow includes (change a shared rule there, shop-specific
  products in the shop's own guide). A server deploy updates them for every client.
- **TypeScript, run as written.** `api/`, `lib/`, `scripts/` and `test/` are `.ts` (strict, `erasableSyntaxOnly`: no enums, namespaces or
  parameter properties; use `declare` for fields a subclass sets). Node 24 strips the types, so relative imports keep the `.ts` extension. `npm test`
  runs `tsc -p .` first, then `node --test` on the `.ts` tests. Vercel only ships `.ts` files named in `vercel.json`'s `includeFiles`: a new top-level
  folder the functions import from must be added there. Data shapes come from `../shared/` (zod); much of the older code is typed with explicit `any`
  at its JSON edges (GitHub, OpenRouter, Supabase rows): tighten as you touch it.
- Local harness: `npm run dev` (`scripts/dev.ts`): backend on :8787 and the built site on :4000 with fake GitHub / OpenRouter /
  Supabase (`scripts/fakes.ts`) and sign-in accounts; the test accounts and ports are at the top of `scripts/dev.ts`.

## Calling real APIs from Node in a cloud session

In a Claude Code cloud session, API keys (e.g. OpenRouter) are added by the session's HTTPS proxy, not kept in environment variables.
`curl` goes through the proxy, but Node's built-in `fetch` ignores `HTTPS_PROXY` and connects directly, so the key is never added: OpenRouter
answers 401 ("No cookie auth credentials found"), which the photo reader reports as "out of credit". Run such scripts with
`NODE_USE_ENV_PROXY=1` and give the code a placeholder key (e.g. `OPENROUTER_CHAT_VISION_KEY=proxy-injected`) so it doesn't skip the call;
the proxy replaces the `Authorization` header.
