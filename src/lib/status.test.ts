import { describe, expect, it } from "vitest";
import { isHiddenUntilNextWeek, byStatusThenTitle } from "./status.ts";

describe("recipe status", () => {
  it("hides a draft that is only in next week from the home page", () => {
    expect(isHiddenUntilNextWeek({ draft: true, next: true })).toBe(true);
    expect(isHiddenUntilNextWeek({ draft: true, next: true, current: true })).toBe(false);
  });

  it("puts this week's drafts first, then this week, then the rest", () => {
    const list = [{ title: "B" }, { title: "A", current: true }, { title: "C", current: true, draft: true }];
    expect(list.sort(byStatusThenTitle).map((r) => r.title)).toEqual(["C", "A", "B"]);
  });
});
