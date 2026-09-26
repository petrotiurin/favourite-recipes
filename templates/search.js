(function () {
  var input = document.getElementById("recipe-search");
  var tiles = document.querySelectorAll(".tile-grid .tile");
  if (!input || !tiles.length) return;

  input.addEventListener("input", function () {
    var keywords = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    tiles.forEach(function (tile) {
      var title = tile.querySelector(".tile-title").textContent.toLowerCase();
      var matches = keywords.every(function (kw) {
        return title.indexOf(kw) !== -1;
      });
      tile.style.display = matches ? "" : "none";
    });
  });
})();
