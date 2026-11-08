// The chat widget's safe renderer (templates/chat.js), run in node: model text becomes DOM nodes, never HTML,
// and only links to the site's own origin stay links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const chat = createRequire(import.meta.url)("../../templates/chat.js");
const ORIGIN = "https://site.test";

// A tiny DOM, enough for renderInto: it records what was built, so we can see that nothing was parsed as HTML.
class Node_ {
  constructor(tag, text) { this.tag = tag; this.text = text; this.children = []; this.attrs = {}; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  set textContent(v) { this.children = [new Node_("#text", v)]; }
}
const fakeDoc = { createElement: (t) => new Node_(t), createTextNode: (t) => new Node_("#text", t) };
const html = (n) => (n.tag === "#text" ? n.text : `<${n.tag}${n.attrs.href ? ` href="${n.attrs.href}"` : ""}>${n.children.map(html).join("")}</${n.tag}>`);
const render = (text) => { const root = new Node_("div"); chat.renderInto(fakeDoc, root, text, ORIGIN); return root; };

test("renders paragraphs, bold, lists and links to the site as DOM nodes", () => {
  const out = html(render("Try these:\n\n- **[Avocado Toast](https://site.test/favourite-recipes/recipes/avocado-toast.html)**: 10 min\n- plain\n\n1. one\n2. two\n\nDone."));
  assert.equal(
    out,
    '<div><p>Try these:</p><ul><li><strong><a href="https://site.test/favourite-recipes/recipes/avocado-toast.html">Avocado Toast</a></strong>: 10 min</li><li>plain</li></ul><ol><li>one</li><li>two</li></ol><p>Done.</p></div>'
  );
});

test("links to other origins and non-http schemes are plain text", () => {
  const out = html(render("[evil](https://evil.test/x) [js](javascript:alert(1)) [data](data:text/html,hi) [rel](/favourite-recipes/recipes/a.html) [sub](https://site.test.evil.test/) [port](https://site.test:8080/)"));
  assert.doesNotMatch(out, /evil\.test\/|javascript:|data:/);
  assert.equal(out, '<div><p>evil js data <a href="https://site.test/favourite-recipes/recipes/a.html">rel</a> sub port</p></div>');
});

test("markup in model text stays text", () => {
  const root = render('<img src=x onerror=alert(1)> <script>alert(1)</script> **<b>bold</b>**');
  const out = html(root);
  assert.ok(!root.children.some((c) => c.tag === "img" || c.tag === "script"));
  assert.match(out, /<img src=x onerror=alert\(1\)>/); // as a text node: the browser shows it literally
  const tags = new Set();
  (function walk(n) { tags.add(n.tag); n.children.forEach(walk); })(root);
  assert.deepEqual([...tags].sort(), ["#text", "div", "p", "strong"]);
});

test("headings become bold lines, single newlines become line breaks, partial markdown is left alone", () => {
  assert.equal(html(render("## Title\nline one\nline two")), "<div><p><strong>Title</strong></p><p>line one<br></br>line two</p></div>");
  assert.equal(html(render("half **bold and [link](")), "<div><p>half **bold and [link](</p></div>");
});

test("safeHref only accepts the page's own origin", () => {
  assert.equal(chat.safeHref("https://site.test/a", ORIGIN), "https://site.test/a");
  assert.equal(chat.safeHref("//site.test/a", ORIGIN, "https://site.test/x"), "https://site.test/a");
  assert.equal(chat.safeHref("//evil.test/a", ORIGIN, "https://site.test/x"), null);
  assert.equal(chat.safeHref("not a url", ORIGIN, "https://other.test/"), null);
  assert.equal(chat.safeHref("javascript:alert(1)", ORIGIN), null);
});

test("stored history: kept for two weeks, only plain user/assistant text, capped", () => {
  const now = Date.now();
  const fresh = { id: "c1", updated: now - 1000, messages: [{ role: "user", content: "hi" }, { role: "system", content: "x" }, { role: "assistant", content: "yo", replies: ["a", 5, "b"] }, { role: "assistant", content: 7 }] };
  const h = chat.cleanHistory(fresh, now);
  assert.deepEqual(h.messages, [{ role: "user", content: "hi" }, { role: "assistant", content: "yo", replies: ["a", "b"] }]);
  assert.equal(chat.cleanHistory({ ...fresh, updated: now - 15 * 24 * 3600 * 1000 }, now), null);
  assert.equal(chat.cleanHistory({ messages: "nope" }, now), null);
  assert.equal(chat.cleanHistory(null, now), null);
  const many = chat.cleanHistory({ id: "c", updated: now, messages: Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `m${i}` })) }, now);
  assert.equal(many.messages.length, 40);
});

// --- cards, navigation, action chips and starters (phase 2) ---------------------------------------------------------

test("recipe cards keep only links and photos on the site's origin", () => {
  const good = { title: "Steamed Rice", url: "https://site.test/favourite-recipes/recipes/steamed-rice.html", image: "https://site.test/favourite-recipes/images/recipes/steamed-rice.jpg", kicker: { kind: "this", label: "This week" }, meta: "20 min · 412 kcal" };
  const out = chat.cleanCards(
    [
      good,
      { ...good, title: "Evil link", url: "https://evil.test/x" },
      { ...good, title: "Script link", url: "javascript:alert(1)" },
      { ...good, title: "Evil photo", image: "https://evil.test/p.jpg", kicker: { kind: "<script>", label: "x" } },
      { url: good.url },
    ],
    ORIGIN
  );
  assert.deepEqual(out.map((c) => c.title), ["Steamed Rice", "Evil photo"]);
  assert.equal(out[1].image, "", "a photo from elsewhere is dropped, the card stays");
  assert.equal(out[1].kicker.kind, "", "unknown kicker kinds fall back to plain");
  assert.equal(chat.cleanCards(Array.from({ length: 20 }, () => good), ORIGIN).length, 8);
});

