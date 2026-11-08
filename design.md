# UI design

How the site looks and behaves. Keep this file in step with `styles/style.css` and the
templates: when a change adds or alters a pattern, update the matching section here.

The site is static HTML + one stylesheet + small vanilla JS (see CLAUDE.md, "Hard constraint").
Every page must read fine with JS off; JS only adds interaction on top.

The look is **"Journal"**: a family cookbook you flick through. Recipe names and headings in a
serif, everything you read while cooking in a plain sans, black ink on white, square-cornered
photos. Photos lead every list, because that's how we pick what to cook next.

## Principles

- **Phone first.** Most use is on a phone, in the kitchen or the shop. Lay out for a 390px
  wide screen with a 16px gutter, then let wider screens breathe (the shopping page caps at
  560px, recipe pages use a two-column layout from 720px).
- **Icons over words, but never a puzzle.** Prefer an icon plus a number to a sentence. Keep
  one short hint where a gesture isn't obvious (for example "slide or tap sides = some", "tap = all"), and
  give every icon-only control an `aria-label`.
- **Photos first, chrome quiet.** No boxes, borders or shadows around recipes: a photo, a
  small-caps kicker, the name, one short meta line. Status lives in words (kickers, filter
  names), not tinted cards or dashed borders.
- **No emoji in the UI.** Meta reads as plain words ("20 min · 566 kcal"); icons are the stroke
  SVGs below.
- **One accent.** Orange is the only accent colour, and also this week's colour. Two reserved
  hues besides it: purple for drafts, teal (`--next`) for next week. No other colours for state
  (no green, red or blue); error messages are the one exception (a muted red box).
- **Calm states.** Highlight with low-opacity tints of the accent, not solid fills. A screen
  full of "done" rows should still look quiet.
- **Batch writes.** Every save is a commit and a site deploy, so editing UIs collect changes
  locally and send them with one explicit **Save** (with a count), plus an undo that drops
  unsaved changes. Never save on every tap.
- **Touch targets ≥ 44px**, and visible focus rings (`:focus-visible`, 2px accent outline).

## Colour tokens

Defined on `:root` in `styles/style.css`, with dark-mode values under
`@media (prefers-color-scheme: dark)`. Always use the tokens, never raw hex values in rules.

| Token | Light | Use |
| --- | --- | --- |
| `--bg` | `#ffffff` | Page background |
| `--surface` | `#ffffff` | Cards, lists, sheets |
| `--raised` | `#ffffff` | The selected segment or tab sitting on a `--track` |
| `--text` | `#161514` | Body text |
| `--text-muted` | `#6f6c68` | Secondary text, kickers, meta lines |
| `--border` | `#e7e5e1` | Rules under the top bar and meta row, card borders, dotted ingredient lines |
| `--line` | `#efedea` | Dividers between rows inside a card |
| `--track` | `#f3f2ef` | Background of segmented controls and tabs; image placeholder |
| `--accent` | `#bc5422` | Icons, focus rings, small marks (not small text) |
| `--accent-ink` | `#a44617` | Accent-coloured text: "This week" kickers and tab, "Step n", active wake lock |
| `--accent-strong` | `#a8491b` | Filled primary buttons, with `--on-accent` text |
| `--current-soft` | `#fbf1ea` | Soft accent panels: the "Home checked" card, saved state |
| `--fill-some` / `--fill-all` | accent at 5% / 10% | Fill-bar rows on the "At home" tab |
| `--fill-edge` | accent at 55% | The marker where a partial fill ends |
| `--icon-muted` | `#a39a90` | Inactive icons (an empty house, an unticked circle) |
| `--draft` / `--draft-soft` | plum `#6e4d96` | Draft recipes only: the italic "A draft: …" line under a draft's title |
| `--next` | teal `#2b6c6e` (dark `#7fc4c1`) | Next week only: the home page's "Next week · n" link, the Next week page's kickers, the recipe-page kicker |

## Type

Two Google Fonts families, loaded in `templates/layout.js` with system fallbacks (`--serif`,
`--sans` on `:root`), so the page still reads if they don't load:

