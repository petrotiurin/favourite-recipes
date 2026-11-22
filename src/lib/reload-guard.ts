// A page left open across a deploy (docs/typescript-migration.md 4.11). Each deploy replaces the whole site and the scripts have hashed names,
// so a page loaded before it asks for an island's script that is gone (404) when the island wakes up (scrolled into view, or idle), and the
// island stays dead. The fix is to reload once, so the page comes back with today's files.
//
// The failure shows as one of two events on `window`: Vite's `vite:preloadError` (a script's parts failed to load) and Astro's
// `astro:hydration-error` (an island's own script or the renderer failed to import: Astro imports those directly, so Vite's event doesn't
// cover them; Astro has already tried the file a second time by then). It reloads
//   - at most once per page per minute (a timestamp in sessionStorage, per path), or a file that is really missing would loop;
//   - not when sessionStorage can't be used (private mode and the like): it couldn't remember it had reloaded;
//   - not while the chat's message box holds text that hasn't been sent (`.chat-input`, templates/chat.cjs), which a reload would lose.
//
// The Layout writes this function into every page as an inline script (`reloadOnStaleScript.toString()`), so it must not use anything
// but its argument and globals: no imports, no helpers outside it.

export function reloadOnStaleScript(win: Window): void {
  const handler = () => {
    const box = win.document.querySelector<HTMLTextAreaElement>(".chat-input");
    if (box && box.value.trim() !== "") return;
    const key = `reloaded-for-stale-script:${win.location.pathname}`;
    const now = Date.now();
    try {
      if (now - (Number(win.sessionStorage.getItem(key)) || 0) < 60000) return;
      win.sessionStorage.setItem(key, String(now));
    } catch {
      return;
    }
    win.location.reload();
  };
  win.addEventListener("vite:preloadError", handler);
  win.addEventListener("astro:hydration-error", handler);
}
