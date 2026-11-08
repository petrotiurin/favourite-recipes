// Embedded in every page for the chat (docs/chatbot-design.md 7.2): which page this is, so "this recipe" can be resolved.
// Data only, baked in at build time. "<" (and friends) are escaped so no value can close the script element.
function pageContextJson(context) {
  return JSON.stringify(context)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// The chat widget (docs/chatbot-design.md): only on builds that know where the chat API lives (CHAT_API_URL, a public value
// from the repo's Actions variables). Without it no bubble and no script at all.
function chatScript(rootPrefix) {
  const api = process.env.CHAT_API_URL;
  if (!api) return "";
  const attr = String(api).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `\n  <script src="${rootPrefix}chat.js" data-api="${attr}" defer></script>`;
}

// Sign-in (templates/auth.js): on every page of a build that has the Supabase values (SUPABASE_URL and SUPABASE_ANON_KEY, both
// public, from the repo's Actions variables), so the chat and the shopping page share one session. It is in the head, deferred,
// so it runs before the page scripts that use window.RecipeAuth. Without the values there is no sign-in anywhere.
function authScript(rootPrefix) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return "";
  const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `\n  <script src="${rootPrefix}auth.js" data-supabase-url="${attr(SUPABASE_URL.replace(/\/$/, ""))}" data-supabase-key="${attr(SUPABASE_ANON_KEY)}" defer></script>`;
}

function layout({ title, bodyClass = "", content, rootPrefix = "", pageContext }) {
  if (!pageContext || !pageContext.page) throw new Error(`layout: "${title}" needs a pageContext ({ page: ... })`);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=Public+Sans:wght@400;500;600&display=swap">
  <link rel="stylesheet" href="${rootPrefix}style.css">${authScript(rootPrefix)}
</head>
<body class="${bodyClass}">
${content}
  <script type="application/json" id="page-context">${pageContextJson(pageContext)}</script>
  <footer class="site-footer">Our Favourite Recipes</footer>${chatScript(rootPrefix)}
</body>
</html>
`;
}

module.exports = { layout };
