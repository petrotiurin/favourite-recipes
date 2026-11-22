// The chat's safe renderer (moved from mcp-server/test/chat-render.test.js): model text becomes DOM nodes, never HTML, and only links to the
// site's own origin stay links. Plus a scan of the chat's source: nothing in it may set markup.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { render } from "preact";
import { describe, expect, it } from "vitest";
import { parseBlocks, safeHref } from "../../lib/chat/render.ts";
import { InlineText, RichText } from "./RichText.tsx";

const ORIGIN = "https://site.test";
const draw = (text: string) => {
  const root = document.createElement("div");
  render(<RichText text={text} origin={ORIGIN} />, root);
  return root;
};
const html = (text: string) => draw(text).innerHTML;
const tags = (root: Element) => {
  const out = new Set<string>();
  root.querySelectorAll("*").forEach((n) => out.add(n.tagName.toLowerCase()));
  return [...out].sort();
};

describe("RichText", () => {
  it("renders paragraphs, bold, lists and links to the site as DOM nodes", () => {
    expect(html("Try these:\n\n- **[Avocado Toast](https://site.test/favourite-recipes/recipes/avocado-toast.html)**: 10 min\n- plain\n\n1. one\n2. two\n\nDone.")).toBe(
      '<p>Try these:</p><ul><li><strong><a href="https://site.test/favourite-recipes/recipes/avocado-toast.html">Avocado Toast</a></strong>: 10 min</li><li>plain</li></ul><ol><li>one</li><li>two</li></ol><p>Done.</p>',
    );
  });

  it("links to other origins and non-http schemes are plain text", () => {
    const out = html("[evil](https://evil.test/x) [js](javascript:alert(1)) [data](data:text/html,hi) [rel](/favourite-recipes/recipes/a.html) [sub](https://site.test.evil.test/) [port](https://site.test:8080/)");
    expect(out).not.toMatch(/evil\.test\/|javascript:|data:/);
    expect(out).toBe('<p>evil js data <a href="https://site.test/favourite-recipes/recipes/a.html">rel</a> sub port</p>');
  });

  it("markup in model text stays text", () => {
    const root = draw('<img src=x onerror=alert(1)> <script>alert(1)</script> **<b>bold</b>**');
    expect(root.querySelector("img, script, b")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>"); // as text: the browser shows it literally
    expect(tags(root)).toEqual(["p", "strong"]);
    expect(root.querySelector("strong")!.textContent).toBe("<b>bold</b>");
  });

  it("headings become bold lines, single newlines become line breaks, partial markdown is left alone", () => {
    expect(html("## Title\nline one\nline two")).toBe("<p><strong>Title</strong></p><p>line one<br>line two</p>");
    expect(html("half **bold and [link](")).toBe("<p>half **bold and [link](</p>");
    expect(html("")).toBe("");
    expect(html("a\r\n\r\nb")).toBe("<p>a</p><p>b</p>");
  });

  it("links with balanced parentheses stay whole; an unsafe one is plain text without stray characters", () => {
    expect(html("[wiki](https://site.test/a_(b).html)")).toBe('<p><a href="https://site.test/a_(b).html">wiki</a></p>');
    expect(html("[js](javascript:alert(1)) done")).toBe("<p>js done</p>");
  });

  it("a list next to a paragraph, bullets of every kind, a numbered list after a bullet list", () => {
    expect(parseBlocks("* a\n• b\n1) c").map((b) => b.type)).toEqual(["ul", "ol"]);
    expect(html("intro\n- a\nafter")).toBe("<p>intro</p><ul><li>a</li></ul><p>after</p>");
  });

  it("one line of a tray card: bold names and safe links, nothing else", () => {
    const root = document.createElement("div");
    render(<InlineText text="**200 g** rice [x](https://evil.test/) <i>" origin={ORIGIN} />, root);
    expect(root.innerHTML).toBe("<strong>200 g</strong> rice x &lt;i&gt;");
  });
});

describe("safeHref", () => {
  it("only accepts the page's own origin", () => {
    expect(safeHref("https://site.test/a", ORIGIN)).toBe("https://site.test/a");
    expect(safeHref("//site.test/a", ORIGIN, "https://site.test/x")).toBe("https://site.test/a");
    expect(safeHref("//evil.test/a", ORIGIN, "https://site.test/x")).toBeNull();
    expect(safeHref("not a url", ORIGIN, "https://other.test/")).toBeNull();
    expect(safeHref("javascript:alert(1)", ORIGIN)).toBeNull();
  });
});

describe("the chat's source", () => {
  it("never sets markup: no dangerouslySetInnerHTML, innerHTML, outerHTML, insertAdjacentHTML or document.write", () => {
    const root = path.resolve(__dirname, "../..");
    const files = [
      ...readdirSync(path.join(root, "islands/chat")).map((f) => path.join(root, "islands/chat", f)),
      ...readdirSync(path.join(root, "lib/chat")).map((f) => path.join(root, "lib/chat", f)),
    ].filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    }
  });
});
