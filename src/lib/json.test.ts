import { describe, expect, it } from "vitest";
import { scriptJson } from "./json.ts";

describe("scriptJson", () => {
  it("can't close the script element or open a comment, and reads back as the original", () => {
    const value = { title: "</script><!-- & > \u2028 \u2029 ok", n: [1, "<"] };
    const text = scriptJson(value);
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(text)).toEqual(value);
  });
});
