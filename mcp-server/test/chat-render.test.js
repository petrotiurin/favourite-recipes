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
  assert.equal(out, '<div><p>evil js) data <a href="https://site.test/favourite-recipes/recipes/a.html">rel</a> sub port</p></div>');
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
