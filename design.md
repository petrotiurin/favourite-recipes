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
- **One accent.** Orange is the only accent colour. Purple is reserved for drafts. No green,
  red or blue for state; error messages are the one exception (a muted red box).
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
| `--accent-ink` | `#a44617` | Accent-coloured text: "This week" kickers, "Step n", active wake lock |
| `--accent-strong` | `#a8491b` | Filled primary buttons, with `--on-accent` text |
| `--current-soft` | `#fbf1ea` | Soft accent panels: the "Home checked" card, saved state |
| `--fill-some` / `--fill-all` | accent at 5% / 10% | Fill-bar rows on the "At home" tab |
| `--fill-edge` | accent at 55% | The marker where a partial fill ends |
| `--icon-muted` | `#a39a90` | Inactive icons (an empty house, an unticked circle) |
| `--draft` / `--draft-soft` | plum `#6e4d96` | Draft recipes only: the "To try" kicker and filter |

## Type

Two Google Fonts families, loaded in `templates/layout.js` with system fallbacks (`--serif`,
`--sans` on `:root`), so the page still reads if they don't load:

- **Newsreader** (`--serif`), weight 400 only, for names and headings: the top-bar brand
  (italic), the index headline (1.9–2.75rem), tile names (1.1rem, 1.25rem from 720px, clamped to
  three lines), recipe titles (2.1–3rem), recipe h2s (1.55rem), the shopping title, and its
  aisle names (500, `font-variant-caps: all-small-caps`, 0.06em letter-spacing). Tight tracking (-0.01 to -0.025em).
- **Public Sans** (`--sans`) for everything else: ingredients, steps, controls, meta.
- **Kicker** (`.kicker`): 0.7rem, 600, uppercase, 0.12em letter-spacing, `--text-muted`;
  `.kicker-draft` plum ("To try"), `.kicker-current` accent ink ("This week").

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
**undo arrow** (drop unsaved changes), **person** (sign in), **×** (close).

The definitions are duplicated in `templates/shopping-list.js` (static page) and
`templates/shopping.js` (interactive page); keep them identical.

## Recipe list (index)

Top bar: italic serif brand on the left, cart icon + "Shopping list" on the right, a rule
underneath. No headline: straight into a search field drawn as an underline with a search icon,
and the filters as plain words (active one bold and underlined; "This week" in accent ink, "To
try" in plum). On a phone the filters are one row that scrolls sideways.

The grid is **two tiles side by side** on a phone, `auto-fill, minmax(220px, 1fr)` from 720px.
Every recipe is the same tile, with no feature slot: square photo (no radius), kicker ("To try",
"This week", else the course), serif name, then "20 min · 412 kcal". A "The rest of the book"
divider spans the grid where the non-current recipes start; it hides while a filter or a search
is active.

## Recipe page

Back link (chevron + "All recipes"), kicker (status, course and tags), serif title, and for
drafts one italic serif line saying it's a draft. Then the photo: edge to edge at 4:5 on a phone,
3:2 inside the column from 720px. Under it a meta row ("**20** min · Serves **4** · **566** kcal
each"), then the **cook bar**, the page's two cooking controls, ruled off underneath: "Serves" +
the segmented control (1/2/4, the same `.seg` as the shopping page; it opens on 4, whatever
the recipe serves) on the left, and the "Keep
screen on" pill (sun icon; filled `--accent-strong` with "Screen stays on" when on) on the right.
On a phone the pill wraps under the servings, both flush left. The bar is hidden until its scripts
run; once the servings control shows, the static "Serves 4" fact in the meta row is hidden.
Ingredients have no bullets and a dotted rule between rows; each instruction is headed "Step n"
in an accent-ink kicker.

## Components

- **Card** (`.shop-card`, `.shop-list`): `--surface`, 1px `--border`, 14px radius. Rows inside
  are divided by `--line`.
- **Segmented control** (`.seg`): buttons on a `--track` pill; the selected one is `--raised`,
  bold, with a light shadow. Used for servings (1/2/4); 4 is the default everywhere.
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
recipe as a link with its round photo and serif name ("To try" kicker after drafts). Aisle
section names are serif small caps, like a cookbook index.

**Everyone** sees: back link and (when sign-in is configured) a "Sign in" pill; the title; "For N
recipes · list made <date>", which expands to the recipe links; the servings card; the "Home
checked <date>" card (when a stocktake exists or sign-in is configured) with **Update**; the
list, sectioned by aisle (tap a section's heading to fold it away), where each row is a round tick (kept in this browser), the name (+ a
muted note) and the quantity on the right. Partly stocked items show only what's left to buy
with the half-filled house; fully stocked items fold into "Already at home (N)". "Start again
(untick all)" appears once something is ticked.

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
