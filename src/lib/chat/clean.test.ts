// What the chat keeps of what it is sent (moved from mcp-server/test/chat-render.test.js and phase6.test.js, where they tested the old templates/chat.cjs):
// only plain values, links and photos only on this site's origin, staged photos only from Supabase's signed-URL path.
import { describe, expect, it } from "vitest";
import {
  cleanCards, cleanHistory, cleanNav, cleanNumbers, cleanOptional, cleanPhotos, cleanQuestion, cleanReplyItems, cleanReview, cleanServerMessages,
  optionalText, reviewText, wellFormed,
} from "./clean.ts";
import { chatMeta, contextLabel, expiryLabel, feedbackNote, photoProgress, startersFor, updatedLabel } from "./labels.ts";
import { chatPhotoCount, tooManyNote } from "./photo-files.ts";
import { balanceLine, cleanReading, cleanTray, readingLine, readingSaveNote, trayButton, trayExpiryNotice, trayLine } from "./tray-data.ts";

const ORIGIN = "https://site.test";

describe("the visitor's history in this browser", () => {
  it("is kept for two weeks, only plain user/assistant text, capped", () => {
    const now = Date.now();
    const fresh = { id: "c1", updated: now - 1000, messages: [{ role: "user", content: "hi" }, { role: "system", content: "x" }, { role: "assistant", content: "yo", replies: ["a", 5, "b"] }, { role: "assistant", content: 7 }] };
    const h = cleanHistory(fresh, now)!;
    expect(h.messages).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "yo", replies: ["a", "b"] }]);
    expect(cleanHistory({ ...fresh, updated: now - 15 * 24 * 3600 * 1000 }, now)).toBeNull();
    expect(cleanHistory({ messages: "nope" }, now)).toBeNull();
    expect(cleanHistory(null, now)).toBeNull();
    const many = cleanHistory({ id: "c", updated: now, messages: Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `m${i}` })) }, now)!;
    expect(many.messages.length).toBe(40);
  });

  it("keeps cards, nav and action chips only when they point at this site", () => {
    const stored = {
      id: "c1",
      updated: Date.now(),
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", cards: [{ title: "A", url: "https://site.test/r/a.html", kicker: { kind: "", label: "Dinner" }, meta: "" }], nav: { label: "Go", url: "https://evil.test/" }, replies: ["ok", { label: "Open", url: "https://evil.test/" }] },
      ],
    };
    const h = cleanHistory(stored, Date.now(), ORIGIN)!;
    expect(h.messages.length, "a message with only cards is kept").toBe(2);
    expect(h.messages[1].cards!.length).toBe(1);
    expect(h.messages[1].nav).toBeUndefined();
    expect(h.messages[1].replies).toEqual(["ok"]);
    expect(cleanHistory(stored, Date.now())!.messages[1], "without an origin nothing but text survives").toBeUndefined();
  });

  it("is sent to the server well formed after a failed turn", () => {
    expect(
      wellFormed([{ role: "assistant", content: "x" }, { role: "user", content: "a" }, { role: "user", content: "b" }, { role: "assistant", content: "" }, { role: "assistant", content: "c" }, { role: "user", content: "d" }]),
    ).toEqual([{ role: "user", content: "a\n\nb" }, { role: "assistant", content: "c" }, { role: "user", content: "d" }]);
  });
});

