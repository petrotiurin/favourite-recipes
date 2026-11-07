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
  <link rel="stylesheet" href="${rootPrefix}style.css">
</head>
<body class="${bodyClass}">
${content}
  <script type="application/json" id="page-context">${pageContextJson(pageContext)}</script>
  <footer class="site-footer">Our Favourite Recipes</footer>
</body>
</html>
`;
}

module.exports = { layout };
