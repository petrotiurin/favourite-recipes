# UI design

The principles behind how the site looks and behaves, and the small vocabulary (colours, type, icons, components) every page
is built from. This is not a spec of each page: exact copy, sizes, flows and states live in the components and `styles/style.css`
(and, for the chat, in `docs/chatbot-design.md`). Change this file only when a principle, a token or a shared component changes,
not for every new feature or tweak.

The site is static HTML + one stylesheet + browser scripts (see CLAUDE.md). Every page is still written to HTML by the build, so it
shows at once and reads if a script fails; JS may add features that only exist with JS.

The look is **"Journal"**: a family cookbook you flick through. Names and headings in a serif, everything you read while
cooking in a plain sans, black ink on white, square-cornered photos. Photos lead every list, because that's how we pick what
to cook next.

## Principles

- **Phone first.** Most use is on a phone, in the kitchen or the shop. Lay out for a 390px screen with a 16px gutter, then let
  wider screens breathe (one breakpoint, 720px, where two-column layouts and floating panels start).
- **Photos first, chrome quiet.** No boxes, borders or shadows around recipes: a photo, a small-caps kicker, the name, one
  short meta line. Status lives in words (kickers, headings), not tinted cards or dashed borders.
- **One tile.** A recipe looks the same wherever it's listed (home grid, next week, chat cards): square photo, kicker, serif
  name, "20 min · 412 kcal". No feature slots or special layouts.
- **Icons over words, but never a puzzle.** Prefer an icon plus a number to a sentence. Keep one short hint where a gesture
  isn't obvious, and give every icon-only control an `aria-label`.
- **No emoji in the UI.** Meta reads as plain words; icons are the stroke SVGs below.
- **One accent, and colour means something.** Orange is the only accent and also this week's colour. Two reserved hues besides
  it: purple only for drafts, teal only for next week. No other colours for state (no green, red or blue); error messages are
  the one exception (a muted red box).
- **Calm states.** Highlight with low-opacity tints of the accent, not solid fills. A screen full of "done" rows should still
  look quiet. Solid accent fills are for the one primary action on screen.
- **Batch writes.** Every save is a commit and a site deploy, so editing UIs collect changes locally and send them with one
  explicit **Save** (with a count), plus a way to drop unsaved changes. Never save on every tap.
- **A person commits.** Anything that writes (Save, Finalise, Save now) is a button a person taps, with fixed text drawn by
  the page, never a model's wording and never triggered by the model. Likewise the chat never navigates on its own: it offers
  a link to tap.
- **Only the latest is live.** In a conversation, only the last message's chips, questions and cards can be used; older ones
  fade and are disabled (or stay as plain links).
- **Say what's happening in plain words.** While something works, one quiet line ("Looking through the recipes…"), never tool
  names, ids or internals. When the user can't see why something is missing (a locked chat, an empty week), say so in one line.
- **Keep the cooking controls in reach.** On a recipe page, what you need with messy hands (servings, keep screen on) stays one
  tap away while you scroll.
- **Local is local.** Things only you care about (ticks while shopping, folded sections, servings picks) stay in your browser
  and never write to the site.
- **Safe rendering.** Model text never goes through `innerHTML`, and a link is only a link when it points at the site's own
  origin.
- **Touch targets ≥ 44px**, visible focus rings (`:focus-visible`, 2px accent outline), and motion that still makes sense with
  `prefers-reduced-motion`.

## Colour tokens

Defined on `:root` in `styles/style.css`, with dark-mode values under `@media (prefers-color-scheme: dark)`. Always use the
tokens, never raw hex values in rules.