- **Newsreader** (`--serif`), weight 400 only, for names and headings: the top-bar brand
  (italic), the index headline (1.9–2.75rem), tile names (1.1rem, 1.25rem from 720px, clamped to
  three lines), recipe titles (2.1–3rem), recipe h2s (1.55rem), the shopping title, and its
  aisle names (500, `font-variant-caps: all-small-caps`, 0.06em letter-spacing). Tight tracking (-0.01 to -0.025em).
- **Public Sans** (`--sans`) for everything else: ingredients, steps, controls, meta.
- **Kicker** (`.kicker`): 0.7rem, 600, uppercase, 0.12em letter-spacing, `--text-muted`;
  `.kicker-current` accent ink ("This week"), `.kicker-next` teal ("Next week"). Kickers name the week, never
  the draft status.

Numbers use `font-variant-numeric: tabular-nums` so quantities line up.

## Icon language

Inline stroke SVGs, 24×24 viewBox, 2px stroke, `currentColor`, `aria-hidden` (the control
around them carries the label). No emoji in controls.

The **house** tells how much of an item is at home:

| Icon | Meaning |
| --- | --- |
| House outline (`--icon-muted`) | None at home |
| House with its lower half filled (`--accent`) | Some at home |
| Solid house (`--accent`) | Enough at home |
| House with a cross | Clear everything at home |

Others: **cart** (the list / left to buy), **↔ arrows** (slide), **check** (ticked, saved),
**− / +** (fewer / more servings),
**undo arrow** (drop unsaved changes), **person** (sign in), **×** (close).

The definitions are duplicated in `templates/shopping-list.js` (static page) and
`templates/shopping.js` (interactive page); keep them identical.

## Recipe list (index)

Top bar: italic serif brand on the left, cart icon + "Shopping list" on the right, a rule
underneath. No headline: straight into a search field drawn as an underline with a search icon,
and the filters as plain words (active one bold and underlined): All (preselected) and the courses,
nothing else, so the row fits a phone. Weeks are not filters.

**Week heading** (`.week-head`), between the filters and the grid: "This week" on the left (accent
ink, kicker style; only when this week has recipes) and, on the right, a teal **"Next week · n →"**
link to the Next week page, or a quiet muted "Next week: not planned" when next week is empty. While a
course is picked or a search is typed, the "This week" label hides (the grid isn't this week any
more) but the link stays.

The grid is **two tiles side by side** on a phone, `auto-fill, minmax(220px, 1fr)` from 720px.
Every recipe is the same tile, with no feature slot: square photo (no radius), kicker (the week,
else the course; never "draft" or "To try"), serif name, then "20 min · 412 kcal". This week's recipes come
first; a "The rest of the book" divider spans the grid where the others start; it hides while a
filter or a search is active.

