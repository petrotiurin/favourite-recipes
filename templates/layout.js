function layout({ title, bodyClass = "", content, rootPrefix = "" }) {
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
  <footer class="site-footer">Our Favourite Recipes</footer>
</body>
</html>
`;
}

module.exports = { layout };