| Token | Light | Role |
| --- | --- | --- |
| `--bg` | `#ffffff` | Page background |
| `--surface` | `#ffffff` | Cards, lists, sheets |
| `--raised` | `#ffffff` | The selected segment or tab sitting on a `--track` |
| `--text` | `#161514` | Body text |
| `--text-muted` | `#6f6c68` | Secondary text, kickers, meta lines |
| `--border` | `#e7e5e1` | Rules and card borders |
| `--line` | `#efedea` | Dividers between rows inside a card |
| `--track` | `#f3f2ef` | Background of segmented controls, tabs and small pills; image placeholder |
| `--accent` | `#bc5422` | Icons, focus rings, small marks (not small text) |
| `--accent-ink` | `#a44617` | Accent-coloured text (this week, step numbers, active states) |
| `--accent-strong` | `#a8491b` | Filled primary buttons, with `--on-accent` text |
| `--current-soft` | `#fbf1ea` | Soft accent panels: saved state, picked options, the user's chat bubble |
| `--fill-some` / `--fill-all` | accent at 5% / 10% | Partial / full fill bars |
| `--fill-edge` | accent at 55% | The marker where a partial fill ends |
| `--icon-muted` | `#a39a90` | Inactive icons (an empty house, an unticked circle) |
| `--draft` / `--draft-soft` | plum `#6e4d96` | Drafts only |
| `--next` | teal `#2b6c6e` (dark `#7fc4c1`) | Next week only |

## Type

Two Google Fonts families, loaded in `src/components/Layout.astro` with system fallbacks (`--serif`, `--sans`), so the page still
reads if they don't load:

- **Newsreader** (`--serif`), weight 400, for names and headings: the brand (italic), page and recipe titles, tile names, section
  headings (aisles in small caps, like a cookbook index). Tight tracking.
- **Public Sans** (`--sans`) for everything else: ingredients, steps, controls, meta.
- **Kicker** (`.kicker`): small uppercase sans with wide letter-spacing, `--text-muted` by default; in accent ink for this week,
  teal for next week. Kickers never name the draft status: a draft is marked only by one italic plum line on its own page.

Numbers use `font-variant-numeric: tabular-nums` so quantities line up.

## Icon language

Inline stroke SVGs, 24×24 viewBox, 2px stroke, `currentColor`, `aria-hidden` (the control around them carries the label).

The **house** tells how much of an item is at home:

| Icon | Meaning |
| --- | --- |
| House outline (`--icon-muted`) | None at home |
| House with its lower half filled (`--accent`) | Some at home |
| Solid house (`--accent`) | Enough at home |
| House with a cross | Clear everything at home |

Others: **arrow out of a box** (opens in another app or site), **arrow** (goes to another page), **cart** (the list / left
to buy), **check** (ticked, saved), **− / +** (fewer / more), **undo arrow** (drop unsaved changes), **person** (sign in),
**×** (close or drop), **thumbs** (feedback).

## Components

The shared pieces, in `styles/style.css`. Reuse one before inventing a new one; a new pattern that several screens will share
gets a line here.

- **Tile**: the one recipe tile (see "One tile").
- **Card** (`.shop-card`): `--surface`, 1px `--border`, 14px radius, rows divided by `--line`. Also the look of review cards
  in the chat.
- **Segmented control** (`.seg`) and **tabs** (`.tabs`): buttons on a `--track` pill, the selected one `--raised` and bold.
  A small accent dot on a tab means unsaved changes there.
- **Stepper** (`.stepper`): − count + on the same track; buttons at a limit are disabled.
- **Primary button** (`.save-button`): full width, `--accent-strong`, can carry a count. One per screen.
- **Pill** (`.pill`) and **chip** (`.chat-chip`): rounded outline buttons for secondary actions and suggested replies; solid
  only when tapping it commits or answers a question.
- **Text button** (`.text-button`): accent-ink text, no border; `.is-quiet` for low-priority actions.
- **Icon button** (`.icon-button`): square or round, outline, icon only, `aria-label`.
- **Bottom sheet** (`.sheet`): slides up over a dimmed backdrop for short tasks; Escape or a tap on the backdrop closes it,
  focus moves into it.
- **Collapsible section**: a `<details open>` whose whole heading row is the tap target (native, no script needed).
- **Fill bar**: a row whose background fills in proportion to an amount (`--fill-some` / `--fill-all`), set by sliding or
  tapping, with a hidden range input for keyboard and screen readers.
- **Photo bubbles**: overlapping round recipe photos with a ring, showing which recipes something is for.
- **Status line**: one quiet line for progress and messages; a muted red box for errors.
