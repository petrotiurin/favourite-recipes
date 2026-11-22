import { beforeEach, describe, expect, it } from "vitest";
import { buildAisles, changedCount, counts, fillState, fromSlider, keysFor, loadLocal, need, needText, remaining, samePlan, stepFor, uniform, type Have, type ShoppingProps } from "./shopping-state.ts";

const props: ShoppingProps = {
  plan: { a: 4, b: 2 },
  version: "v1",
  stocktake: null,
  sections: [
    { name: "Veg", items: [{ name: "Garlic", quantity: "4", recipes: ["a"] }, { name: "Spinach", quantity: "200g", recipes: ["a"], have: 100 }, { name: "Salt" }] },
    { name: "Pantry", items: [{ name: "Rice", quantity: "400g", recipes: ["a", "b"], amounts: { a: 200, b: 200 } }, { name: "Oil", quantity: "1", have: true }, { name: "Lemons", quantity: "1.5" }] },
  ],
  recipes: {},
  stocktakeApi: null,
};
const aisles = buildAisles(props.sections);
const rows = aisles.flatMap((a) => a.rows);
const row = (name: string) => rows.find((r) => r.item.name === name)!;

describe("the shopping page's numbers", () => {
  it("gives every item an id and splits its quantity", () => {
    expect(rows.map((r) => r.id)).toEqual(["0-0", "0-1", "0-2", "1-0", "1-1", "1-2"]);
    expect(row("Spinach")).toMatchObject({ amount: 200, unit: "g" });
    expect(row("Salt").amount).toBeUndefined();
  });

  it("scales each recipe's share by its servings (the plan, or the picked ones)", () => {
    const plan = props.plan;
    expect(need(row("Garlic"), plan)).toBe(8); // one recipe at 4: 4 x 4 / 2
    expect(need(row("Rice"), plan)).toBe(600);
    expect(need(row("Rice"), { a: 2, b: 2 })).toBe(400);
    expect(need(row("Salt"), plan)).toBeNull();
    expect(needText(row("Garlic"), plan)).toBe("8");
    expect(needText(row("Rice"), { a: 2, b: 2 })).toBe("400g"); // as written when it is the same
    expect(needText(row("Rice"), plan)).toBe("600g");
    expect(needText(row("Lemons"), { a: 1, b: 1 })).toBe("¾"); // 1.5 for 1 of 2 servings, the nearest ¼ ⅓ ½ ⅔ ¾
    expect(needText(row("Salt"), plan)).toBe("");
  });

  it("works out what's left to buy after the stocktake", () => {
    const plan = props.plan;
    const have: Have = { "0-1": 100, "1-1": true, "0-0": 20 };
    expect(remaining(row("Spinach"), have, plan)).toEqual({ status: "partial", left: 300 });
    expect(remaining(row("Oil"), have, plan)).toEqual({ status: "home", left: 0 });
    expect(remaining(row("Garlic"), have, plan)).toEqual({ status: "home", left: 0 }); // 20 of 8
    expect(remaining(row("Rice"), have, plan)).toEqual({ status: "buy", left: 600 });
    expect(remaining(row("Salt"), { "0-2": 5 }, plan)).toEqual({ status: "buy", left: null }); // nothing to measure
    expect(counts(rows, have, plan)).toEqual({ buy: 4, home: 2, partly: 1 });
  });

  it("picks a slider step that suits the amount", () => {
    const plan = props.plan;
    expect(stepFor(row("Garlic"), plan)).toBe(1);
    expect(stepFor(row("Garlic"), { a: 1 })).toBe(0.5);
    expect(stepFor(row("Rice"), plan)).toBe(50); // 600g
    expect(stepFor(row("Spinach"), { a: 1 })).toBe(25); // 100g
    expect(stepFor(row("Spinach"), { a: 0.25 })).toBe(5); // 25g
  });

  it("shows a fill row for the draft, else the saved stocktake", () => {
    const plan = props.plan;
    expect(fillState(row("Spinach"), null, { "0-1": 100 }, plan)).toEqual({ level: "some", value: 100, pct: 25, amt: "100 / 400g", changed: false });
    expect(fillState(row("Spinach"), {}, { "0-1": 100 }, plan)).toMatchObject({ level: "none", value: 0, pct: 0, amt: "400g", changed: true });
    expect(fillState(row("Oil"), { "1-1": true }, {}, plan)).toMatchObject({ level: "all", pct: 100, changed: true });
    expect(fillState(row("Garlic"), { "0-0": 8 }, {}, plan)).toMatchObject({ level: "all", value: 8 });
    expect(changedCount(rows, { "0-1": 100, "1-1": true }, { "0-1": 100 })).toBe(1);
    expect(changedCount(rows, null, { "0-1": 100 })).toBe(0);
    expect(fromSlider(8, 8)).toBe(true);
    expect(fromSlider(8, 3)).toBe(3);
  });

  it("knows when every recipe is on one number, and when servings are the plan", () => {
    expect(uniform({ a: 2, b: 2 }, ["a", "b"])).toBe(2);
    expect(uniform({ a: 2, b: 4 }, ["a", "b"])).toBeNull();
    expect(samePlan({ a: 4, b: 2 }, props.plan)).toBe(true);
    expect(samePlan({ a: 4, b: 3 }, props.plan)).toBe(false);
    expect(samePlan(null, props.plan)).toBe(false);
  });
});