test("navigation buttons and action chips only resolve to this site", () => {
  assert.deepEqual(chat.cleanNav({ label: "Open Steamed Rice", url: "https://site.test/favourite-recipes/recipes/steamed-rice.html" }, ORIGIN), { label: "Open Steamed Rice", url: "https://site.test/favourite-recipes/recipes/steamed-rice.html" });
  assert.equal(chat.cleanNav({ label: "x", url: "https://evil.test/" }, ORIGIN), null);
  assert.equal(chat.cleanNav({ label: "x", url: "javascript:alert(1)" }, ORIGIN), null);
  assert.deepEqual(
    chat.cleanReplyItems(["Plain", { label: "Open", url: "https://site.test/favourite-recipes/next-week.html" }, { label: "Evil", url: "https://evil.test/" }, { label: "Js", url: "javascript:1" }, 5, null], ORIGIN),
    ["Plain", { label: "Open", url: "https://site.test/favourite-recipes/next-week.html" }]
  );
});

test("stored history keeps cards, nav and action chips only when they point at this site", () => {
  const stored = {
    id: "c1",
    updated: Date.now(),
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", cards: [{ title: "A", url: "https://site.test/r/a.html", kicker: { kind: "", label: "Dinner" }, meta: "" }], nav: { label: "Go", url: "https://evil.test/" }, replies: ["ok", { label: "Open", url: "https://evil.test/" }] },
    ],
  };
  const h = chat.cleanHistory(stored, Date.now(), ORIGIN);
  assert.equal(h.messages.length, 2, "a message with only cards is kept");
  assert.equal(h.messages[1].cards.length, 1);
  assert.equal(h.messages[1].nav, undefined);
  assert.deepEqual(h.messages[1].replies, ["ok"]);
  assert.equal(chat.cleanHistory(stored, Date.now()).messages[1], undefined, "without an origin nothing but text survives");
});

test("starter chips depend on the page", () => {
  assert.deepEqual(chat.startersFor("recipe"), ["Swap an ingredient", "Scale it for 6", "What goes with it?"], "a visitor isn't invited to write");
  assert.deepEqual(chat.startersFor("recipe", true), ["Swap an ingredient", "Scale it for 6", "Add to next week"], "an editor is");
  assert.deepEqual(chat.startersFor("index"), ["Something quick tonight", "Light and healthy"]);
  assert.deepEqual(chat.startersFor("next-week"), ["What's planned?"]);
  assert.deepEqual(chat.startersFor("shopping"), ["What's left to buy?"]);
  assert.deepEqual(chat.startersFor("other"), []);
});

test("links with balanced parentheses stay whole; an unsafe one is plain text without stray characters", () => {
  assert.equal(html(render("[wiki](https://site.test/a_(b).html)")), '<div><p><a href="https://site.test/a_(b).html">wiki</a></p></div>');
  assert.equal(html(render("[js](javascript:alert(1)) done")), "<div><p>js done</p></div>");
});

test("the history sent to the server is well formed after a failed turn", () => {
  assert.deepEqual(
    chat.wellFormed([{ role: "assistant", content: "x" }, { role: "user", content: "a" }, { role: "user", content: "b" }, { role: "assistant", content: "", cards: [] }, { role: "assistant", content: "c" }, { role: "user", content: "d" }]),
    [{ role: "user", content: "a\n\nb" }, { role: "assistant", content: "c" }, { role: "user", content: "d" }]
  );
});

test("an editor's chat from the server keeps cards, buttons, turn ids and feedback, only on this site", () => {
  const list = [
    { role: "user", content: "hi" },
    { role: "system", content: "evil" },
    { role: "assistant", content: "hello", turn_id: "t1", replies: ["ok", { label: "Go", url: "https://evil.test/x" }], nav: { label: "Open", url: "https://evil.test/" }, feedback: { value: 0, reasons: ["Wrong amounts", "bogus"], note: "n" },
      cards: [{ title: "Soup", url: `${ORIGIN}/recipes/soup.html`, kicker: { kind: "this", label: "This week" }, meta: "10 min" }] },
  ];
  const out = chat.cleanServerMessages(list, ORIGIN);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].replies, ["ok"]);
  assert.equal(out[1].nav, undefined);
  assert.equal(out[1].turn_id, "t1");
  assert.deepEqual(out[1].feedback, { value: 0, reasons: ["Wrong amounts"], note: "n" });
  assert.equal(out[1].cards.length, 1);
});

test("chat list labels: updated today / yesterday / date, expiry as a weekday", () => {
  const now = new Date(2026, 10, 7, 15, 0).getTime(); // Sat 7 Nov 2026
  const at = (d, h = 9) => new Date(2026, 10, d, h).toISOString();
  assert.equal(chat.updatedLabel(at(7), now), "Today");
  assert.equal(chat.updatedLabel(at(6), now), "Yesterday");
  assert.match(chat.expiryLabel(at(14), now), /^until (Sat|Sat\.)/);
  assert.equal(chat.expiryLabel(at(8), now), "until tomorrow");
  assert.match(chat.expiryLabel(at(21), now), /until .*21/);
  assert.equal(chat.feedbackNote({ value: 1 }, false), "Thanks");
  assert.equal(chat.feedbackNote({ value: 0, reasons: ["Wrong amounts"] }, true), "Sent: Wrong amounts");
  assert.equal(chat.feedbackNote({ value: 0, reasons: [] }, true), "Sent");
  assert.equal(chat.feedbackNote({ value: 0, reasons: [] }, false), "");
});