describe("cards, navigation, action chips and starters", () => {
  it("recipe cards keep only links and photos on the site's origin", () => {
    const good = { title: "Steamed Rice", url: "https://site.test/favourite-recipes/recipes/steamed-rice.html", image: "https://site.test/favourite-recipes/images/recipes/steamed-rice.jpg", kicker: { kind: "this", label: "This week" }, meta: "20 min · 412 kcal" };
    const out = cleanCards(
      [
        good,
        { ...good, title: "Evil link", url: "https://evil.test/x" },
        { ...good, title: "Script link", url: "javascript:alert(1)" },
        { ...good, title: "Evil photo", image: "https://evil.test/p.jpg", kicker: { kind: "<script>", label: "x" } },
        { url: good.url },
      ],
      ORIGIN,
    );
    expect(out.map((c) => c.title)).toEqual(["Steamed Rice", "Evil photo"]);
    expect(out[0].image, "the backend's /images/recipes/ originals stay").toBe(good.image);
    expect(out[1].image, "a photo from elsewhere is dropped, the card stays").toBe("");
    expect(out[1].kicker.kind, "unknown kicker kinds fall back to plain").toBe("");
    expect(cleanCards(Array.from({ length: 20 }, () => good), ORIGIN).length).toBe(8);
  });

  it("navigation buttons and action chips only resolve to this site", () => {
    expect(cleanNav({ label: "Open Steamed Rice", url: "https://site.test/favourite-recipes/recipes/steamed-rice.html" }, ORIGIN)).toEqual({ label: "Open Steamed Rice", url: "https://site.test/favourite-recipes/recipes/steamed-rice.html" });
    expect(cleanNav({ label: "x", url: "https://evil.test/" }, ORIGIN)).toBeNull();
    expect(cleanNav({ label: "x", url: "javascript:alert(1)" }, ORIGIN)).toBeNull();
    expect(cleanReplyItems(["Plain", { label: "Open", url: "https://site.test/favourite-recipes/next-week.html" }, { label: "Evil", url: "https://evil.test/" }, { label: "Js", url: "javascript:1" }, 5, null], ORIGIN)).toEqual([
      "Plain",
      { label: "Open", url: "https://site.test/favourite-recipes/next-week.html" },
    ]);
    expect(cleanReplyItems(["a", "b", "c", "d", "e"], ORIGIN), "at most four").toEqual(["a", "b", "c", "d"]);
  });

  it("action chips only for the tray's two buttons, with fixed labels; cards keep their publishing state", () => {
    expect(cleanReplyItems([{ label: "Save to site", action: "apply_plan" }, { label: "Bad", action: "delete_all" }, "Ok"], ORIGIN)).toEqual([{ label: "Save to site", action: "apply_plan" }, "Ok"]);
    expect(cleanReplyItems([{ label: "Commit everything now", action: "finalise_plan" }], ORIGIN), "the model's words never label a button that commits").toEqual([{ label: "Finalise list", action: "finalise_plan" }]);
    const [card] = cleanCards([{ slug: "test-pasta", publishing: true, title: "Test Pasta", url: `${ORIGIN}/favourite-recipes/recipes/test-pasta.html`, kicker: { kind: "draft", label: "Draft" }, meta: "" }], ORIGIN);
    expect(card.publishing).toBe(true);
    expect(card.slug).toBe("test-pasta");
  });

  it("starter chips depend on the page", () => {
    expect(startersFor("recipe"), "a visitor isn't invited to write").toEqual(["Swap an ingredient", "Scale it for 6", "What goes with it?"]);
    expect(startersFor("recipe", true), "an editor is").toEqual(["Swap an ingredient", "Scale it for 6", "Add to next week"]);
    expect(startersFor("index")).toEqual(["Something quick tonight", "Light and healthy"]);
    expect(startersFor("next-week")).toEqual(["What's planned?"]);
    expect(startersFor("shopping")).toEqual(["What's left to buy?", "What can I make from what's at home?"]);
    expect(startersFor("other")).toEqual([]);
    expect(startersFor("")).toEqual([]);
  });

  it("the context chip names the page", () => {
    expect(contextLabel({ page: "recipe", title: "Steamed Rice" })).toBe("Steamed Rice");
    expect(contextLabel({ page: "index" })).toBe("The recipe list");
    expect(contextLabel({ page: "next-week" })).toBe("Next week");
    expect(contextLabel({ page: "shopping" })).toBe("Shopping list");
    expect(contextLabel({})).toBe("");
  });
});