**Next week stays out of the way.** Home tiles never say "Next week": next week's recipes sit in
the rest of the book like any other. A draft that's only in next week isn't on the home page at all
(so search can't find it) until the switch makes it this week's.

## Next week page

`next-week.html` (`templates/next-week.js`), reached only from the home page's week link. Top bar
as everywhere (the shopping list stays there: no button on this page), a back link (chevron +
"This week"), a teal kicker "Planning · n recipes", the serif title "Next week" (`.page-title`), then
next week's recipes in the same grid, alphabetical, every kicker "Next week" in teal. When nothing
is planned it says so in one italic serif line. Always built, so the link never breaks.

## Recipe page

Back link (chevron + "All recipes"), kicker ("This week" and/or "Next week", then course and tags), serif title, and for
drafts one italic serif line in plum saying it's a draft (the only place a draft is marked). Then the photo: edge to edge at 4:5 on a phone,
3:2 inside the column from 720px. Under it a meta row ("**20** min · Serves **4** · **566** kcal
each"), then the **cook bar**, the page's two cooking controls, ruled off underneath: "Serves" +
the segmented control (1/2/4, the same `.seg` as the shopping page; it opens on 4, whatever
the recipe serves) on the left, and the "Keep
screen on" pill (sun icon; filled `--accent-strong` with "Screen stays on" when on) on the right.
On a phone the pill wraps under the servings, both flush left. The bar is hidden until its scripts
run; once the servings control shows, the static "Serves 4" fact in the meta row is hidden.
Ingredients have no bullets and a dotted rule between rows; each instruction is headed "Step n"
in an accent-ink kicker.
From 720px the ingredients and the instructions sit side by side as two independent panes, each
one screen tall with its own scroll: scrolling one never moves the other, and either can reach its
end. The page snaps to the panes once the header has scrolled away.

## Components

- **Card** (`.shop-card`, `.shop-list`): `--surface`, 1px `--border`, 14px radius. Rows inside
  are divided by `--line`.
- **Segmented control** (`.seg`): buttons on a `--track` pill; the selected one is `--raised`,
  bold, with a light shadow. Used for servings (1/2/4); 4 is the default on recipe pages, the
  shopping page opens on the agent's plan (with a "Plan" segment when it isn't one number).
- **Stepper** (`.stepper`): − count + on the same `--track` pill as `.seg`, 44px buttons, the
  count bold and tabular; a button at the limit (1 or 12) is disabled and muted. Used for the
  servings of single recipes.
- **Tabs** (`.tabs`): the same look as the segmented control, full width, icon + count per tab.
  A small accent dot on a tab means unsaved changes there.
- **Pill button** (`.pill`): rounded outline button, for secondary actions such as "Sign in".
- **Avatar** (`.avatar`): the signed-in editor's initial on `--accent-strong`; opens a small
  menu with the email, "Set a password" and "Sign out".
- **Primary button** (`.save-button`): full width, 52px tall, `--accent-strong` with
  `--on-accent` text. A count badge can sit inside it.
- **Text button** (`.text-button`): accent-ink text, no border; `.is-quiet` is muted and
  underlined for low-priority actions.
- **Icon button** (`.icon-button`): 48px square (or round), outline, icon only, `aria-label`.
- **Bottom sheet** (`.sheet`): slides up over a dimmed backdrop for short tasks (sign-in).
  Grip, title + one line of explanation, a close button, then the form. Escape or a tap on the
  backdrop closes it; focus moves into it.
- **Collapsible section** (`.shop-section`): a `<details open>` whose summary is the section
  label, a muted item count and a chevron (pointing right when folded). The whole heading row is
  the tap target, it works without JS, and which sections are folded is remembered in the
  browser (`localStorage`) and shared by both tabs of the shopping page.
- **Status line** (`.shopping-status`): a soft accent box for messages, muted red for errors.

## Shopping page

`templates/shopping-list.js` renders the static page; `templates/shopping.js` re-renders the
interactive part from the embedded JSON.

Under the serif title, the list's recipes appear as **photo bubbles**: overlapping 36px circles
(2px `--bg` ring) followed by "For N recipes · list made <date>". Opening that summary lists each
recipe as a link with its round photo and serif name. Aisle
section names are serif small caps, like a cookbook index.

Each list row also shows **which recipes the item is for**, as the same photo bubbles in small:
24px circles (2px `--surface` ring) between the name and the quantity, at most three, then a muted
"+n". With JS they are a button (`aria-label` "For <recipe names>"); tapping it opens a line of
chips under the row, each a link to the recipe with its round photo and title on `--track` (long
titles end in "…"), and tapping again closes it. The tick and the quantity are both labels for
the row's checkbox, so tapping anywhere but the photos still ticks. Without JS the photos show
but don't open. A ticked row's photos fade to half.

**Everyone** sees: back link and (when sign-in is configured) a "Sign in" pill; the title; "For N
recipes · list made <date>", which expands to the recipe links (each with its planned servings,
"for 2", muted on the right); the servings card; the "Home
checked <date>" card (when a stocktake exists or sign-in is configured) with **Update**; the
list, sectioned by aisle (tap a section's heading to fold it away), where each row is a round tick (kept in this browser), the name (+ a
muted note) and the quantity on the right. Partly stocked items show only what's left to buy
with the half-filled house; fully stocked items fold into "Already at home (N)". "Start again
(untick all)" appears once something is ticked.