describe("what the browser keeps for the list", () => {
  const keys = keysFor("v1");
  beforeEach(() => localStorage.clear());

  it("starts from the plan and the list's own stocktake with nothing kept", () => {
    const local = loadLocal(props, aisles);
    expect(local).toEqual({ servings: { a: 4, b: 2 }, ticks: [], have: { "0-1": 100, "1-1": true }, stocktakeAt: null, draft: null, collapsed: [] });
  });

  it("brings back ticks, unsaved edits, folded aisles and servings made from this plan", () => {
    localStorage.setItem(keys.ticks, JSON.stringify(["0-0"]));
    localStorage.setItem(keys.draft, JSON.stringify({ "1-0": 100 }));
    localStorage.setItem("shopping-collapsed", JSON.stringify(["Veg"]));
    localStorage.setItem(keys.plan, JSON.stringify({ plan: props.plan, servings: { a: 1, b: 99 } }));
    const local = loadLocal(props, aisles);
    expect(local).toMatchObject({ ticks: ["0-0"], draft: { "1-0": 100 }, collapsed: ["Veg"], servings: { a: 1, b: 2 } }); // 99 is not a servings number
  });

  it("drops the servings when the agent changed the plan", () => {
    localStorage.setItem(keys.plan, JSON.stringify({ plan: { a: 2, b: 2 }, servings: { a: 1, b: 1 } }));
    expect(loadLocal(props, aisles).servings).toEqual({ a: 4, b: 2 });
    expect(localStorage.getItem(keys.plan)).toBeNull();
  });

  it("shows a stocktake saved from here that the site hasn't redeployed with, until the site has a newer one", () => {
    localStorage.setItem(keys.pending, JSON.stringify({ saved: "2026-11-22T10:00:00.000Z", have: { "0-0": true } }));
    expect(loadLocal(props, aisles)).toMatchObject({ have: { "0-0": true }, stocktakeAt: "2026-11-22T10:00:00.000Z" });
    expect(loadLocal({ ...props, stocktake: "2026-11-21T10:00:00.000Z" }, aisles).stocktakeAt).toBe("2026-11-22T10:00:00.000Z");
    const deployed = loadLocal({ ...props, stocktake: "2026-11-23T10:00:00.000Z" }, aisles);
    expect(deployed).toMatchObject({ stocktakeAt: "2026-11-23T10:00:00.000Z", have: { "0-1": 100, "1-1": true } });
    expect(localStorage.getItem(keys.pending)).toBeNull();
  });

  it("forgets what was kept for other lists and the old one-number pick, and keeps other keys", () => {
    for (const k of ["shopping-ticks:old", "shopping-stocktake:old", "shopping-draft:old", "shopping-plan:old", "shopping-servings", "shopping-editor-session", "shopping-collapsed"]) localStorage.setItem(k, "1");
    localStorage.setItem(keys.ticks, "[]");
    loadLocal(props, aisles);
    expect(Object.keys(localStorage).sort()).toEqual([keys.ticks, "shopping-collapsed", "shopping-editor-session"].sort());
  });

  it("copes with storage that throws, and with junk in it", () => {
    localStorage.setItem(keys.ticks, "not json");
    expect(loadLocal(props, aisles).ticks).toEqual([]);
  });
});