describe("an editor's chat from the server", () => {
  it("keeps cards, buttons, turn ids and feedback, only on this site", () => {
    const list = [
      { role: "user", content: "hi" },
      { role: "system", content: "evil" },
      {
        role: "assistant", content: "hello", turn_id: "t1", replies: ["ok", { label: "Go", url: "https://evil.test/x" }], nav: { label: "Open", url: "https://evil.test/" }, feedback: { value: 0, reasons: ["Wrong amounts", "bogus"], note: "n" },
        cards: [{ title: "Soup", url: `${ORIGIN}/recipes/soup.html`, kicker: { kind: "this", label: "This week" }, meta: "10 min" }],
      },
    ];
    const out = cleanServerMessages(list, ORIGIN);
    expect(out.length).toBe(2);
    expect(out[1].replies).toEqual(["ok"]);
    expect(out[1].nav).toBeUndefined();
    expect(out[1].turn_id).toBe("t1");
    expect(out[1].feedback).toEqual({ value: 0, reasons: ["Wrong amounts"], note: "n" });
    expect(out[1].cards!.length).toBe(1);
  });

  it("sent photos: only signed URLs of our own project's chat-uploads bucket survive, at most eight", () => {
    const base = "https://proj.supabase.co";
    const ok = `${base}/storage/v1/object/sign/chat-uploads/a/b.jpg?token=t`;
    const out = cleanServerMessages([{ role: "user", content: "", images: [ok, "https://evil.test/x.jpg", `${base}/storage/v1/object/sign/tray-photos/a.jpg?token=t`, "javascript:alert(1)", 5, ok, ok, ok, ok, ok, ok, ok, ok] }], ORIGIN, base);
    expect(out.length, "a message with only photos is kept").toBe(1);
    expect(out[0].images!.length).toBe(8);
    expect(out[0].images!.every((u) => u === ok)).toBe(true);
    expect(cleanServerMessages([{ role: "user", content: "hi", images: [ok] }], ORIGIN, "").length).toBe(1);
    expect(cleanServerMessages([{ role: "user", content: "hi", images: [ok] }], ORIGIN, "")[0].images, "no Supabase base: no photos").toBeUndefined();
  });

  it("photo reading: numbers line up with the photos, notes from the site are plain status lines, progress and the tray's reading entries", () => {
    const base = "https://proj.supabase.co";
    const ok = `${base}/storage/v1/object/sign/chat-uploads/a/b.jpg?token=t`;
    const [m] = cleanServerMessages([{ role: "user", content: "", images: [ok, ok], photo_numbers: [7, 8] }], ORIGIN, base);
    expect(m.numbers).toEqual([7, 8]);
    expect(cleanServerMessages([{ role: "user", content: "", images: [ok, ok], photo_numbers: [7] }], ORIGIN, base)[0].numbers, "numbers that don't line up are dropped").toBeUndefined();
    expect(cleanNumbers([1, 2.5], 2)).toEqual([]);
    expect(cleanNumbers(["1"], 1)).toEqual([]);
    const ev = cleanServerMessages([{ role: "event", content: "  Photos read: 5 recipes, 1 to check " }, { role: "event", content: "" }, { role: "event", content: 3 }], ORIGIN, base);
    expect(ev).toEqual([{ role: "event", content: "Photos read: 5 recipes, 1 to check" }]);
    expect(cleanPhotos({ active: false, follow_up: false })).toBeNull();
    expect(photoProgress(cleanPhotos({ total: 6, read: 4, reading: 2, active: true }))).toBe("Reading photos… 4 of 6");
    expect(photoProgress(cleanPhotos({ read: 6, reading: 0, active: true, follow_up: true }))).toBe("Adding them to the tray…");
    const entries = cleanReading([{ name: "Sam", count: 3 }, { name: "", count: 1, mine: true }, { name: "x", count: 0 }, "junk"]);
    expect(entries).toEqual([{ name: "Sam", count: 3, mine: false }, { name: "Someone", count: 1, mine: true }]);
    expect(readingLine(entries[0])).toBe("Reading 3 photos · Sam");
    expect(readingLine(entries[1])).toBe("Reading 1 photo · you");
    expect(readingSaveNote(entries)).toBe("Sam has 3 photos still being read.");
    expect(readingSaveNote([entries[1]])).toBe("");
  });

  it("chat list labels: updated today / yesterday / date, expiry as a weekday; the feedback note", () => {
    const now = new Date(2026, 10, 7, 15, 0).getTime(); // Sat 7 Nov 2026
    const at = (d: number, h = 9) => new Date(2026, 10, d, h).toISOString();
    expect(updatedLabel(at(7), now)).toBe("Today");
    expect(updatedLabel(at(6), now)).toBe("Yesterday");
    expect(expiryLabel(at(14), now)).toMatch(/^until (Sat|Sat\.)/);
    expect(expiryLabel(at(8), now)).toBe("until tomorrow");
    expect(expiryLabel(at(21), now)).toMatch(/until .*21/);
    expect(chatMeta({ updated_at: at(7), expires_at: at(8) }, now)).toBe("Today · until tomorrow");
    expect(feedbackNote({ value: 1 }, false)).toBe("Thanks");
    expect(feedbackNote({ value: 0, reasons: ["Wrong amounts"] }, true)).toBe("Sent: Wrong amounts");
    expect(feedbackNote({ value: 0, reasons: [] }, true)).toBe("Sent");
    expect(feedbackNote({ value: 0, reasons: [] }, false)).toBe("");
    expect(feedbackNote(null, true)).toBe("");
  });
});