The **servings card** opens on the agent's plan (servings per recipe). Top row: "Servings" and
the segmented control: "Plan" (only when the plan isn't the same 1/2/4 for every recipe;
otherwise that number is the plan) plus 1/2/4, each of which sets every recipe. No segment is
selected when the recipes are on a mix of your own. Under a `--line` rule, "Per recipe" (with
"· as planned" or "· your mix" in accent ink) and a chevron opens a fold: one row per recipe with
its round photo, serif name (two lines at most) and a stepper. A recipe changed from the plan has
its count in accent ink and "custom" muted under its name. Quantities follow at once: each
recipe's share of an item scales with its own servings. The picks stay in this browser until the
agent changes the plan. Without JS there is no card and the list shows the planned amounts.

**Sign-in** is the bottom sheet: email + password (`autocomplete="username"` /
`"current-password"`, so the browser fills them) → "Sign in". The fallback, "No password? Email me
a code", leads to a 6-digit code field (`autocomplete="one-time-code"`) → "Sign in"; the email
also has a magic link for the same device. After a code or link sign-in the same sheet offers
**Set a password** (`autocomplete="new-password"`, "Not now" to skip; not offered again once this
browser has used a password); it's also in the avatar menu. After signing in the page opens the
At home tab.

**The signed-in editor** also gets the tabs: cart + count left to buy, house + count at home.
On the **At home** tab every row is a fill bar:

- the row's background fills from the left in proportion to the amount at home
  (`--fill-some`, or `--fill-all` when there's enough), with a thin `--fill-edge` marker at the
  end of a partial fill;
- **sliding** horizontally across the row sets the amount (snapped to a sensible step; vertical
  movement scrolls the page). Sliding all the way means "enough";
- **tapping** the row's right half adds one step, the left half takes one away (same steps as
  sliding; reaching the full amount means "enough");
- the **house** button on the right toggles enough / none;
- the amount reads "1 / 4" while partial, otherwise the full quantity;
- a changed row gets a 3px accent stripe on its left edge;
- a visually hidden range input in each row gives keyboard and screen-reader access (the row
  shows the focus ring);
- the round house-with-cross button clears every row;
- a sticky bar at the bottom holds undo + **Save (n)** while there are unsaved changes, and
  "✓ Saved <date>" otherwise.

## Chat

`templates/chat.js` (+ the `.chat-*` rules at the end of `styles/style.css`), on every page of a build that has `CHAT_API_URL`.

- **Bubble** (`.chat-bubble`): 56px round, `--accent-strong` with `--on-accent` speech-bubble stroke icon, bottom right, 16px +
  safe-area inset. A small `--on-accent` dot marks an unread reply. It lifts above a sticky `.save-bar` / `.cook-bar` that reaches the bottom
  of the screen (shopping page Save bar), hides while a sheet is open (`body.sheet-open`), and is covered by the panel on phones.
- **Panel** (`.chat-panel`): a full-height sheet on phones (sized with `visualViewport`, so the input stays above the keyboard; the page behind
  doesn't scroll), a 400×640 floating panel anchored above the bubble from 720px. Header: serif title, "New chat" text button, round close
  button. Escape closes it.
- **Messages:** the user's in a `--current-soft` bubble on the right; the bot's as plain text on the surface (no box), at most paragraphs,
  bold, bullet/numbered lists and links. Model text never goes through `innerHTML`, and a link is only a link when it points at the site's own
  origin (anything else is shown as plain text).
- **Status line** (`.chat-status`): one quiet muted italic line while it works ("Thinking…", "Looking through the recipes…"), never tool names;
  gone when the answer is done. Errors are the muted red box (`.chat-error`).
- **Suggested replies** (`.chat-chip`): outline pills (1px `--border`, 44px tall, sentence case, no emoji) under the last bot message. Only the
  last message's chips are live; older rows fade to 40% and are disabled.
- **Context chip** (`.chat-context`): "On: Steamed Rice" on a `--track` pill above the input, dismissable with ×; it tells the user what "this
  recipe" means.
- **First run:** the empty chat says what it can do and that chats are stored in this browser for two weeks (history is in `localStorage`, last
  ~20 turns, dropped after two weeks).
- **Recipe cards** (`.chat-cards` / `.chat-card`, from the `show_recipes` tool): the site's tile look (square photo, small-caps kicker, serif
  title clamped to 2 lines, "20 min · 412 kcal") in a sideways scrolling row that runs to the panel's edges, 8.75rem wide, snapping at the
  start. Kicker: "This week" (accent), "Next week" (teal), "Draft" (purple, only when it is in neither week), else the course in muted text.
  Built by the server from our recipe files, never from model text; tapping one opens the recipe page (inert while a reply is streaming).
