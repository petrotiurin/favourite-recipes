(function () {
  var picker = document.querySelector(".servings-picker");
  if (!picker) return;
  var base = parseFloat(picker.getAttribute("data-base"));
  var buttons = picker.querySelectorAll("button[data-serves]");
  var qtys = document.querySelectorAll(".qty");
  var servesChip = document.querySelector(".serves-chip");
  var bar = document.querySelector(".cook-bar");
  if (!base || !buttons.length || !qtys.length) return;

  var FRACTIONS = [
    [0, ""], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"], [1, ""],
  ];

  function format(value) {
    if (value >= 10) return String(Math.round(value));
    var whole = Math.floor(value);
    var frac = value - whole;
    var best = FRACTIONS[0];
    FRACTIONS.forEach(function (f) {
      if (Math.abs(f[0] - frac) < Math.abs(best[0] - frac)) best = f;
    });
    if (best[0] === 1) return String(whole + 1);
    if (whole === 0 && best[0] === 0) return "⅛";
    return (whole ? String(whole) : "") + best[1];
  }

  qtys.forEach(function (el) {
    el.setAttribute("data-original", el.textContent);
  });

  function setServings(serves) {
    var factor = serves / base;
    qtys.forEach(function (el) {
      el.textContent = factor === 1
        ? el.getAttribute("data-original")
        : format(parseFloat(el.getAttribute("data-qty")) * factor);
    });
    buttons.forEach(function (btn) {
      btn.setAttribute("aria-pressed", String(parseFloat(btn.getAttribute("data-serves")) === serves));
    });
  }

  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setServings(parseFloat(btn.getAttribute("data-serves")));
    });
  });

  // The picker says how many it serves, so the static "Serves n" fact steps aside.
  if (servesChip) servesChip.hidden = true;
  picker.hidden = false;
  if (bar) bar.hidden = false;
})();
