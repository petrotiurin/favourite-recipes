# UI design

How the site looks and behaves. Keep this file in step with `styles/style.css` and the
templates: when a change adds or alters a pattern, update the matching section here.

The site is static HTML + one stylesheet + small vanilla JS (see CLAUDE.md, "Hard constraint").
Every page must read fine with JS off; JS only adds interaction on top.

## Principles

- **Phone first.** Most use is on a phone, in the kitchen or the shop. Lay out for a 390px
  wide screen with a 16px gutter, then let wider screens breathe (the shopping page caps at
  560px, recipe pages use a two-column layout from 720px).
- **Icons over words, but never a puzzle.** Prefer an icon plus a number to a sentence. Keep
  one short hint where a gesture isn't obvious (for example "slide = some", "tap = all"), and
  give every icon-only control an `aria-label`.
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
| `--bg` | `#faf8f5` | Page background |
| `--surface` | `#ffffff` | Cards, lists, sheets |
| `--raised` | `#ffffff` | The selected segment or tab sitting on a `--track` |
| `--text` | `#2b2622` | Body text |
| `--text-muted` | `#706a63` | Secondary text, section labels |
| `--border` | `#ece7e0` | Card borders |
| `--line` | `#f1ece5` | Dividers between rows inside a card |
| `--track` | `#efe9e1` | Background of segmented controls and tabs |
| `--accent` | `#c9622c` | Icons, borders, focus rings, small marks (not small text) |
| `--accent-ink` | `#a84d1e` | Accent-coloured text (passes 4.5:1 on white) |
| `--accent-strong` | `#b0501d` | Filled primary buttons, with `--on-accent` text |
| `--current-soft` | `#fbefe7` | Soft accent panels: the "Home checked" card, saved state |
| `--fill-some` / `--fill-all` | accent at 5% / 10% | Fill-bar rows on the "At home" tab |
| `--fill-edge` | accent at 55% | The marker where a partial fill ends |
| `--icon-muted` | `#a39a90` | Inactive icons (an empty house, an unticked circle) |
| `--draft` / `--draft-soft` | purple | Draft recipes only |

## Type

System font stack. Page titles 1.9–2rem bold; section labels 0.8rem uppercase with 0.06em
letter-spacing in `--text-muted`; row text 1rem; numbers use `font-variant-numeric: tabular-nums`
so quantities line up.

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

## Components

- **Card** (`.shop-card`, `.shop-list`): `--surface`, 1px `--border`, 14px radius. Rows inside
  are divided by `--line`.
- **Segmented control** (`.seg`): buttons on a `--track` pill; the selected one is `--raised`,
  bold, with a light shadow. Used for servings (1/2/4).
- **Tabs** (`.tabs`): the same look as the segmented control, full width, icon + count per tab.
  A small accent dot on a tab means unsaved changes there.
- **Pill button** (`.pill`): rounded outline button, for secondary actions such as "Sign in".
- **Avatar** (`.avatar`): the signed-in editor's initial on `--accent-strong`; opens a small
  menu with the email and "Sign out".
- **Primary button** (`.save-button`): full width, 52px tall, `--accent-strong` with
  `--on-accent` text. A count badge can sit inside it.
- **Text button** (`.text-button`): accent-ink text, no border; `.is-quiet` is muted and
  underlined for low-priority actions.
- **Icon button** (`.icon-button`): 48px square (or round), outline, icon only, `aria-label`.
- **Bottom sheet** (`.sheet`): slides up over a dimmed backdrop for short tasks (sign-in).
  Grip, title + one line of explanation, a close button, then the form. Escape or a tap on the
  backdrop closes it; focus moves into it.
- **Status line** (`.shopping-status`): a soft accent box for messages, muted red for errors.

## Shopping page

`templates/shopping-list.js` renders the static page; `templates/shopping.js` re-renders the
interactive part from the embedded JSON.

**Everyone** sees: back link and (when sign-in is configured) a "Sign in" pill; the title; "For N
recipes · list made <date>", which expands to the recipe links; the servings card; the "Home
checked <date>" card (when a stocktake exists or sign-in is configured) with **Update**; the
list, sectioned by aisle, where each row is a round tick (kept in this browser), the name (+ a
muted note) and the quantity on the right. Partly stocked items show only what's left to buy
with the half-filled house; fully stocked items fold into "Already at home (N)". "Start again
(untick all)" appears once something is ticked.

**Sign-in** is the bottom sheet: email → "Email me a code" → a 6-digit code field
(`autocomplete="one-time-code"`) → "Sign in". The email also has a magic link for the same
device. After signing in the page opens the At home tab.

**The signed-in editor** also gets the tabs: cart + count left to buy, house + count at home.
On the **At home** tab every row is a fill bar:

- the row's background fills from the left in proportion to the amount at home
  (`--fill-some`, or `--fill-all` when there's enough), with a thin `--fill-edge` marker at the
  end of a partial fill;
- **sliding** horizontally across the row sets the amount (snapped to a sensible step; a plain
  tap does nothing, and vertical movement scrolls the page). Sliding all the way means "enough";
- the **house** button on the right toggles enough / none;
- the amount reads "1 / 4" while partial, otherwise the full quantity;
- a changed row gets a 3px accent stripe on its left edge;
- a visually hidden range input in each row gives keyboard and screen-reader access (the row
  shows the focus ring);
- the round house-with-cross button clears every row;
- a sticky bar at the bottom holds undo + **Save (n)** while there are unsaved changes, and
  "✓ Saved <date>" otherwise.