- **Navigation button** (`.chat-nav`, `offer_navigation`): an outline pill in `--accent-ink` with a stroke arrow ("Open Steamed Rice"), shown
  only once the reply is complete. It is a plain link the user must tap; the chat never navigates on its own. Only the last message's is live.
- **Action chips** (`.chat-chip.is-nav`): a suggested reply that opens a page rather than sending text; same pill, accent outline plus the arrow.
- **Account** (`.chat-account`, signed-in builds only): in the header, a round person button (the compact `.pill`) that opens the shared sign-in
  sheet, or the avatar with its menu (email, Set a password, Sign out), exactly as on the shopping page; the sheet is titled "Sign in to the chat".
  Signing in keeps the panel open (a magic link that reloads the page reopens it with the draft). A signed-in account that isn't an editor gets a
  quiet `.chat-banner` under the header: "Signed in as x — this account can't edit, so the chat is read-only."
- **Chats list** (editors): a list icon button in the header swaps the log for "Your chats" (`.chat-chats`): serif heading, a muted note ("A chat
  is deleted two weeks after its last message."), then rows with the title, a muted "Today · until Sat" line and a trash icon button; the open
  chat is on `--current-soft`. Delete asks inline ("Delete this chat?" Cancel / Delete). The header title is the open chat's title. "New chat" leaves
  the list. On sign-out the panel goes back to the visitor's chat and nothing of the editor's is kept in the browser but the open chat's id.
- **Feedback controls** (editors, `.chat-feedback`): under each turn's last message, before its chips, two 32px round icon buttons (thumbs up and
  down, 17px stroke icons in `--icon-muted`, `aria-label` "Good reply" / "Bad reply", `aria-pressed`; a pressed one is filled `--accent-strong`)
  and a muted note ("Thanks"; after Send "Sent: Wrong amounts" or "Sent"). Thumbs down opens a bordered box: "What went wrong? (optional)", reason
  chips (several can be picked; picked ones get the accent border on `--current-soft`), a one-line "Add a note", and Skip / Send. Tapping the other
  thumb switches the score; tapping the chosen one clears it. Earlier turns' rows are dimmed to half opacity and still work. Visitors see none of it.
- **Starter chips** (`.chat-starters`): the empty chat's first suggestions, by page (recipe: "Swap an ingredient", "Scale it for 6", "Add to
  next week"; home: "Something quick tonight", "Light and healthy"; next week: "What's planned?"; shopping: "What's left to buy?"). Same chip component.
- **Across page loads:** the panel's open state, conversation id and unsent draft are kept in `sessionStorage`, the history in `localStorage`, so
  tapping a card or button reopens the panel on the new page scrolled to the end (without focusing the input); the context chip shows the new page.
- **Photo attachments** (`.chat-attach`, editors only): a 44px round outline icon button (the stroke "picture" icon, `--text-muted`) to the left of the
  input, opening the camera / photo library (`<input type=file accept="image/*" multiple>`; no `capture`, so a phone offers both). Up to 4 photos;
  the button disables at 4. Picked photos wait above the input as 60px rounded thumbnails (`.chat-attachments`, 1px `--border`) with a small
  round × on the corner; they're downscaled to 1600px JPEG in the browser first. A muted line says when a file couldn't be read. A sent message
  shows its photos as 88px rounded thumbnails above its text, in the user's bubble, and again (signed URLs) when the chat is reopened. Visitors have no button.
