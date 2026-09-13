function layout({ title, bodyClass = "", content, rootPrefix = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="${rootPrefix}style.css">
</head>
<body class="${bodyClass}">
${content}
  <footer class="site-footer">Our Favourite Recipes</footer>
</body>
</html>
`;
}

module.exports = { layout };
