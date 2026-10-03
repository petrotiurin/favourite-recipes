(function () {
  if (!("wakeLock" in navigator)) return;
  var meta = document.querySelector(".recipe-meta");
  if (!meta) return;

  var lock = null;
  var wanted = false;

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wakelock-toggle";
  btn.setAttribute("aria-pressed", "false");
  btn.textContent = "🔆 Keep screen on";
  meta.insertAdjacentElement("afterend", btn);

  function acquire() {
    navigator.wakeLock.request("screen").then(function (l) {
      lock = l;
      l.addEventListener("release", function () {
        if (lock === l) lock = null;
      });
    }).catch(function () {
      wanted = false;
      render();
    });
  }

  function render() {
    btn.setAttribute("aria-pressed", String(wanted));
    btn.textContent = wanted ? "🔆 Screen stays on" : "🔆 Keep screen on";
  }

  btn.addEventListener("click", function () {
    wanted = !wanted;
    render();
    if (wanted) {
      acquire();
    } else if (lock) {
      lock.release();
      lock = null;
    }
  });

  // The browser drops the lock when the tab is hidden; take it back on return.
  document.addEventListener("visibilitychange", function () {
    if (wanted && !lock && document.visibilityState === "visible") acquire();
  });
})();
