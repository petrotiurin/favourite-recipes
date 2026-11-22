// The chat's safe renderer, its pure half (docs/chatbot-design.md 8; design.md "Safe rendering"): model text -> blocks of inline nodes.
// Nothing here makes HTML. src/islands/chat/RichText.tsx turns the nodes into Preact elements, so every piece of model text ends up as a
// text node; a link is only a link when it points at this site's own origin (anything else shows its label as plain text).

/** An absolute URL string if href points at `origin` over http(s), else null. */
export function safeHref(href: unknown, origin: string, base?: string): string | null {
  try {
    const url = new URL(String(href), base || `${origin}/`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

export type Inline = { t: "text"; v: string } | { t: "bold"; c: Inline[] } | { t: "link"; href: string; label: string } | { t: "br" };
export type Block = { type: "p"; nodes: Inline[] } | { type: "ul" | "ol"; items: Inline[][] };

const INLINE_SRC = "\\*\\*([^*]+?)\\*\\*|\\[([^\\]]+)\\]\\(((?:[^()\\s]|\\([^()\\s]*\\))+)\\)";

/** **bold** and [label](href); everything else is text. */
export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE_SRC, "g"); // a fresh one per call: bold content is parsed recursively
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push({ t: "text", v: text.slice(last, m.index) });
    if (m[1] !== undefined) nodes.push({ t: "bold", c: parseInline(m[1]) });
    else nodes.push({ t: "link", href: m[3], label: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ t: "text", v: text.slice(last) });
  return nodes;
}

function parseLines(lines: string[]): Inline[] {
  let out: Inline[] = [];
  lines.forEach((line, i) => {
    if (i) out.push({ t: "br" });
    out = out.concat(parseInline(line));
  });
  return out;
}

/** Paragraphs and lists. Headings become bold paragraphs, single newlines line breaks. */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: Inline[][] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", nodes: parseLines(para) });
    para = [];
  };
  String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((raw) => {
      const line = raw.replace(/\s+$/, "");
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (!line.trim()) {
        flushPara();
        list = null;
      } else if (bullet || number) {
        flushPara();
        const type = bullet ? "ul" : "ol";
        if (!list || list.type !== type) {
          list = { type, items: [] };
          blocks.push(list);
        }
        list.items.push(parseInline((bullet || number)![1]));
      } else if (heading) {
        flushPara();
        list = null;
        blocks.push({ type: "p", nodes: [{ t: "bold", c: parseInline(heading[1]) }] });
      } else {
        list = null;
        para.push(line.trim());
      }
    });
  flushPara();
  return blocks;
}