describe("questions, the drafts review and the optional items", () => {
  it("ask_user questions: 2-6 short distinct options; anything else is dropped", () => {
    expect(cleanQuestion({ question: " Ready? ", options: ["Promote it", "Not yet", "Not yet"], multi: true })).toEqual({ question: "Ready?", options: ["Promote it", "Not yet"], multi: true });
    expect(cleanQuestion({ question: "x", options: ["only one"] })).toBeNull();
    expect(cleanQuestion({ question: "", options: ["a", "b"] })).toBeNull();
    expect(cleanQuestion({ question: "x", options: "ab" })).toBeNull();
  });

  it("the drafts review card: rows from the server, on our origin only, thumbs only; Done's message in words", () => {
    const review = cleanReview(
      {
        drafts: [
          { slug: "pea-soup", title: " Pea Soup ", url: "https://site.test/favourite-recipes/recipes/pea-soup.html", image: "https://evil.test/x.jpg", meta: "20 min", answer: "liked" },
          { slug: "Bad Slug", title: "x" },
          { slug: "rice", title: "Rice", url: "javascript:alert(1)", also_next: true, answer: "keep" },
          { slug: "stew", title: "Stew" },
        ],
      },
      ORIGIN,
    )!;
    expect(review.drafts.map((d) => d.slug)).toEqual(["pea-soup", "rice", "stew"]);
    const [pea, rice] = review.drafts;
    expect(pea.title).toBe("Pea Soup");
    expect(pea.image, "a photo off our origin is dropped").toBe("");
    expect(pea.answer).toBe("liked");
    expect(rice.url).toBe("");
    expect(rice.alsoNext).toBe(true);
    expect(rice.answer, "only a thumb is an answer").toBe("");
    expect(cleanReview({ drafts: [] }, ORIGIN)).toBeNull();
    expect(cleanReview(null, ORIGIN)).toBeNull();
    expect(reviewText(review, { "pea-soup": "remove" })).toBe("Not for us: Pea Soup. Kept for the coming week: Rice, Stew.");
    expect(reviewText(review, { "pea-soup": "liked", rice: "liked", stew: "remove" })).toBe("Liked: Pea Soup, Rice. Not for us: Stew.");
  });

  it("the optional items card: rows from the server, photos on our origin only (or a staged photo), only a drop is an answer", () => {
    const card = cleanOptional(
      {
        items: [
          { item: "sesame-seeds", name: " Sesame seeds ", quantity: "", recipes: [{ slug: "satay-salmon", title: "Satay Salmon", image: "https://site.test/favourite-recipes/images/recipes/satay-salmon.jpg" }, { slug: "Bad", title: "x" }] },
          { item: "Bad Id", name: "x", recipes: [] },
          { item: "chilli-oil", name: "Chilli oil", quantity: "5ml", recipes: [{ slug: "air-fried-salmon", title: "Air-Fried Salmon", image: "https://evil.test/x.jpg" }], answer: "drop" },
          { item: "coriander", name: "Coriander", answer: "keep", recipes: [] },
        ],
      },
      ORIGIN,
    )!;
    expect(card.items.map((i) => i.item)).toEqual(["sesame-seeds", "chilli-oil", "coriander"]);
    const [sesame, oil, coriander] = card.items;
    expect(sesame.name).toBe("Sesame seeds");
    expect(sesame.recipes.map((r) => r.slug)).toEqual(["satay-salmon"]);
    expect(sesame.recipes[0].image).toMatch(/^https:\/\/site\.test\//);
    expect(oil.recipes[0].image, "a photo off our origin is dropped").toBe("");
    expect(oil.answer).toBe("drop");
    expect(coriander.answer, "ticked (kept) unless dropped").toBe("");
    expect(cleanOptional({ items: [] }, ORIGIN)).toBeNull();
    const staged = (image: string) => cleanOptional({ items: [{ item: "white-wine", name: "White wine", recipes: [{ slug: "fish-pie-en-croute", title: "Fish Pie en Croûte", image }] }] }, ORIGIN, "https://sb.test")!.items[0].recipes[0].image;
    expect(staged("https://sb.test/storage/v1/object/sign/tray-photos/t/fish-pie-en-croute.jpg?token=x")).toBe("https://sb.test/storage/v1/object/sign/tray-photos/t/fish-pie-en-croute.jpg?token=x");
    expect(staged("https://sb.test/rest/v1/trays"), "nothing else from Supabase").toBe("");
    expect(staged("https://evil.test/storage/v1/object/sign/x.jpg")).toBe("");
    // the words are the server's too (mcp-server/test/phase6.test.js checks them against lib/optional-review.js)
    expect(optionalText(card, { "chilli-oil": "drop", "sesame-seeds": "drop" })).toBe("Leaving off: sesame seeds and chilli oil.");
    expect(optionalText(card, { "chilli-oil": "drop" })).toBe("Leaving off: chilli oil.");
    expect(optionalText(card, {})).toBe("Keeping all the optional items.");
  });
});

describe("the plan tray", () => {
  it("is reduced to plain values: photos only from Supabase's signed-URL path, links only on the site", () => {
    const raw = {
      id: "t1", state: "ready", needs_list: true, list_current: true, can_save: true, expires_at: new Date(Date.now() + 3600_000).toISOString(), expires_day: "Fri",
      items: [
        { id: "abcdef12", kind: "new", title: "Test Pasta", sub: "Draft", added_by: "Petro", photo: { status: "ready", url: "https://sb.test/storage/v1/object/sign/tray-photos/x/test-pasta.jpg?token=1" }, detail: { ingredients: ["200g pasta"], steps: ["Boil"] } },
        { id: "abcdef13", kind: "edit", title: "Eggs", photo: { status: "ready", url: "https://evil.test/x.jpg" }, recipe: { url: "https://evil.test/", image: "https://site.test/i.jpg" } },
        { id: "nope", kind: "new", title: "bad id" },
        { id: "abcdef14", kind: "hack", title: "bad kind" },
      ],
    };
    const t = cleanTray(raw, ORIGIN, "https://sb.test")!;
    expect(t.count).toBe(2);
    expect(t.items[0].photo!.url).toMatch(/^https:\/\/sb\.test\/storage\/v1\/object\/sign\//);
    expect(t.items[1].photo!.url, "a photo from anywhere else is dropped").toBe("");
    expect(t.items[1].recipe!.url).toBe("");
    expect(t.items[1].recipe!.image).toBe("https://site.test/i.jpg");
    expect(cleanTray(null, ORIGIN, "")).toBeNull();
    expect(trayLine(t, true)).toBe("Tray · 2 changes");
    expect(trayLine(t, false)).toBe("Tray · 2 changes · until Fri");
    expect(trayLine({ count: 1, expires_day: "" }, false)).toBe("Tray · 1 change");
    expect(trayButton(t).kind).toBe("save");
    expect(trayButton({ ...t, can_save: false, list_current: false, items: t.items })).toEqual({ kind: "finalise", label: "Finalise list" });
    expect(trayButton({ ...t, can_save: false, state: "finalising" }).label).toBe("Reviewing the list…");
    expect(trayButton({ ...t, can_save: false, list_current: false, items: [{ error: "x" }] }).kind).toBe("blocked");
    expect(trayExpiryNotice({ expires_at: new Date(Date.now() + 20 * 3600_000).toISOString() }, Date.now()).startsWith("The tray expires")).toBe(true);
    expect(trayExpiryNotice({ expires_at: new Date(Date.now() + 3 * 86400_000).toISOString() }, Date.now())).toBe("");
  });

  it("the List card shows its patches; the button says Reviewing while the model reviews; the Catalogue card is a known kind", () => {
    const t = cleanTray({ items: [{ id: "abcd1234", kind: "list", title: "52 items for 5 recipes", sub: "Reviewed", edits: ["round lime up"], notes: ["1 edit no longer applies"], preview: [{ name: "Fresh produce", items: ["Limes (3)"] }] }], state: "finalising", needs_list: true }, ORIGIN, "https://sb.test")!;
    expect(t.items[0].edits).toEqual(["round lime up"]);
    expect(t.items[0].notes).toEqual(["1 edit no longer applies"]);
    expect(t.items[0].preview).toEqual([{ name: "Fresh produce", items: ["Limes (3)"] }]);
    expect(trayButton(t).label).toBe("Reviewing the list…");
    expect(cleanTray({ items: [{ id: "abcd1235", kind: "catalogue", title: "Ingredient catalogue" }] }, ORIGIN, "")!.items.length).toBe(1);
  });

  it("the week balance line (moved from phase6.test.js)", () => {
    expect(balanceLine({ recipes: 5, dinners: 3, avg_kcal: 420, total_mins: 135 })).toBe("Next week after Save: 5 recipes · 3 dinners · ~420 kcal each · 2 h 15 min in all");
    expect(balanceLine({ recipes: 1, dinners: 1, avg_kcal: 0, total_mins: 45 })).toBe("Next week after Save: 1 recipe · 1 dinner · 45 min in all");
    expect(balanceLine(null)).toBe("");
    expect(cleanTray({ items: [], balance: { recipes: "5", dinners: -1, avg_kcal: 1e9, total_mins: 12 } }, "https://x", "")!.balance!.recipes, "non-numbers are dropped").toBe(0);
  });
});

describe("photos to send", () => {
  it("numbers the next photo after the chat's own, and says when too many were picked", () => {
    expect(chatPhotoCount([])).toBe(0);
    expect(chatPhotoCount([{ role: "user", content: "", images: ["a", "b"] }, { role: "assistant", content: "x" }, { role: "user", content: "", images: ["c"], numbers: [7] }])).toBe(7);
    expect(tooManyNote(3, 8)).toBe("");
    expect(tooManyNote(10, 8)).toBe("Only 8 photos per message; added the first 8.");
    expect(tooManyNote(1, 0)).toBe("That's 8 photos already, the most for one message: send these first, or remove one.");
  });
});
