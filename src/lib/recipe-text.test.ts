import { describe, expect, it } from "vitest";
import { cookRecipe, recipePlainText } from "./recipe-text.ts";

const recipe = {
  title: "Rice",
  slug: "rice",
  serves: 2,
  total_mins: 20,
  calories: 300,
  ingredients: [
    { amount: 200, unit: "g" as const, name: "rice", item: "rice" },
    { amount: 2, unit: "tbsp" as const, name: "soy sauce", section: "Sauce", item: "soy-sauce" },
  ],
  body: "## Instructions\r\n\r\n1. Cook the **rice** per the [packet](https://x.test).\r\n\r\n\r\n\r\n2. Eat ![](a.jpg) it.\n",
};

describe("recipePlainText", () => {
  it("is the facts, the ingredient lines in their sections, then the body without bold, links, images or heading marks", () => {
    expect(recipePlainText(recipe)).toBe(
      "Serves 2 · 20 min · 300 kcal per serving\n\nIngredients\n\n- 200g rice\n\nSauce:\n- 2 tbsp soy sauce\n\nInstructions\n\n1. Cook the rice per the packet.\n\n2. Eat  it."
    );
  });

  it("says when no ingredients are recorded", () => {
    expect(recipePlainText({ ...recipe, ingredients: [] })).toContain("Ingredients\n\nNot recorded yet.");
  });

  it("is what the Cook with Claude island gets, with the servings selector's state", () => {
    expect(cookRecipe(recipe, true)).toMatchObject({ title: "Rice", slug: "rice", serves: 2, scalable: true });
  });
});
