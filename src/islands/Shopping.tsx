// The shopping page's list (`client:load`): drawn once, at build time, from the saved list and the agent's plan, and taken over in the browser
// (docs/typescript-migration.md step 7; it replaces the static markup and templates/shopping.js, which drew the list twice). The list is data in the
// props; the browser never loads it. What the page adds when it wakes (the same as before):
// - the servings card: opens on the agent's plan, "1/2/4" sets every recipe and "Per recipe" changes single ones (kept in this browser per list),
// - ticks while shopping, kept in this browser only (anyone can use them),
// - the recipes each item is for: its row shows their photos, tapping them names the recipes,
// - for the signed-in editor: the "At home" tab, where each row is a fill bar (slide across it for some, tap the house for all). Edits stay in this
//   browser until Save, which sends them in one go to the backend's /stocktake endpoint (one commit, one deploy).
// Sign-in is the store in src/lib/auth.ts. What the browser knows (ticks, edits, who is signed in) is read after the first render, in a layout
// effect, so hydration starts from what the build wrote. The look and the icon language are in design.md; the rules in .claude/rules/shopping-list.md.
import { Fragment, type JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Plan } from "../../shared/shopping-quantity.ts";
import { auth } from "../lib/auth.ts";
import {
  COLLAPSED_KEY, MAX_SERVINGS, ROW_PHOTOS, amountText, buildAisles, changedCount, counts, fillState, fromSlider, initialLocal, keysFor, loadLocal,
  need, needText, planSlugs, remaining, samePlan, save, servingsOf as servingsFor, shortDate, stepFor, uniform,
  type Aisle, type Have, type Local, type RecipeRef, type Row, type ShoppingProps,
} from "../lib/shopping-state.ts";
import Icon from "./Icon.tsx";

interface Notice {
  text: string;
  error?: boolean;
}
interface State extends Local {
  perRecipeOpen: boolean;
  savedNow: boolean;
  tab: "list" | "home"; // home is for the editor
  homeOpen: boolean; // the "Already at home" fold
  openFor: string[]; // ids of the rows whose recipe names are shown
  message: Notice | null;
  busy: boolean;
}

const tf = (b: boolean): "true" | "false" => (b ? "true" : "false");
const SHOP_COPY = { title: "Update what's at home", lede: "Sign in once and you can mark what you already have." };

