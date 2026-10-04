// Build-time helper: wraps each scalable number in the Ingredients section in
// <span class="qty" data-qty="..."> so templates/servings.js can rescale it.
// Skipped on purpose: numbers inside the bolded ingredient name, percentages
// (e.g. "0% or full-fat", "5–9% fat"), anything after the "x" in "2 x 150g"
// (a per-item weight), and anything inside a parenthetical containing "each".

const FRACTIONS = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
const NUM = "(?:\\d+(?:\\.\\d+)?[¼½¾⅓⅔⅛]?|[¼½¾⅓⅔⅛])";
const RANGE_RE = new RegExp(`(?<![\\d.])(${NUM})(?:(\\s*[-–]\\s*)(${NUM}))?(?!\\d)(\\s*%)?`, "g");

function parseNumber(str) {
  const m = str.match(/^(\d+(?:\.\d+)?)?([¼½¾⅓⅔⅛])?$/);
  return (m[1] ? parseFloat(m[1]) : 0) + (m[2] ? FRACTIONS[m[2]] : 0);
}

function wrap(numStr) {
  return `<span class="qty" data-qty="${parseNumber(numStr)}">${numStr}</span>`;
}

function scaleText(text, state) {
  let out = "";
  let last = 0;
  const perItem = text.search(/\d\s*x\s*\d/);
  for (const m of text.matchAll(RANGE_RE)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const afterX = perItem !== -1 && m.index > perItem;
    if (m[4] || afterX || state.inEachParen(m.index)) {
      out += m[0];
      continue;
    }
    out += wrap(m[1]);
    if (m[3]) out += m[2] + wrap(m[3]);
  }
  return out + text.slice(last);
}

function scaleListItem(liHtml) {
  // Split into tags and text; only rewrite text outside <strong>.
  const parts = liHtml.split(/(<[^>]+>)/);
  const plain = parts.filter((p) => !p.startsWith("<")).join("");
  // Character ranges (in plain text) of parentheticals containing "each".
  const eachRanges = [];
  for (const m of plain.matchAll(/\([^()]*\beach\b[^()]*\)/g)) {
    eachRanges.push([m.index, m.index + m[0].length]);
  }
  let offset = 0;
  let strongDepth = 0;
  return parts
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<strong\b/i.test(part)) strongDepth++;
        else if (/^<\/strong>/i.test(part)) strongDepth--;
        return part;
      }
      const start = offset;
      offset += part.length;
      if (strongDepth > 0) return part;
      const state = {
        inEachParen: (i) => eachRanges.some(([a, b]) => start + i >= a && start + i < b),
      };
      return scaleText(part, state);
    })
    .join("");
}

// Returns { html, scalable } where scalable is true if any quantity was tagged.
function markScalableQuantities(bodyHtml) {
  const start = bodyHtml.search(/<h2[^>]*>\s*Ingredients\b[^<]*<\/h2>/i);
  if (start === -1) return { html: bodyHtml, scalable: false };
  const next = bodyHtml.indexOf("<h2", start + 1);
  const end = next === -1 ? bodyHtml.length : next;
  let scalable = false;
  const section = bodyHtml.slice(start, end).replace(/<li>([\s\S]*?)<\/li>/g, (_, inner) => {
    const scaled = scaleListItem(inner);
    if (scaled !== inner) scalable = true;
    return `<li>${scaled}</li>`;
  });
  return { html: bodyHtml.slice(0, start) + section + bodyHtml.slice(end), scalable };
}

// Tags the scalable numbers in a plain-text quantity ("100ml + 3 tbsp", "1–2 tsp") for servings.js.
// The text must already be HTML-escaped; numbers are never part of the escapes.
function markQuantityText(text) {
  return scaleText(text, { inEachParen: () => false });
}

module.exports = { markScalableQuantities, markQuantityText };