- **Action chips that commit** (`.chat-chip.is-action`: Save to site, Finalise list): solid `--accent-strong` like the primary button, fixed text
  drawn by the panel ("Save to site (3)"), never the model's wording.
- Input: 16px text (no iOS zoom), grows to ~5 lines; Enter sends on desktop, a new line on touch; round `--accent-strong` send button.
- **Questions** (`.chat-question`, `ask_user`): the question in bold, then **solid** chips (`--accent-strong`, `--on-accent`; a suggestion is an
  outline chip). The input's placeholder reads "Or type an answer" while one is live. `multi` chips toggle (`--current-soft` with an accent
  inset border) and a solid "Done" sends them together. Only the last message's question is live.
- **Plan tray** (`.chat-tray`, editors only, between the log and the input): a hairline-topped strip. A small-caps head line "Tray · 8 changes ·
  until Fri" with a chevron (tap to fold); a sideways row of small cards (`.tray-card`, 9.5rem, snapping), grouped in Save order (switch, this
  week's drafts promote/remove, new, added to next week, edits, list, servings), newest first inside a group; then one full-width primary button
  (`.save-button` look): **Finalise list** while the tray changes next week or the servings and no current list exists, "Building the list…"
  while the agent works, **Save to site (n)** when ready. On a phone the tray folds itself to its header line while a reply streams and when the reader scrolls up, and opens on a tap, a new card or the end of the turn. The cards, details and notices scroll inside the tray (`.tray-scroll`, the tray is at most 63% of the panel / 26rem: enough for a full row of cards, ~16rem, so no card is ever clipped by the button) and the button is its own row below, so it never covers them; an opened detail is scrolled into view. While the on-screen keyboard is open the strip folds to the head line and opens again
  when it closes or a message is sent. A card has the kind as a kicker (New in the draft purple, Next week teal, Switch accent, the rest muted),
  a serif title, a muted sub line, "Added by Name: reason", × to drop (a round button on the corner), and quiet text buttons: **Save now** (quick
  fixes only) and **New photo**. A newly added card gets the accent border on `--current-soft` for a few seconds and the row scrolls to it. A
  new recipe shows "Making the photo…" on its photo until ready; tapping it opens its staged ingredients and steps, tapping the list card
  previews it by aisle. A problem is a muted red line on the card (and red border); a clash is flagged the same way and tapping the card asks
  the bot, which resolves it with chips. A day before it expires a `--current-soft` notice says "The tray expires tomorrow" with a chip for the
  button that applies.
- **Week balance** (`.tray-balance`): one muted 0.82rem line under the tray's head, "Next week after Save: 5 recipes · 3 dinners · ~420 kcal each ·
  2 h 15 min in all", from numbers the server computed; hidden while the tray is folded. **At home card**: kicker "At home" (muted, like Edit), title
  "At home: 2 items", sub "Eggs 6, Basmati rice"; tapping opens the list of what was recorded; **Save now** works on it.
- **Locked panel** (`.chat-locked`, no input, no tray, no "New chat"): a serif title and a muted line, shown in place of the conversation when the chat
  can't be used: "The chat is switched off for now." (server `disabled`; the bubble is then gone on later pages of the tab session), "Chat is for
  signed-in editors" with a solid Sign in button (server `signin`), or "This account can't use the chat" for a signed-in account that isn't an editor.
  With the build variable `CHAT_PUBLIC=false` the bubble itself is only shown to a signed-in visitor.
- **Publishing cards** (`.chat-card.is-publishing`): after Save the summary's new recipes are inert, half-faded cards with the kicker
  "Publishing…" until the server sees their page, then they turn into normal cards.
- **Action chips** (`.chat-chip.is-action`): solid chips that press the tray's own button ("Finalise list", "Save to site (n)"), with fixed text: still a tap by a person (see "Action chips that commit" above).