export default function Shopping(props: ShoppingProps) {
  const { plan, version, recipes, stocktakeApi } = props;
  const aisles = useRef<Aisle[]>(null as unknown as Aisle[]);
  if (!aisles.current) aisles.current = buildAisles(props.sections);
  const rows = aisles.current.flatMap((a) => a.rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const slugs = planSlugs(plan);
  const keys = keysFor(version);

  const [state, setState] = useState<State>(() => ({
    ...initialLocal(props, aisles.current),
    perRecipeOpen: false, savedNow: false, tab: "list", homeOpen: false, openFor: [], message: null, busy: false,
  }));
  // The latest state, readable straight after an update (a handler runs more than once between two draws, e.g. while sliding).
  const latest = useRef(state);
  const update = (patch: Partial<State> | ((s: State) => Partial<State>)): State => {
    const next = { ...latest.current, ...(typeof patch === "function" ? patch(latest.current) : patch) };
    latest.current = next;
    setState(next);
    return next;
  };

  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    update(loadLocal(props, aisles.current));
    setReady(true);
  }, []);
  // The editor: signed in, on a build that can save a stocktake. Nobody is signed in until the browser has been asked.
  const isEditor = () => !!(stocktakeApi && auth.getSession());
  const editor = ready && !!stocktakeApi && !!auth.session.value;

  useEffect(() => {
    auth.setCopy(SHOP_COPY);
    return auth.onChange((_session, info) => {
      if (info.type === "sign-in") update({ tab: "home", message: null });
      else if (info.type === "sign-out") update({ tab: "list" });
      else if (info.type === "password-saved") update({ message: { text: info.message ?? "" } });
      else if (info.type === "error") update({ message: { text: info.message ?? "", error: true } });
    });
  }, []);

  const tab = state.tab === "home" && editor ? "home" : "list";
  const servings = state.servings;
  const effective = (editor && state.draft ? state.draft : state.have) as Have;
  const changed = changedCount(rows, state.draft, state.have);

  // --- unsaved edits ---
  const persistDraft = (draft: Have | null, have: Have) => save(keys.draft, changedCount(rows, draft, have) ? draft : undefined);
  function setDraft(id: string, v: true | number) {
    const s = latest.current;
    const draft: Have = { ...(s.draft ?? s.have) };
    if (v === true || (typeof v === "number" && v > 0)) draft[id] = v;
    else delete draft[id];
    update({ draft, savedNow: false });
    persistDraft(draft, s.have);
  }
  const rowAll = (id: string, level: string) => setDraft(id, level === "all" ? 0 : true);

  // --- servings: kept per list, with the plan it was made from; back on the plan, nothing is kept ---
  function setServings(next: Plan) {
    update({ servings: next });
    save(keys.plan, samePlan(next, plan) ? undefined : { plan, servings: next });
  }
  const onServes = (value: string) => {
    const next: Plan = {};
    for (const slug of slugs) next[slug] = value === "plan" ? plan[slug] : Number(value);
    setServings(next);
  };
  const onStep = (slug: string, delta: number) => {
    const next = servingsFor(latest.current.servings, slug) + delta;
    if (next < 1 || next > MAX_SERVINGS) return;
    setServings({ ...latest.current.servings, [slug]: next });
  };

  // --- ticks ---
  const onTick = (id: string, checked: boolean) => {
    const ticks = latest.current.ticks.filter((t) => t !== id);
    if (checked) ticks.push(id);
    save(keys.ticks, ticks);
    update({ ticks });
  };
  const clearTicks = () => {
    save(keys.ticks, undefined);
    update({ ticks: [] });
  };

  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  // --- saving the stocktake ---
  async function saveStocktake() {
    const s = latest.current;
    const draft: Have = s.draft ?? { ...s.have };
    const payload = rows.map((r) => {
      const v = draft[r.id];
      const entry: { name: string; quantity?: string; have?: true | number } = { name: r.item.name };
      if (r.item.quantity) entry.quantity = r.item.quantity;
      if (v === true || (typeof v === "number" && v > 0)) entry.have = v;
      return entry;
    });
    update({ draft, message: null, busy: true });
    try {
      const token = await auth.getAccessToken();
      if (!token) {
        auth.sessionExpired("Your sign-in has expired. Sign in again to save; your changes are kept.");
        return;
      }
      const res = await fetch(stocktakeApi!, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ items: payload }),
      });
      const body: { error?: string; stocktake?: string } = await res.json().catch(() => ({}));
      if (res.ok) {
        const saved: Have = {};
        payload.forEach((entry, i) => {
          if (entry.have !== undefined) saved[rows[i].id] = entry.have;
        });
        const at = body.stocktake || new Date().toISOString();
        update({ have: saved, draft: null, savedNow: true, stocktakeAt: at });
        save(keys.draft, undefined);
        save(keys.pending, { saved: at, have: saved });
      } else if (res.status === 401) {
        auth.sessionExpired(body.error || "Sign in again to save; your changes are kept.");
      } else {
        update({ message: { text: body.error || "Saving failed. Try again.", error: true } });
      }
    } catch {
      update({ message: { text: "Couldn't reach the server. Check your connection and try again.", error: true } });
    } finally {
      update({ busy: false });
    }
  }

  // --- sliding across a fill row sets how much is at home. A tap on its right half adds one step, on its left half takes one away (a scroll doesn't
  // count as a tap: the browser cancels the pointer), a mostly vertical move is left to the page scroll. ---
  const drag = useRef<{ id: string; row: HTMLElement; x: number; y: number; active: boolean; pointerId: number } | null>(null);
  const slideValue = (id: string, value: number) => {
    const n = need(byId.get(id)!, latest.current.servings) as number;
    setDraft(id, value <= 0 ? 0 : fromSlider(n, value));
  };
  function tapAt(x: number) {
    const d = drag.current!;
    const rect = d.row.getBoundingClientRect();
    const row = byId.get(d.id)!;
    const s = latest.current;
    const step = stepFor(row, s.servings);
    const n = need(row, s.servings) as number;
    const current = fillState(row, s.draft, s.have, s.servings).value;
    slideValue(d.id, x - rect.left >= rect.width / 2 ? Math.min(n, current + step) : Math.max(0, current - step));
  }
  function slideTo(x: number) {
    const d = drag.current!;
    const rect = d.row.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
    const row = byId.get(d.id)!;
    const step = stepFor(row, latest.current.servings);
    const n = need(row, latest.current.servings) as number;
    slideValue(d.id, frac > 0.97 ? n : Math.round((frac * n) / step) * step);
  }
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Element;
    const row = target.closest<HTMLElement>(".fill-row.has-range");
    if (!row || target.closest(".fill-house") || e.button > 0) return;
    drag.current = { id: row.getAttribute("data-row")!, row, x: e.clientX, y: e.clientY, active: false, pointerId: e.pointerId };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      const dx = Math.abs(e.clientX - d.x);
      const dy = Math.abs(e.clientY - d.y);
      if (dy > 10 && dy > dx) {
        drag.current = null;
        return;
      }
      if (dx < 8) return;
      d.active = true;
      try {
        d.row.setPointerCapture(e.pointerId);
      } catch {
        /* no capture: the slide still follows the pointer over the row */
      }
    }
    e.preventDefault();
    slideTo(e.clientX);
  };
  const endDrag = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active && e.type === "pointerup") tapAt(e.clientX);
    drag.current = null;
    try {
      d.row.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  };

  // --- pieces ---
  const message = state.message && (
    <p class={`shopping-status${state.message.error ? " is-error" : ""}`} role="status">{state.message.text}</p>
  );
  /** An aisle: tapping its heading folds it away (a <details>, so folding needs no script); folded aisles are kept for next time. */
  const section = (name: string, count: number, children: JSX.Element[]) => (
    <details
      class="shop-section"
      data-section={name}
      key={name}
      open={!state.collapsed.includes(name)}
      onToggle={(e) => {
        const el = e.currentTarget as HTMLDetailsElement;
        const was = latest.current.collapsed;
        if (el.open === !was.includes(name)) return; // already how the page has it
        const collapsed = was.filter((n) => n !== name);
        if (!el.open) collapsed.push(name);
        save(COLLAPSED_KEY, collapsed.length ? collapsed : undefined);
        update({ collapsed });
      }}
    >
      <summary>
        <h2>{name}</h2>
        <span class="section-count">{count}</span>
        <Icon name="chevron" class="icon chevron" />
      </summary>
      <ul class="shop-list">{children}</ul>
    </details>
  );

  const tabs = () => {
    const c = counts(rows, effective, servings);
    const dirty = changed > 0;
    const tabButton = (id: "list" | "home", icon: "cart" | "house", count: number, label: string, extra?: JSX.Element | false) => (
      <button type="button" role="tab" data-tab={id} aria-selected={tf(tab === id)} aria-label={label} onClick={() => update({ tab: id, message: null })}>
        <Icon name={icon} />
        <span>{count}</span>
        {extra}
      </button>
    );
    return (
      <div class="tabs" role="tablist" id="shop-tabs">
        {tabButton("list", "cart", c.buy, `Shopping list, ${c.buy} to buy`)}
        {tabButton("home", "house", c.home, `At home, ${c.home} items${dirty ? ", unsaved changes" : ""}`, dirty && <span class="unsaved-dot" />)}
      </div>
    );
  };

  // "Plan" is the agent's plan; it is left out when the plan is one of 1/2/4 for every recipe (that button is the plan then).
  const planButton = slugs.length > 0 && ![1, 2, 4].includes(uniform(plan, slugs) as number);
  const servingsCard = () => {
    const onPlan = samePlan(servings, plan, slugs);
    const u = uniform(servings, slugs);
    const summary = onPlan ? (planButton ? "as planned" : "") : u === null ? "your mix" : "";
    return (
      <div class="shop-card servings-card">
        <div class="servings-top">
          <span>Servings</span>
          <div class="seg" role="group" aria-label="Servings of every recipe">
            {planButton && (
              <button type="button" data-serves="plan" aria-pressed={tf(onPlan)} aria-label="As planned" onClick={() => onServes("plan")}>Plan</button>
            )}
            {[1, 2, 4].map((n) => (
              <button type="button" data-serves={n} aria-pressed={tf(u === n && !(planButton && onPlan))} aria-label={`${n} for every recipe`} onClick={() => onServes(String(n))}>{n}</button>
            ))}
          </div>
        </div>
        {slugs.length > 0 && (
          <>
            <button type="button" class="per-recipe-toggle" data-act="per-recipe" aria-expanded={tf(state.perRecipeOpen)} onClick={() => update({ perRecipeOpen: !latest.current.perRecipeOpen })}>
              <span>
                Per recipe
                {summary && <span class="per-recipe-summary">{` · ${summary}`}</span>}
              </span>
              <Icon name="chevron" class="icon chevron" />
            </button>
            {state.perRecipeOpen && <ul class="serves-list">{slugs.map(planRecipe)}</ul>}
          </>
        )}
      </div>
    );
  };
  const planRecipe = (slug: string) => {
    const r: Pick<RecipeRef, "title"> & Partial<RecipeRef> = recipes[slug] || { title: slug };
    const n = servingsFor(servings, slug);
    const custom = n !== plan[slug];
    return (
      <li class={`serves-row${custom ? " is-changed" : ""}`} key={slug}>
        {r.image && <img src={r.image} alt="" />}
        <span class="serves-name">
          <span>{r.title}</span>
          {custom && <small>custom</small>}
        </span>
        <span class="stepper">
          <button type="button" class="step" data-step={slug} data-delta="-1" disabled={n <= 1} aria-label={`Fewer servings of ${r.title}`} onClick={() => onStep(slug, -1)}>
            <Icon name="minus" />
          </button>
          <span class="step-count" aria-live="polite" aria-label={`${r.title}, ${n} servings`}>{n}</span>
          <button type="button" class="step" data-step={slug} data-delta="1" disabled={n >= MAX_SERVINGS} aria-label={`More servings of ${r.title}`} onClick={() => onStep(slug, 1)}>
            <Icon name="plus" />
          </button>
        </span>
      </li>
    );
  };

  const homeCard = () => {
    if (!state.stocktakeAt && !stocktakeApi) return null;
    const c = counts(rows, effective, servings);
    const title = state.stocktakeAt ? `Home checked ${shortDate(state.stocktakeAt)}` : "Home not checked yet";
    let sub = c.home || c.partly ? `${c.home} at home, ${c.partly} partly. Already taken off.` : "Everything is on the list.";
    if (changed) sub += " Not saved yet.";
    return (
      <div class="home-card">
        <Icon name="house-some" />
        <span class="home-card-text">
          <strong>{title}</strong>
          <span>{sub}</span>
        </span>
        {stocktakeApi && (
          <button type="button" class="text-button" data-act="update" onClick={() => (isEditor() ? update({ tab: "home" }) : auth.openSignIn())}>Update</button>
        )}
      </div>
    );
  };

  const recipesOf = (r: Row) => (r.item.recipes || []).map((slug) => recipes[slug]).filter(Boolean);
  // The tick and the quantity are both labels for the checkbox, so the whole row still ticks; the photos between them are a button.
  const shopRow = (row: Row, status: "buy" | "partial", left: number | null) => {
    const ticked = state.ticks.includes(row.id);
    const rs = recipesOf(row);
    const partial = status === "partial";
    const qty = partial ? amountText(row, left as number) : needText(row, servings);
    const open = state.openFor.includes(row.id);
    const names = rs.map((r) => r.title).join(", ");
    return (
      <li class="shop-row" key={row.id}>
        <label class="shop-item">
          <input type="checkbox" class="tick" id={`tick-${row.id}`} data-tick={row.id} checked={ticked} onChange={(e) => onTick(row.id, e.currentTarget.checked)} />
          <span class="shop-name">
            {row.item.name}
            {row.item.note && <span class="shop-note">{row.item.note}</span>}
          </span>
          {partial && (
            <>
              <Icon name="house-some" class="icon icon-some" />
              <span class="sr-only">{`(have ${amountText(row, effective[row.id] as number)} of ${needText(row, servings)} at home)`}</span>
            </>
          )}
        </label>
        {rs.length > 0 && (
          <button type="button" class="row-for" data-for={row.id} aria-expanded={tf(open)} aria-label={`For ${names}`} onClick={() => update({ openFor: toggleIn(latest.current.openFor, row.id) })}>
            {rs.slice(0, ROW_PHOTOS).map((r) => <img src={r.image} alt="" />)}
            {rs.length > ROW_PHOTOS && <span class="row-more">{`+${rs.length - ROW_PHOTOS}`}</span>}
          </button>
        )}
        <label class="shop-qty" for={`tick-${row.id}`}>{qty}</label>
        {rs.length > 0 && open && (
          <div class="row-recipes">
            {rs.map((r) => (
              <a href={r.href}>
                <img src={r.image} alt="" />
                <span>{r.title}</span>
              </a>
            ))}
          </div>
        )}
      </li>
    );
  };

  const listView = () => {
    const homeItems: Row[] = [];
    let shown = 0;
    const sections = aisles.current.flatMap((aisle) => {
      const shopRows: JSX.Element[] = [];
      for (const row of aisle.rows) {
        const r = remaining(row, effective, servings);
        if (r.status === "home") homeItems.push(row);
        else {
          shopRows.push(shopRow(row, r.status, r.left));
          shown++;
        }
      }
      return shopRows.length ? [section(aisle.name, shopRows.length, shopRows)] : [];
    });
    return (
      <>
        {message}
        {servingsCard()}
        {homeCard()}
        {sections}
        {!shown && <p class="shopping-empty">Everything on the list is already at home.</p>}
        {homeItems.length > 0 && (
          <details class="shop-home" data-details="home" open={state.homeOpen} onToggle={(e) => update({ homeOpen: (e.currentTarget as HTMLDetailsElement).open })}>
            <summary>{`Already at home (${homeItems.length})`}</summary>
            <ul>
              {homeItems.map((row) => (
                <li key={row.id}>
                  <span>{row.item.name}</span>
                  <span>{needText(row, servings)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {state.ticks.length > 0 && (
          <div class="shop-footer">
            <button type="button" class="text-button is-quiet" data-act="clear-ticks" onClick={clearTicks}>Start again (untick all)</button>
          </div>
        )}
      </>
    );
  };

  const fillRow = (row: Row) => {
    const s = fillState(row, state.draft, state.have, servings);
    const hasRange = row.amount !== undefined;
    return (
      <li
        class={`fill-row${hasRange ? " has-range" : ""}${s.changed ? " is-changed" : ""}`}
        key={row.id}
        data-row={row.id}
        data-level={s.level}
        style={`--fill: ${s.pct}%`}
      >
        <span class="fill-name">{row.item.name}</span>
        <span class="fill-amt">{s.amt}</span>
        {hasRange && (
          <input
            type="range"
            class="fill-range"
            data-range={row.id}
            min="0"
            max={need(row, servings) as number}
            step={stepFor(row, servings)}
            value={s.value}
            aria-label={`${row.item.name}, how much is at home`}
            aria-valuetext={s.amt}
            // Keyboard and screen readers drive the (visually hidden) range input.
            onInput={(e) => slideValue(row.id, Number(e.currentTarget.value))}
          />
        )}
        <button type="button" class="fill-house" data-house={row.id} aria-pressed={tf(s.level === "all")} aria-label={`${row.item.name}, have it all`} onClick={() => rowAll(row.id, s.level)}>
          <Icon name={s.level === "all" ? "house-all" : "house"} />
        </button>
      </li>
    );
  };

  const saveBar = () => (
    <div class="save-bar" id="save-bar">
      {state.busy ? (
        <button type="button" class="save-button" disabled>Saving…</button>
      ) : changed ? (
        <>
          <button type="button" class="icon-button" data-act="discard" aria-label="Undo unsaved changes" onClick={() => { save(keys.draft, undefined); update({ draft: null }); }}>
            <Icon name="undo" />
          </button>
          <button type="button" class="save-button" data-act="save" aria-label={`Save ${changed} change${changed === 1 ? "" : "s"}`} onClick={() => void saveStocktake()}>
            Save <span class="save-count">{changed}</span>
          </button>
        </>
      ) : (
        <div class="saved-state" role="status">
          <Icon name="check" />
          {state.savedNow ? "Saved just now" : state.stocktakeAt ? `Saved ${shortDate(state.stocktakeAt)}` : "Nothing saved yet"}
        </div>
      )}
    </div>
  );

  const homeView = () => (
    <>
      {message}
      <p class="home-hint" aria-hidden="true">
        <span><Icon name="slide" />slide or tap sides = some</span>
        <span><Icon name="house-all" />tap = all</span>
      </p>
      {aisles.current.map((aisle) => section(aisle.name, aisle.rows.length, aisle.rows.map(fillRow)))}
      <div class="home-tools">
        <button type="button" class="icon-button" data-act="reset-home" aria-label="Nothing at home: clear every row" onClick={() => { const s = latest.current; update({ draft: {}, savedNow: false }); persistDraft({}, s.have); }}>
          <Icon name="house-clear" />
        </button>
      </div>
      {saveBar()}
    </>
  );

  return (
    <div id="shopping-app" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {editor && tabs()}
      {/* keyed, so a tab's markup is never reused for the other's (the DOM is drawn fresh, like the script did) */}
      {tab === "home" ? <Fragment key="home">{homeView()}</Fragment> : <Fragment key="list">{listView()}</Fragment>}
    </div>
  );
}
