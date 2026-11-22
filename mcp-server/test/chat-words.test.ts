// The words the chat panel writes as the editor's message when they answer the optional items card must be the server's own words for those
// answers (the server stores its copy; the panel shows its own). The panel's other tests are Vitest tests next to it (src/lib/chat/, src/islands/chat/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanOptional, optionalText } from "../../src/lib/chat/clean.ts";
import { optionalAnswersText } from "../lib/optional-review.ts";

test("the optional items card: Done's words in the panel are the server's", () => {
  const card = cleanOptional(
    {
      items: [
        { item: "sesame-seeds", name: " Sesame seeds ", quantity: "", recipes: [{ slug: "satay-salmon", title: "Satay Salmon", image: "" }] },
        { item: "chilli-oil", name: "Chilli oil", quantity: "5ml", recipes: [], answer: "drop" },
        { item: "coriander", name: "Coriander", recipes: [] },
      ],
    },
    "https://site.test",
  )!;
  for (const answers of [{}, { "chilli-oil": "drop" }, { "chilli-oil": "drop", "sesame-seeds": "drop", coriander: "keep" }] as Record<string, string>[]) {
    assert.equal(optionalText(card, answers), optionalAnswersText(card.items as any, answers), JSON.stringify(answers));
  }
  assert.equal(optionalText(card, { "chilli-oil": "drop", "sesame-seeds": "drop" }), "Leaving off: sesame seeds and chilli oil.");
});
