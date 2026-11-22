// Model text drawn safely (docs/chatbot-design.md 8, design.md "Safe rendering"): the blocks and inline nodes of src/lib/chat/render.ts become
// Preact elements whose text is always a child string (a text node), never markup. A link is only a link when it points at this site's own
// origin; anything else shows its label as plain text. Nothing in the chat sets markup from a string (render.test.tsx scans the source for it).
import type { ComponentChildren } from "preact";
import { parseBlocks, parseInline, safeHref, type Inline } from "../../lib/chat/render.ts";

/** Inline nodes as elements: text, <strong>, <br>, and <a> for links on this site only. */
export function inlineNodes(nodes: Inline[], origin: string): ComponentChildren[] {
  return nodes.map((n, i) => {
    if (n.t === "text") return n.v;
    if (n.t === "br") return <br key={i} />;
    if (n.t === "bold") return <strong key={i}>{inlineNodes(n.c, origin)}</strong>;
    const href = safeHref(n.href, origin);
    return href ? <a key={i} href={href}>{n.label}</a> : n.label; // someone else's site: the label, never a link
  });
}

/** One line of model text (a tray card's ingredient or step: **bold** names), inline only. */
export function InlineText({ text, origin }: { text: string; origin: string }) {
  return <>{inlineNodes(parseInline(text), origin)}</>;
}

/** Paragraphs and lists from model text. */
export function RichText({ text, origin }: { text: string; origin: string }) {
  return (
    <>
      {parseBlocks(text).map((block, i) =>
        block.type === "p" ? (
          <p key={i}>{inlineNodes(block.nodes, origin)}</p>
        ) : block.type === "ul" ? (
          <ul key={i}>{block.items.map((item, j) => <li key={j}>{inlineNodes(item, origin)}</li>)}</ul>
        ) : (
          <ol key={i}>{block.items.map((item, j) => <li key={j}>{inlineNodes(item, origin)}</li>)}</ol>
        ),
      )}
    </>
  );
}
