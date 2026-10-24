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
  meta.appendChild(btn);

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

  var SUN =
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

  function render() {
    btn.setAttribute("aria-pressed", String(wanted));
    btn.innerHTML = SUN + (wanted ? "Screen stays on" : "Keep screen on");
  }

  render();

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
