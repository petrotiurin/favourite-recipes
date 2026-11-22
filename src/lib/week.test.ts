import { describe, expect, it } from "vitest";
import { byStatusThenTitle } from "./status.ts";
import { courseClasses, courseLabel, indexOrder, nextWeekRecipes } from "./week.ts";

type R = { title: string; course?: ("Breakfast" | "Lunch" | "Dinner" | "Snack" | "Drink")[]; draft?: boolean; current?: boolean; next?: boolean };
const titles = (list: R[]) => list.map((r) => r.title);

describe("the home page's order", () => {
  const book = ([
    { title: "Pasta", course: ["Dinner"], current: true },
    { title: "Porridge", course: ["Breakfast"], current: true, draft: true },
    { title: "Soup", course: ["Lunch"], current: true },
    { title: "Tea", course: ["Drink"], current: true },
    { title: "Toast", course: ["Breakfast"], next: true },
    { title: "Secret", course: ["Dinner"], draft: true, next: true },
    { title: "Cake", course: ["Snack"] },
  ] as R[]).sort(byStatusThenTitle);

  it("groups this week by meal (drafts first inside each), hides a draft only in next week, and marks where the rest begins", () => {
    const { shown, restStart } = indexOrder(book);
    expect(titles(shown)).toEqual(["Porridge", "Soup", "Pasta", "Tea", "Cake", "Toast"]);
    expect(restStart).toBe(4);
  });

  it("has no divider when nothing follows or nothing is this week", () => {
    expect(indexOrder([{ title: "A", current: true }]).restStart).toBe(-1);
    expect(indexOrder([{ title: "A" }]).restStart).toBe(0);
  });

  it("lists next week alphabetically, drafts included", () => {
    expect(titles(nextWeekRecipes(book))).toEqual(["Secret", "Toast"]);
  });

  it("names the meal and its CSS classes", () => {
    expect(courseLabel({ course: ["Lunch", "Dinner"] })).toBe("Lunch · Dinner");
    expect(courseClasses({ course: ["Lunch", "Snack"] })).toEqual(["course-lunch", "course-snack"]);
    expect(courseLabel({})).toBe("");
  });
});
